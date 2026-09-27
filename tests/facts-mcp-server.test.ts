import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

function createRpcClient(proc: ReturnType<typeof spawn>) {
  let seq = 1;
  const pending = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void }>();
  let buffer = "";

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const handler = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) handler.reject(msg.error);
          else handler.resolve(msg.result);
        }
      } catch {
        // ignore parse errors on client side
      }
    }
  });

  proc.on("error", (err) => {
    for (const [, handler] of pending) handler.reject(err);
    pending.clear();
  });

  proc.on("exit", (code) => {
    for (const [, handler] of pending) handler.reject(new Error(`Server exited prematurely with code ${code}`));
    pending.clear();
  });

  return {
    async request(method: string, params?: any): Promise<any> {
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        proc.stdin?.write(payload);
      });
    },
    notify(method: string, params?: any): void {
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      proc.stdin?.write(payload);
    },
    raw(text: string): void {
      proc.stdin?.write(text);
    },
  };
}

test("Facts MCP Server handles initialization, tool discovery, and tool execution over stdio", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-ws-"));
  const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");

  try {
    // Create a mock package.json and a source file in the workspace
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "mcp-test-fixture",
      version: "1.0.0",
      scripts: { test: "echo pass" }
    }));
    await writeFile(join(workspace, "index.ts"), `
export interface UserSession { id: string; active: boolean; }
export function authenticate(sessionId: string): UserSession {
  return { id: sessionId, active: true };
}
`);

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

    // Create a project memory compaction checkpoint
    const memory = await ProjectMemory.open(workspace, "session-test");
    const ref = await memory.saveCompaction({
      id: "entry-mcp-01",
      parentId: null,
      timestamp: "2026-09-27T18:00:00.000Z",
      summary: "Completed migration of memory storage to .agents/memory",
      firstKeptEntryId: "entry-mcp-01",
      tokensBefore: 24000,
      reason: "manual",
      willRetry: false,
    });

    // Spawn server process
    const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspace,
    });

    const client = createRpcClient(proc);

    try {
      // 1. Initialize
      const initResult = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      assert.equal(initResult.protocolVersion, "2024-11-05");
      assert.equal(initResult.serverInfo?.name, "gentle-facts-mcp");
      assert.ok(initResult.capabilities?.tools);

      client.notify("notifications/initialized");

      // 2. tools/list
      const toolsResult = await client.request("tools/list");
      assert.ok(Array.isArray(toolsResult.tools));
      const toolNames = toolsResult.tools.map((t: any) => t.name);
      assert.ok(toolNames.includes("facts_query"), "must include facts_query");
      assert.ok(toolNames.includes("facts_dependents"), "must include facts_dependents");
      assert.ok(toolNames.includes("facts_impact"), "must include facts_impact");
      assert.ok(toolNames.includes("facts_status"), "must include facts_status");
      assert.ok(toolNames.includes("memory_search"), "must include memory_search");
      assert.ok(toolNames.includes("memory_read"), "must include memory_read");
      assert.ok(toolNames.includes("context_status"), "must include context_status");

      // 3. tools/call: facts_status
      const statusCall = await client.request("tools/call", {
        name: "facts_status",
        arguments: {},
      });
      assert.ok(Array.isArray(statusCall.content));
      assert.match(statusCall.content[0].text, /package manager|indexed|ground truth/i);

      // 4. tools/call: memory_search
      const memorySearchCall = await client.request("tools/call", {
        name: "memory_search",
        arguments: { query: "migration" },
      });
      assert.ok(Array.isArray(memorySearchCall.content));
      assert.equal(memorySearchCall.isError, true);
      assert.match(memorySearchCall.content[0].text, /session_scope_required/);
      assert.doesNotMatch(memorySearchCall.content[0].text, new RegExp(ref.id));

      // 5. tools/call: memory_read
      const memoryReadCall = await client.request("tools/call", {
        name: "memory_read",
        arguments: { id: ref.id, offset_chars: 0, limit_chars: 100 },
      });
      assert.ok(Array.isArray(memoryReadCall.content));
      assert.equal(memoryReadCall.isError, true);
      assert.doesNotMatch(memoryReadCall.content[0].text, /Completed migration of memory storage/);

      // 6. tools/call: facts_query
      const queryCall = await client.request("tools/call", {
        name: "facts_query",
        arguments: { name: "authenticate" },
      });
      assert.ok(Array.isArray(queryCall.content));
      assert.match(queryCall.content[0].text, /authenticate/);
      assert.match(queryCall.content[0].text, /index\.ts/);

      // 7. tools/call: context_status
      const contextStatusCall = await client.request("tools/call", {
        name: "context_status",
        arguments: {},
      });
      assert.ok(Array.isArray(contextStatusCall.content));
      assert.match(contextStatusCall.content[0].text, /CONTEXT & MEMORY STATUS/);
      assert.match(contextStatusCall.content[0].text, /session_scope_required/);

      // 8. Unknown method returns -32601
      await assert.rejects(
        client.request("non_existent_method"),
        (err: any) => err.code === -32601,
      );

      // 9. Unknown tool call returns error in content or isError: true
      const invalidToolCall = await client.request("tools/call", {
        name: "unknown_tool",
        arguments: {},
      });
      assert.equal(invalidToolCall.isError, true);
    } finally {
      proc.kill("SIGKILL");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Facts MCP Server returns standard JSON-RPC 2.0 errors on malformed messages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-err-"));
  const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
  try {
    const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const received: any[] = [];
    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { received.push(JSON.parse(line)); } catch {}
      }
    });

    // Send malformed JSON line
    proc.stdin?.write("{ malformed json\n");

    // Send invalid request structure (missing jsonrpc)
    proc.stdin?.write(JSON.stringify({ id: 99, method: "test" }) + "\n");

    const start = Date.now();
    while (received.length < 2 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    proc.kill("SIGKILL");

    assert.equal(received.length, 2);
    assert.equal(received[0].error?.code, -32700); // Parse error
    assert.equal(received[1].error?.code, -32600); // Invalid request
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
