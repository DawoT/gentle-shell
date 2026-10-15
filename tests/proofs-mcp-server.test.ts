import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";

function createRpcClient(proc: ReturnType<typeof spawn>) {
  let seq = 1;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  proc.stdout?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      const handler = pending.get(message.id);
      if (!handler) continue;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(message.error.message));
      else handler.resolve(message.result);
    }
  });

  proc.on("exit", (code) => {
    for (const [, handler] of pending) handler.reject(new Error(`Server exited prematurely with code ${code}`));
    pending.clear();
  });

  return {
    request(method: string, params?: any): Promise<any> {
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
      });
    },
    notify(method: string, params?: any): void {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
    },
  };
}

async function startServer(ledgerRoot: string) {
  const binPath = join(process.cwd(), "bin", "gentle-proofs-mcp.mjs");
  const proc = spawn(process.execPath, ["--experimental-strip-types", binPath, "--ledger-root", ledgerRoot], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const client = createRpcClient(proc);
  await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "proofs-mcp-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");
  return { proc, client };
}

async function seedPassed(ledger: ProofLedger, fingerprint: string, inputsDigest: string) {
  const started = await ledger.start({
    fingerprint,
    inputsDigest,
    confidence: "hermetic_unit",
    sideEffects: "pure_validation",
    agent: "proofs-mcp-test",
  });
  return ledger.finish(started, { status: "passed" });
}

function textOf(result: any): string {
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, "text");
  assert.equal(typeof result.content[0]?.text, "string");
  return result.content[0].text;
}

test("proof MCP announces exactly proof_query, proof_status, and proof_invalidate with bounded input schemas", async () => {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "proofs-mcp-ledger-"));
  const { proc, client } = await startServer(ledgerRoot);
  try {
    const listed = await client.request("tools/list");
    assert.deepEqual(listed.tools, [
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
    ]);
  } finally {
    proc.kill();
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});

test("proof_query lists bounded recent proof rows with status, age, confidence, and invalidation reason without commands or secrets", async () => {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "proofs-mcp-ledger-"));
  const ledger = new ProofLedger(ledgerRoot);
  const oldest = "a".repeat(64);
  const invalidated = "b".repeat(64);
  const newest = "c".repeat(64);
  await seedPassed(ledger, oldest, "1".repeat(64));
  await new Promise((resolve) => setTimeout(resolve, 2));
  await seedPassed(ledger, invalidated, "2".repeat(64));
  await ledger.transition(invalidated, "invalidated", "dependency digest changed");
  await new Promise((resolve) => setTimeout(resolve, 2));
  await seedPassed(ledger, newest, "3".repeat(64));

  const { proc, client } = await startServer(ledgerRoot);
  try {
    const result = await client.request("tools/call", { name: "proof_query", arguments: { limit: 2 } });
    const text = textOf(result);
    assert.match(text, new RegExp(newest.slice(0, 12)));
    assert.match(text, new RegExp(invalidated.slice(0, 12)));
    assert.doesNotMatch(text, new RegExp(oldest.slice(0, 12)));
    assert.match(text, /status: passed/);
    assert.match(text, /status: invalidated/);
    assert.match(text, /age: [0-9]+(?:ms|s|m|h|d)/);
    assert.match(text, /confidence: hermetic_unit/);
    assert.match(text, /invalidationReason: dependency digest changed/);
    assert.doesNotMatch(text, new RegExp(newest));
    assert.doesNotMatch(text, /pnpm|API_TOKEN|SECRET|command:/i);
  } finally {
    proc.kill();
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});

test("proof_status explains a known proof completely and fails explicitly for an unknown fingerprint", async () => {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "proofs-mcp-ledger-"));
  const ledger = new ProofLedger(ledgerRoot);
  const fingerprint = "d".repeat(64);
  const inputsDigest = "4".repeat(64);
  await seedPassed(ledger, fingerprint, inputsDigest);
  await ledger.transition(fingerprint, "invalidated", "exact invalidation reason");

  const { proc, client } = await startServer(ledgerRoot);
  try {
    const result = await client.request("tools/call", { name: "proof_status", arguments: { fingerprint } });
    const text = textOf(result);
    assert.match(text, new RegExp(`fingerprint: ${fingerprint}`));
    assert.match(text, /status: invalidated/);
    assert.match(text, /age: [0-9]+(?:ms|s|m|h|d)/);
    assert.match(text, /confidence: hermetic_unit/);
    assert.match(text, /sideEffects: pure_validation/);
    assert.match(text, new RegExp(`inputsDigest: ${inputsDigest}`));
    assert.match(text, /invalidationReason: exact invalidation reason/);
    assert.match(text, /allowed transitions:/i);
    assert.match(text, /re-verification.*inputsDigest/i);
    await assert.rejects(
      client.request("tools/call", { name: "proof_status", arguments: { fingerprint: "e".repeat(64) } }),
      /Unknown proof fingerprint/,
    );
  } finally {
    proc.kill();
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});

test("proof_invalidate transitions passed to invalidated and rejects unknown fingerprints or empty reasons", async () => {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "proofs-mcp-ledger-"));
  const ledger = new ProofLedger(ledgerRoot);
  const fingerprint = "f".repeat(64);
  await seedPassed(ledger, fingerprint, "5".repeat(64));

  const { proc, client } = await startServer(ledgerRoot);
  try {
    const invalidated = await client.request("tools/call", {
      name: "proof_invalidate",
      arguments: { fingerprint, reason: "operator revoked proof" },
    });
    assert.match(textOf(invalidated), /status: invalidated/);
    assert.match(textOf(invalidated), /invalidationReason: operator revoked proof/);

    const status = await client.request("tools/call", { name: "proof_status", arguments: { fingerprint } });
    const statusText = textOf(status);
    assert.match(statusText, /status: invalidated/);
    assert.match(statusText, /invalidationReason: operator revoked proof/);

    await assert.rejects(
      client.request("tools/call", {
        name: "proof_invalidate",
        arguments: { fingerprint: "0".repeat(64), reason: "not present" },
      }),
      /Unknown proof fingerprint/,
    );
    await assert.rejects(
      client.request("tools/call", { name: "proof_invalidate", arguments: { fingerprint, reason: "" } }),
      /reason.*non-empty/i,
    );

    const unchanged = await ledger.current(fingerprint);
    assert.equal(unchanged?.status, "invalidated");
    assert.equal(unchanged?.invalidationReason, "operator revoked proof");
  } finally {
    proc.kill();
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});

test("proof_status resolves unambiguous fingerprint prefixes from proof_query output", async () => {
  const ledgerRoot = await mkdtemp(join(tmpdir(), "proofs-mcp-ledger-"));
  const ledger = new ProofLedger(ledgerRoot);
  const fingerprint = "a".repeat(60) + "b1c2";
  await seedPassed(ledger, fingerprint, "d".repeat(64));
  const { proc, client } = await startServer(ledgerRoot);
  try {
    const queried = await client.request("tools/call", { name: "proof_query", arguments: { limit: 10 } });
    const row = textOf(queried).split("\n").find((line) => line.includes(fingerprint.slice(0, 12)));
    assert.ok(row, "proof_query must list the seeded proof");
    assert.ok(row.includes(fingerprint.slice(0, 12)), "query rows truncate the fingerprint");

    const status = await client.request("tools/call", { name: "proof_status", arguments: { fingerprint: fingerprint.slice(0, 16) } });
    assert.match(textOf(status), new RegExp(fingerprint));
    assert.match(textOf(status), /status: passed/);
  } finally {
    proc.kill();
    await rm(ledgerRoot, { recursive: true, force: true });
  }
});
