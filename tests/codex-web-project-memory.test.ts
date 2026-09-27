import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, symlink, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

test("ProjectMemory writes to <workspaceRoot>/.agents/memory/ and verifies SHA-256 digests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-ws-"));
  try {
    const memory = await ProjectMemory.open(workspace, "session-alpha");
    const ref = await memory.saveCompaction({
      id: "entry-001",
      parentId: null,
      timestamp: "2026-09-27T18:00:00.000Z",
      summary: "Refactored token budget and unified telemetry trace sink",
      firstKeptEntryId: "entry-001",
      tokensBefore: 42000,
      reason: "threshold",
      willRetry: false,
    });

    assert.equal(typeof ref.id, "string");
    assert.match(ref.id, /^[a-f0-9]{64}$/);
    assert.equal(ref.kind, "compaction");
    assert.equal(ref.source_entry_id, "entry-001");

    // Verify storage directory is strictly <workspace>/.agents/memory
    const memoryDir = join(workspace, ".agents", "memory");
    const dirStat = await stat(memoryDir);
    assert.equal(dirStat.isDirectory(), true);

    // Read by digest
    const read = await memory.read(ref.id, 0, 50);
    assert.ok(read);
    assert.equal(read.digest_verified, true);
    assert.equal(read.text, "Refactored token budget and unified telemetry trac");
    assert.equal(read.offset_chars, 0);
    assert.equal(read.next_offset_chars, 50);

    // Read remaining
    const readRest = await memory.read(ref.id, 50, 100);
    assert.ok(readRest);
    assert.equal(readRest.text, "e sink");
    assert.equal(readRest.next_offset_chars, null);

    // Search
    const search = await memory.search("telemetry", 0, 10);
    assert.equal(search.total, 1);
    assert.equal(search.results[0].id, ref.id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectMemory isolates concurrent sessions within the same project workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-ws-concurrent-"));
  try {
    const sessionA = await ProjectMemory.open(workspace, "session-a");
    const sessionB = await ProjectMemory.open(workspace, "session-b");

    await Promise.all([
      sessionA.saveCompaction({
        id: "entry-a",
        parentId: null,
        timestamp: "2026-09-27T18:10:00.000Z",
        summary: "Architecture decision: stdio JSON-RPC 2.0 without npm dependencies",
        firstKeptEntryId: "entry-a",
        tokensBefore: 30000,
        reason: "manual",
        willRetry: false,
      }),
      sessionB.saveCompaction({
        id: "entry-b",
        parentId: null,
        timestamp: "2026-09-27T18:11:00.000Z",
        summary: "Zero-deps MCP server handles facts_query and memory_search",
        firstKeptEntryId: "entry-b",
        tokensBefore: 35000,
        reason: "threshold",
        willRetry: false,
      }),
    ]);

    const results = await sessionA.search("", 0, 10);
    assert.equal(results.total, 2);
    // Ordered by observed_at descending
    assert.equal(results.results[0].source_entry_id, "entry-b");
    assert.equal(results.results[1].source_entry_id, "entry-a");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ProjectMemory enforces strict containment against writableRoots and escapes", async () => {
  const allowedWorkspace = await mkdtemp(join(tmpdir(), "memory-ws-allowed-"));
  const outsideWorkspace = await mkdtemp(join(tmpdir(), "memory-ws-outside-"));
  try {
    // Should succeed within writableRoots
    const allowed = await ProjectMemory.open(allowedWorkspace, "session-safe", {
      writableRoots: [allowedWorkspace],
    });
    assert.ok(allowed);

    // Should reject if workspace is outside writableRoots
    await assert.rejects(
      ProjectMemory.open(outsideWorkspace, "session-bad", {
        writableRoots: [allowedWorkspace],
      }),
      /outside authorized writable roots/i,
    );
  } finally {
    await rm(allowedWorkspace, { recursive: true, force: true });
    await rm(outsideWorkspace, { recursive: true, force: true });
  }
});

test("ProjectMemory rejects symlink escape attempts on .agents or memory directories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-ws-symlink-"));
  const escapeTarget = await mkdtemp(join(tmpdir(), "memory-escape-target-"));
  try {
    const agentsDir = join(workspace, ".agents");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(agentsDir, { recursive: true });
    // Point memory to escapeTarget via symlink
    await symlink(escapeTarget, join(agentsDir, "memory"));

    const memory = await ProjectMemory.open(workspace, "session-symlink", {
      writableRoots: [workspace],
    });

    await assert.rejects(
      memory.saveCompaction({
        id: "entry-symlink",
        parentId: null,
        timestamp: "2026-09-27T18:20:00.000Z",
        summary: "Compaction attempt with escaped symlink",
        firstKeptEntryId: "entry-symlink",
        tokensBefore: 10000,
        reason: "manual",
        willRetry: false,
      }),
      /symlink|escaped|outside/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(escapeTarget, { recursive: true, force: true });
  }
});

test("ProjectMemory tolerates torn lines and corrupt JSON entries safely", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "memory-ws-corrupt-"));
  try {
    const memory = await ProjectMemory.open(workspace, "session-corrupt");
    const ref = await memory.saveCompaction({
      id: "entry-good",
      parentId: null,
      timestamp: "2026-09-27T18:30:00.000Z",
      summary: "Legitimate evidence that must be preserved",
      firstKeptEntryId: "entry-good",
      tokensBefore: 15000,
      reason: "manual",
      willRetry: false,
    });

    const memoryDir = join(workspace, ".agents", "memory");
    const files = await (await import("node:fs/promises")).readdir(memoryDir);
    const sessionFile = join(memoryDir, files[0]);

    // Append corrupted and tampered entries
    await appendFile(sessionFile, '{"torn": true\n{"id":"fake","summary":"injected"}\n', "utf8");

    // Search should still find the valid entry and ignore corrupt lines
    const search = await memory.search("evidence", 0, 10);
    assert.equal(search.total, 1);
    assert.equal(search.results[0].id, ref.id);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
