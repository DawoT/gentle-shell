import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function message(child: ChildProcess): Promise<{ status: string; message?: string }> {
  const [value] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  assert.notEqual(value.status, "error", value.message);
  return value;
}

function worker() {
  return fork(new URL("./support/facts-sync-worker.mjs", import.meta.url), [], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

test("separate Node processes serialize Facts publication", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-process-"));
  const older = worker();
  const newer = worker();
  try {
    await Promise.all([message(older), message(newer)]);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "source.ts"), "export const oldValue = 1;\n");
    const held = message(older);
    older.send({ cwd: dir, hold: true });
    assert.equal((await held).status, "publishing");
    await writeFile(join(dir, "source.ts"), "export const newValue = 2;\n");
    const done = message(newer);
    newer.send({ cwd: dir, hold: false });
    const early = await Promise.race([
      done.then(() => "published"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 150)),
    ]);
    const oldDone = message(older);
    older.send({ release: true });
    await Promise.all([oldDone, done]);
    assert.equal(early, "waiting");
    const cache = JSON.parse(await readFile(join(dir, ".pi", "facts.json"), "utf8"));
    assert.equal(cache.files["source.ts"].symbols[0].name, "newValue");
  } finally {
    older.kill();
    newer.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
