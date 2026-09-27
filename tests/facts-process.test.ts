import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FactsStore } from "../lib/facts/facts-store.ts";

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
    const cache = await new FactsStore(dir).load();
    assert.equal(cache.files["source.ts"].symbols[0].name, "newValue");
  } finally {
    older.kill();
    newer.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a killed Facts writer is recovered by competing processes without overlapping publication", {
  timeout: 20000,
  skip: process.platform !== "linux",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-owner-death-"));
  const owner = worker();
  const first = worker();
  const second = worker();
  try {
    await Promise.all([message(owner), message(first), message(second)]);
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, "source.ts"), "export const recovered = true;\n");
    const held = message(owner);
    owner.send({ cwd: dir, hold: true });
    assert.equal((await held).status, "publishing");
    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;
    const firstMessage = message(first);
    const secondMessage = message(second);
    first.send({ cwd: dir, hold: true });
    second.send({ cwd: dir, hold: true });
    const winner = await Promise.race([
      firstMessage.then((value) => ({ child: first, value })),
      secondMessage.then((value) => ({ child: second, value })),
    ]);
    assert.equal(winner.value.status, "publishing");
    const loser = winner.child === first ? second : first;
    const loserMessage = winner.child === first ? secondMessage : firstMessage;
    const early = await Promise.race([
      loserMessage.then(() => "overlap"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    assert.equal(early, "waiting");
    const done = message(winner.child);
    winner.child.send({ release: true });
    await done;
    assert.equal((await loserMessage).status, "done");
    const cache = await new FactsStore(dir).load();
    assert.equal(cache.files["source.ts"].symbols[0].name, "recovered");
  } finally {
    owner.kill();
    first.kill();
    second.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
