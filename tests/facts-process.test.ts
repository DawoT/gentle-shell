import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FactsStore } from "../lib/facts/facts-store.ts";

function commitFixture(directory: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  git("config", "user.name", "Facts Test");
  git("config", "user.email", "facts@example.invalid");
  return git;
}

function commitWorker() {
  return fork(new URL("./support/facts-commit-worker.mjs", import.meta.url), [], {
    execArgv: ["--experimental-strip-types"],
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
}

interface WorkerMessage {
  status: string;
  message?: string;
  name?: string;
  commit?: string;
  generation?: string;
}

async function message(child: ChildProcess): Promise<WorkerMessage> {
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

test("concurrent commit-indexing processes wait on the writer lock and both publish serially", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-commit-lock-"));
  const first = commitWorker();
  const second = commitWorker();
  try {
    await Promise.all([message(first), message(second)]);
    const git = commitFixture(dir);
    await writeFile(join(dir, "commit-source.ts"), "export const lockValue = 1;\n");
    git("add", ".");
    git("commit", "-m", "lock");
    const commit = git("rev-parse", "HEAD").trim();

    const held = message(first);
    first.send({ cwd: dir, revision: "HEAD", hold: true });
    assert.equal((await held).status, "publishing");
    const cache = join(dir, ".pi", "facts-commit-cache");
    const lock = join(cache, "facts.lock");
    // First writer owns the lock; it must have written exactly one owner record.
    assert.equal((await readdir(lock)).length, 1);

    const done = message(second);
    second.send({ cwd: dir, revision: "HEAD" });
    // The second writer cannot complete while the first holds the lock.
    const early = await Promise.race([
      done.then(() => "overlap"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
    ]);
    assert.equal(early, "waiting");
    // Still only the first writer's owner record exists while waiting.
    assert.equal((await readdir(lock)).length, 1);

    const firstDone = message(first);
    first.send({ release: true });
    const [firstResult, secondResult] = await Promise.all([firstDone, done]);
    assert.equal(firstResult.status, "done");
    assert.equal(secondResult.status, "done");
    assert.equal(firstResult.commit, commit);
    assert.equal(secondResult.commit, commit);
    assert.equal(secondResult.generation, firstResult.generation);

    const store = new FactsStore(dir, ".pi/facts-commit-cache");
    const database = await store.load();
    assert.equal(database!.files["commit-source.ts"].symbols[0].name, "lockValue");
    assert.equal(store.getGeneration(), firstResult.generation);
    // Lock fully released after both writers finished: the lock dir itself is gone.
    await assert.rejects(readdir(join(cache, "facts.lock")), { code: "ENOENT" });
  } finally {
    first.kill();
    second.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a waiting commit writer honours cancellation and leaves the held lock untouched", { timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-commit-abort-"));
  const holder = commitWorker();
  const waiter = commitWorker();
  try {
    await Promise.all([message(holder), message(waiter)]);
    const git = commitFixture(dir);
    await writeFile(join(dir, "commit-source.ts"), "export const abortValue = 1;\n");
    git("add", ".");
    git("commit", "-m", "abort");
    const commit = git("rev-parse", "HEAD").trim();

    const held = message(holder);
    holder.send({ cwd: dir, revision: "HEAD", hold: true });
    assert.equal((await held).status, "publishing");
    const cache = join(dir, ".pi", "facts-commit-cache");
    const lock = join(cache, "facts.lock");

    // The lock already exists with a live owner record, so the waiter can only
    // be inside the production retry loop: it can neither acquire (held) nor
    // recover (owner pid is alive). Aborting now deterministically cancels a
    // waiting writer.
    const failed = once(waiter, "message");
    waiter.send({ cwd: dir, revision: "HEAD" });
    waiter.send({ abort: true });
    const [value] = await failed;
    assert.equal(value.status, "error");
    assert.equal(value.name, "AbortError");

    // No owner record may have been written by the cancelled waiter.
    assert.equal((await readdir(lock)).length, 1);

    // The first writer's result is unaffected by the cancelled waiter.
    const holderDone = message(holder);
    holder.send({ release: true });
    assert.equal((await holderDone).status, "done");
    const store = new FactsStore(dir, ".pi/facts-commit-cache");
    const database = await store.load();
    assert.equal(database!.files["commit-source.ts"].symbols[0].name, "abortValue");
  } finally {
    holder.kill();
    waiter.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a killed commit writer's lock is recovered and the next writer completes publication", {
  timeout: 30000,
  skip: process.platform !== "linux",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-commit-crash-"));
  const owner = commitWorker();
  const next = commitWorker();
  try {
    await Promise.all([message(owner), message(next)]);
    const git = commitFixture(dir);
    await writeFile(join(dir, "commit-source.ts"), "export const crashValue = 1;\n");
    git("add", ".");
    git("commit", "-m", "crash");
    const commit = git("rev-parse", "HEAD").trim();

    const held = message(owner);
    owner.send({ cwd: dir, revision: "HEAD", hold: true });
    assert.equal((await held).status, "publishing");
    const cache = join(dir, ".pi", "facts-commit-cache");
    const lock = join(cache, "facts.lock");
    const [ownerRecord] = await readdir(lock);
    assert.match(ownerRecord, /^owner-[a-f0-9-]{36}\.json$/);
    const ownerPid = JSON.parse(await readFile(join(lock, ownerRecord), "utf8")).pid;
    assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0);

    const exited = once(owner, "exit");
    owner.kill("SIGKILL");
    await exited;

    // Same boot/host/pid namespace with a dead pid: the waiter must recover
    // the owner record and complete instead of waiting out the deadline.
    const done = message(next);
    next.send({ cwd: dir, revision: "HEAD" });
    const result = await done;
    assert.equal(result.status, "done");
    assert.equal(result.commit, commit);
    const store = new FactsStore(dir, ".pi/facts-commit-cache");
    const database = await store.load();
    assert.equal(database!.files["commit-source.ts"].symbols[0].name, "crashValue");
    // Recovery removed the dead owner's lock dir; after the new writer
    // finished, no lock remains.
    await assert.rejects(readdir(lock), { code: "ENOENT" });
  } finally {
    owner.kill();
    next.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
