import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

test("operator-pinned MCP memory reads only verified entries on the selected Pi branch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "facts-bound-memory-"));
  const sessionFile = join(workspace, "session.jsonl");
  const sessionId = "session-bound-a";
  const header = { type: "session", version: 3, id: sessionId, cwd: workspace };
  const entries = [
    { type: "compaction", id: "ancestor", parentId: null },
    { type: "message", id: "selected", parentId: "ancestor" },
    { type: "compaction", id: "sibling", parentId: "ancestor" },
  ];
  const transcript = [header, ...entries].map(value => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(sessionFile, transcript);
  const memory = await ProjectMemory.open(workspace, sessionId);
  const save = (id: string, summary: string) => memory.saveCompaction({
    id,
    parentId: id === "ancestor" ? null : "ancestor",
    timestamp: "2026-09-27T12:00:00.000Z",
    summary,
    firstKeptEntryId: "selected",
    tokensBefore: 100,
    reason: "manual",
    willRetry: false,
  });
  const visible = await save("ancestor", "Verified source in selected branch");
  const hidden = await save("sibling", "Secret from abandoned branch");
  const proc = spawn(process.execPath, [
    join(process.cwd(), "bin", "gentle-facts-mcp.mjs"),
    "--workspace", workspace,
    "--session-file", sessionFile,
    "--leaf-id", "selected",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let stderr = "";
  proc.stderr!.on("data", chunk => { stderr += String(chunk); });
  proc.once("exit", code => {
    for (const handler of pending.values()) handler.reject(new Error(`Facts MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  proc.stdout!.setEncoding("utf8");
  proc.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message.result);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const listed = await request("tools/list");
    assert.ok(listed.tools.some((tool: any) => tool.name === "memory_search"));
    const search = await request("tools/call", { name: "memory_search", arguments: { query: "branch" } });
    assert.match(JSON.stringify(search), new RegExp(visible.id));
    assert.doesNotMatch(JSON.stringify(search), new RegExp(hidden.id));
    const read = await request("tools/call", { name: "memory_read", arguments: { id: visible.id } });
    assert.match(JSON.stringify(read), /Verified source in selected branch/);
    const denied = await request("tools/call", { name: "memory_read", arguments: { id: hidden.id } });
    assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /Secret from abandoned/);
    await writeFile(sessionFile, [header, entries[0], entries[2]].map(value => JSON.stringify(value)).join("\n") + "\n");
    const stale = await request("tools/call", { name: "memory_read", arguments: { id: visible.id } });
    assert.equal(stale.isError, true);
    assert.doesNotMatch(JSON.stringify(stale), /Verified source in selected branch/);
  } finally {
    proc.kill("SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  }
});
