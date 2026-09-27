import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { FactsService } from "./facts-service.ts";
import { indexFactsCommit } from "./facts-commit.ts";
import { analyzeFactsImpact } from "./facts-impact.ts";

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

export const FACTS_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "facts_query",
    description: "Search declarations and signatures by exact symbol name or file path within this workspace.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Repository-relative file path" },
        name: { type: "string", description: "Exact declaration symbol name" },
        kind: { type: "string", description: "Optional symbol kind filter" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "facts_dependents",
    description: "Find files and modules that import or depend on a target file or symbol.",
    inputSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", description: "Symbol name or repository-relative file path" },
        transitive: { type: "boolean", default: false, description: "Whether to include indirect dependents" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "facts_impact",
    description: "Analyze the syntactic impact and potential file consumers between two Git revisions.",
    inputSchema: {
      type: "object",
      required: ["base", "candidate"],
      properties: {
        base: { type: "string", description: "Base Git commit revision" },
        candidate: { type: "string", description: "Candidate Git commit revision" },
        transitive: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "facts_status",
    description: "Inspect workspace index health, indexed file counts, symbol totals, and test/build commands.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "memory_search",
    description: "Session memory search requires an authorized session/branch binding; unavailable in this standalone transport.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", default: "" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "memory_read",
    description: "Session memory read requires an authorized session/branch binding; unavailable in this standalone transport.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string", description: "64-character SHA-256 hexadecimal memory ID" },
        offset_chars: { type: "integer", minimum: 0, default: 0 },
        limit_chars: { type: "integer", minimum: 1, maximum: 12000, default: 2000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "context_status",
    description: "Report Facts index availability and explicit limits of session memory and context telemetry in this transport.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export class FactsMcpServer {
  private readonly workspaceRoot: string;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly factsService: FactsService;
  private readonly inFlight = new Map<string | number, AbortController>();

  constructor(workspaceRoot: string, input: Readable, output: Writable) {
    this.workspaceRoot = workspaceRoot;
    this.input = input;
    this.output = output;
    this.factsService = new FactsService(workspaceRoot);
  }

  start(): void {
    const rl = createInterface({
      input: this.input,
      crlfDelay: Infinity,
      terminal: false,
    });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      this.handleRawMessage(trimmed);
    });
  }

  private send(message: Record<string, unknown>): void {
    this.output.write(JSON.stringify(message) + "\n");
  }

  private sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  private sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(null, -32700, "Parse error");
      return;
    }

    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      this.sendError(msg?.id ?? null, -32600, "Invalid Request");
      return;
    }

    const { id, method, params } = msg;

    // Handle notifications (no id)
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const requestId = params?.requestId;
        if (requestId !== undefined && this.inFlight.has(requestId)) {
          this.inFlight.get(requestId)!.abort();
          this.inFlight.delete(requestId);
        }
      }
      return;
    }

    const abortController = new AbortController();
    this.inFlight.set(id, abortController);

    try {
      switch (method) {
        case "initialize": {
          this.sendResult(id, {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "gentle-facts-mcp",
              version: "1.0.0",
            },
          });
          break;
        }

        case "tools/list": {
          this.sendResult(id, {
            tools: FACTS_MCP_TOOLS,
          });
          break;
        }

        case "tools/call": {
          const result = await this.handleToolCall(params?.name, params?.arguments ?? {}, abortController.signal);
          this.sendResult(id, result);
          break;
        }

        default: {
          this.sendError(id, -32601, `Method not found: ${method}`);
          break;
        }
      }
    } catch (err: any) {
      if (abortController.signal.aborted) {
        this.sendError(id, -32000, "Request cancelled");
      } else {
        this.sendError(id, -32603, err?.message ?? "Internal error");
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async handleToolCall(
    name: string,
    args: Record<string, any>,
    signal: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    try {
      signal.throwIfAborted();
      switch (name) {
        case "facts_status": {
          await this.factsService.sync(signal);
          signal.throwIfAborted();
          const block = this.factsService.getSummaryPromptBlock();
          const edges = this.factsService.getResolutionEdges();
          const resolved = edges.filter((e) => e.evidence === "typescript").length;
          const unresolved = edges.filter((e) => e.evidence === "unresolved").length;
          const text = `${block}\n- Module resolution: ${resolved} resolved, ${unresolved} unresolved.`;
          return { content: [{ type: "text", text }] };
        }

        case "facts_query": {
          await this.factsService.sync(signal);
          signal.throwIfAborted();
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 20;
          const symbols = this.factsService.querySymbols({
            file: args.file,
            name: args.name,
          });
          const paged = symbols.slice(offset, offset + limit);
          if (!paged || paged.length === 0) {
            return { content: [{ type: "text", text: "No matching declarations found." }] };
          }
          const lines = paged.map(
            (s) => `• [${s.symbol.kind}] ${s.symbol.name} (${s.file}:${s.symbol.startLine}-${s.symbol.endLine})${s.symbol.signature ? `\n    ${s.symbol.signature}` : ""}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        case "facts_dependents": {
          if (!args.target) throw new Error("Missing required argument: target");
          await this.factsService.sync(signal);
          signal.throwIfAborted();
          const dependents = this.factsService.queryDependencyEvidence(args.target, { transitive: args.transitive });
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 20;
          const paged = dependents.slice(offset, offset + limit);
          if (paged.length === 0) {
            return { content: [{ type: "text", text: `No dependents found for '${args.target}'.` }] };
          }
          const lines = paged.map(
            (d) => `• ${d.file} [depth ${d.depth}; via ${d.via}; evidence: ${d.evidence}]`
          );
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        case "facts_impact": {
          if (!args.base || !args.candidate) throw new Error("Missing required arguments: base, candidate");
          const base = await indexFactsCommit(this.workspaceRoot, args.base, signal);
          const candidate = await indexFactsCommit(this.workspaceRoot, args.candidate, signal);
          signal.throwIfAborted();
          const impact = analyzeFactsImpact(base.database, candidate.database, { transitive: args.transitive ?? true });
          const rows = [
            `Facts Impact: ${args.base} -> ${args.candidate}`,
            `Changed Sources: ${impact.changedSources.length}`,
            ...impact.consumers.slice(0, 50).map((c) => `• ${c.file} [depth ${c.depth}; via ${c.via}]`),
          ];
          return { content: [{ type: "text", text: rows.join("\n") }] };
        }

        case "memory_search":
        case "memory_read":
          return {
            isError: true,
            content: [{
              type: "text",
              text: "session_scope_required: this standalone MCP transport has no authorized session/branch binding. Use the session-bound Pi memory tools.",
            }],
          };

        case "context_status": {
          const block = this.factsService.getSummaryPromptBlock();
          const text = [
            `[CONTEXT & MEMORY STATUS]`,
            `- Workspace: ${this.workspaceRoot}`,
            "- Memory: unavailable (session_scope_required)",
            "- Request token usage: unavailable in this standalone Facts transport",
            `- Facts Index: ${block ? "available" : "idle"}`,
          ].join("\n");
          return { content: [{ type: "text", text }] };
        }

        default:
          return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
      }
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool error [${name}]: ${err?.message ?? String(err)}` }],
      };
    }
  }
}
