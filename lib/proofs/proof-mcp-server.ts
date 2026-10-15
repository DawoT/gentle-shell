import { createInterface } from "node:readline";
import { ProofLedger, type ProofRecord, type ProofStatus } from "./proof-ledger.ts";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export const PROOF_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "proof_query",
    description: "List recent execution proofs without exposing commands or secrets.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: "proof_status",
    description: "Explain the current status and validity of one execution proof.",
    inputSchema: {
      type: "object",
      properties: { fingerprint: { type: "string", pattern: "^[a-f0-9]{12,64}$", description: "Full fingerprint or an unambiguous prefix (as printed by proof_query)" } },
      required: ["fingerprint"],
      additionalProperties: false,
    },
  },
  {
    name: "proof_invalidate",
    description: "Invalidate one execution proof with a required reason.",
    inputSchema: {
      type: "object",
      properties: {
        fingerprint: { type: "string", pattern: "^[a-f0-9]{64}$" },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["fingerprint", "reason"],
      additionalProperties: false,
    },
  },
];

const FINGERPRINT = /^[a-f0-9]{64}$/;
const TRANSITIONS: Record<ProofStatus, ProofStatus[]> = {
  running: ["passed", "failed", "aborted"],
  passed: ["stale", "expired", "invalidated"],
  failed: ["stale", "invalidated"],
  stale: [],
  expired: [],
  invalidated: [],
  aborted: [],
};

function formatAge(record: ProofRecord): string {
  const milliseconds = Math.max(0, Date.now() - (record.finishedAt ?? record.startedAt));
  if (milliseconds < 1000) return `${milliseconds}ms`;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function statusText(record: ProofRecord): string {
  const transitions = TRANSITIONS[record.status].join(", ") || "none";
  const lines = [
    `fingerprint: ${record.fingerprint}`,
    `status: ${record.status}`,
    `age: ${formatAge(record)}`,
    `confidence: ${record.confidence}`,
    `sideEffects: ${record.sideEffects}`,
    `inputsDigest: ${record.inputsDigest}`,
  ];
  if (record.status === "passed") {
    lines.push("validity: reusable while inputsDigest matches the current verification inputs; any lifecycle transition or covered-input change ends reuse.");
  } else {
    lines.push(`validity: not reusable (${record.status}).`);
  }
  if (record.invalidationReason !== undefined) lines.push(`invalidationReason: ${record.invalidationReason}`);
  lines.push(`allowed transitions: ${transitions}`);
  lines.push(`re-verification: recompute the verification inputs and compare inputsDigest ${record.inputsDigest}; raw commands are not stored.`);
  return lines.join("\n");
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) throw new Error("Invalid proof fingerprint");
  return value;
}

/** Resolves a full fingerprint or an unambiguous prefix (as printed by proof_query). */
async function resolveFingerprint(ledger: ProofLedger, value: unknown): Promise<string> {
  if (typeof value !== "string") throw new Error("Invalid proof fingerprint");
  const query = value.trim().toLowerCase();
  if (FINGERPRINT.test(query)) return query;
  if (!/^[a-f0-9]{12,63}$/.test(query)) throw new Error("Invalid proof fingerprint; provide a full fingerprint or an unambiguous prefix");
  const matches = (await ledger.list(200)).filter((candidate) => candidate.fingerprint.startsWith(query));
  if (matches.length === 1) return matches[0]!.fingerprint;
  if (matches.length === 0) throw new Error(`Unknown proof fingerprint: ${query}`);
  throw new Error(`Ambiguous proof fingerprint prefix (${matches.length} matches); provide more characters`);
}

export function createProofMcpServer({ ledgerRoot }: { ledgerRoot: string }) {
  const ledger = new ProofLedger(ledgerRoot);

  async function handleToolCall(name: unknown, args: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};

    if (name === "proof_query") {
      const rawLimit = input.limit ?? 20;
      if (!Number.isInteger(rawLimit) || (rawLimit as number) < 1 || (rawLimit as number) > 200) throw new Error("limit must be an integer between 1 and 200");
      const records = await ledger.list(rawLimit as number);
      const text = records.length === 0
        ? "No proofs found."
        : records.map((record) => {
            const fields = [
              `fingerprint: ${record.fingerprint.slice(0, 12)}`,
              `status: ${record.status}`,
              `age: ${formatAge(record)}`,
              `confidence: ${record.confidence}`,
            ];
            if (record.invalidationReason !== undefined) fields.push(`invalidationReason: ${record.invalidationReason}`);
            return `- ${fields.join(" | ")}`;
          }).join("\n");
      return { content: [{ type: "text", text }] };
    }

    if (name === "proof_status") {
      const fingerprint = await resolveFingerprint(ledger, input.fingerprint);
      const record = await ledger.current(fingerprint);
      if (!record) throw new Error(`Unknown proof fingerprint: ${fingerprint}`);
      return { content: [{ type: "text", text: statusText(record) }] };
    }

    if (name === "proof_invalidate") {
      const fingerprint = requireFingerprint(input.fingerprint);
      if (typeof input.reason !== "string" || input.reason.trim().length === 0) throw new Error("reason must be non-empty");
      if (input.reason.length > 500) throw new Error("reason must be at most 500 characters");
      const current = await ledger.current(fingerprint);
      if (!current) throw new Error(`Unknown proof fingerprint: ${fingerprint}`);
      const invalidated = await ledger.transition(fingerprint, "invalidated", input.reason);
      return { content: [{ type: "text", text: statusText(invalidated) }] };
    }

    throw new Error(`Unknown tool: ${String(name)}`);
  }

  return {
    start(): void {
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
      lines.on("line", async (line) => {
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          return;
        }
        if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
        if (message.id === undefined) return;
        try {
          if (message.method === "initialize") {
            send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "gentle-proofs-mcp", version: "1.0.0" } } });
          } else if (message.method === "tools/list") {
            send({ jsonrpc: "2.0", id: message.id, result: { tools: PROOF_MCP_TOOLS } });
          } else if (message.method === "tools/call") {
            const result = await handleToolCall(message.params?.name, message.params?.arguments);
            send({ jsonrpc: "2.0", id: message.id, result });
          } else {
            send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
          }
        } catch (error) {
          send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      });
    },
  };
}
