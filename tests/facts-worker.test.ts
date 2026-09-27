import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveModulesInWorker } from "../lib/facts/facts-worker.ts";

const facts = (path: string, imports: string[] = []) => ({ path, sha: "test", symbols: [], imports, exports: [] });

test("module resolution worker resolves imports and recovers after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "facts-resolution-worker-"));
  try {
    await writeFile(join(root, "main.ts"), "");
    await writeFile(join(root, "util.ts"), "");
    const input = { "main.ts": facts("main.ts", ["./util"]), "util.ts": facts("util.ts") };
    const resolved = await resolveModulesInWorker(root, input);
    assert.equal(resolved[0].target, "util.ts");
    const large = { "main.ts": facts("main.ts", Array.from({ length: 10000 }, (_, i) => `missing-${i}`)) };
    const controller = new AbortController();
    const pending = resolveModulesInWorker(root, large, controller.signal);
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await assert.rejects(pending, { name: "AbortError" });
    } finally {
      clearTimeout(timer);
    }
    assert.equal((await resolveModulesInWorker(root, input))[0].target, "util.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active Facts cancellation waits for worker termination before rejecting", async (t) => {
  const { Worker } = await import("node:worker_threads");
  const { extractTypeScriptInWorker } = await import("../lib/facts/facts-worker.ts");
  await extractTypeScriptInWorker("warm.ts", "export const warm = 1;", "warm");
  const terminate = Worker.prototype.terminate;
  let entered!: () => void;
  const terminating = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(Worker.prototype, "terminate", async function () {
    entered();
    const code = await terminate.call(this);
    await gate;
    return code;
  });
  const controller = new AbortController();
  const source = Array.from({ length: 18000 }, (_, index) => `export interface T${index} { value: string; }`).join("\n");
  const pending = extractTypeScriptInWorker("dense.ts", source, "dense", controller.signal);
  let settled = false;
  const checked = assert.rejects(pending, { name: "AbortError" }).then(() => {
    settled = true;
  });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await terminating;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "callers must retain resources until worker termination finishes");
  } finally {
    release();
    clearTimeout(timer);
    await checked;
    t.mock.restoreAll();
  }
});
