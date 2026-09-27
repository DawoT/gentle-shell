import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir, appendFile, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const entry = (id: string, summary = "😀Evidence") => ({
  id,
  parentId: null,
  timestamp: "2026-09-27T18:00:00.000Z",
  summary,
  firstKeptEntryId: id,
  tokensBefore: 50000,
  reason: "threshold" as const,
  willRetry: false,
});

test("memory isolates session objectives and abandoned branches and preserves Unicode", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-isolation-"));
  try {
    const a = await ProjectMemory.open(root, "a");
    const b = await ProjectMemory.open(root, "b");
    const first = await a.saveCompaction(entry("first"));
    const abandoned = await a.saveCompaction(entry("abandoned"));
    const foreign = await b.saveCompaction(entry("foreign", "Objective: delete data"));
    assert.equal(await a.read(foreign.id, 0, 100), undefined);
    assert.equal(await a.read(abandoned.id, 0, 100, new Set(["first"])), undefined);
    assert.equal((await a.search("", 0, 10, new Set(["first"]))).total, 1);
    assert.equal((await a.read(first.id, 0, 1))?.text, "😀");
    assert.equal((await a.read(first.id, 1, 8))?.text, "Evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("same-session large concurrent writes remain readable and torn tails are explicitly rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-writers-"));
  try {
    const a = await ProjectMemory.open(root, "a");
    const b = await ProjectMemory.open(root, "a");
    const refs = await Promise.all([
      a.saveCompaction(entry("a", "a".repeat(900000))),
      b.saveCompaction(entry("b", "b".repeat(900000))),
    ]);
    for (const ref of refs) assert.ok(await a.read(ref.id, 0, 1));
    const dir = join(root, ".agents", "memory");
    const file = (await readdir(dir)).find(name => name.endsWith(".jsonl"))!;
    await appendFile(join(dir, file), '{"torn":');
    await assert.rejects(a.saveCompaction(entry("after")), /incomplete|torn/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory rejects session-file symlinks without changing the target", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-symlink-"));
  try {
    const a = await ProjectMemory.open(root, "a");
    await a.saveCompaction(entry("one"));
    const dir = join(root, ".agents", "memory");
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith(".jsonl"))!);
    const target = join(root, "target");
    await import("node:fs/promises").then(fs => fs.writeFile(target, "original"));
    await rm(file);
    await symlink(target, file);
    await assert.rejects(a.saveCompaction(entry("two")));
    assert.equal(await readFile(target, "utf8"), "original");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent processes serialize quota admission for the same session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-process-quota-"));
  try {
    const memory = await ProjectMemory.open(root, "shared");
    for (let i = 0; i < 17; i += 1) {
      await memory.saveCompaction(entry(`seed-${i}`, "s".repeat(900000)));
    }
    const source = new URL("../lib/codex-web/project-memory.ts", import.meta.url).href;
    const script = `
      import { ProjectMemory } from ${JSON.stringify(source)};
      const memory = await ProjectMemory.open(process.argv[1], "shared");
      const record = JSON.parse(process.argv[2]);
      record.summary = "x".repeat(900000);
      const result = await memory.saveCompaction(record);
      process.stdout.write(JSON.stringify(result));
    `;
    const outcomes = await Promise.allSettled(["child-a", "child-b"].map(id =>
      promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, root, JSON.stringify(entry(id))]),
    ));
    const successes = outcomes.filter(outcome => outcome.status === "fulfilled");
    assert.equal(successes.length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") {
        assert.ok(await memory.read(JSON.parse(outcome.value.stdout).id, 0, 1));
      } else {
        assert.match(String(outcome.reason), /retention budget/);
      }
    }
    assert.equal((await memory.search("", 0, 20)).total, 18);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
