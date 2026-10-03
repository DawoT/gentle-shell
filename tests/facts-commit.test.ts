import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import test from "node:test";
import { waitForMarker } from "./support/atomic-marker.mjs";
import { compareCommitToWorkingTree, describeGitFailure, indexFactsCommit } from "../lib/facts/facts-commit.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "facts-commit-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Facts Test");
  git("config", "user.email", "facts@example.invalid");
  await writeFile(join(directory, ".gitignore"), ".pi/\n");
  await writeFile(join(directory, "api.py"), "def committed(value: int):\n  return value\n");
  await writeFile(join(directory, "source.ts"), "export const oldValue = 1;\n");
  await writeFile(join(directory, "consumer.ts"), "import { oldValue } from 'alias';\n");
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { alias: ["./source.ts"] } } }));
  await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  git("add", ".");
  git("commit", "-m", "fixture");
  return { directory, git, commit: git("rev-parse", "HEAD") };
}

test("commit Facts uses immutable Git blobs and configuration without changing the checkout", async () => {
  const { directory, git, commit } = await fixture();
  try {
    await writeFile(join(directory, "source.ts"), "export const dirtyValue = 2;\n");
    await writeFile(join(directory, "tsconfig.json"), "{ broken");
    await writeFile(join(directory, "package.json"), JSON.stringify({ scripts: { lint: "eslint" } }));
    const before = git("status", "--porcelain");
    const first = await indexFactsCommit(directory, commit);
    assert.equal(first.commit, commit);
    assert.equal(first.database.files["source.ts"].symbols[0].name, "oldValue");
    assert.equal(first.database.files["api.py"].symbols[0].name, "committed");
    assert.equal(first.database.moduleEdges!.find((edge) => edge.importer === "consumer.ts")!.target, "source.ts");
    assert.equal(first.database.receipts!.testCommand, "npm test");
    assert.equal(first.database.receipts!.lintCommand, undefined);
    const second = await indexFactsCommit(directory, commit);
    assert.equal(second.generation, first.generation);
    assert.equal(git("status", "--porcelain"), before);
    assert.match(await readFile(join(directory, "source.ts"), "utf8"), /dirtyValue/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit Facts does not follow committed symlinks or replacement objects", { skip: process.platform === "win32" }, async () => {
  const { directory, git, commit } = await fixture();
  try {
    await symlink("/etc/passwd", join(directory, "escape.py"));
    await writeFile(join(directory, "api.py"), "def replacement():\n  pass\n");
    git("add", ".");
    git("commit", "-m", "replacement");
    const newer = git("rev-parse", "HEAD");
    git("replace", commit, newer);
    const original = await indexFactsCommit(directory, commit);
    assert.equal(original.database.files["api.py"].symbols[0].name, "committed");
    const snapshot = await indexFactsCommit(directory, newer);
    assert.equal(snapshot.database.files["escape.py"], undefined);
    assert.ok(snapshot.omitted.some((entry) => entry.path === "escape.py" && entry.reason === "symlink"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit Facts rejects invalid revisions and honours cancellation", async () => {
  const { directory } = await fixture();
  try {
    await assert.rejects(indexFactsCommit(directory, "--help"), /commit|revision/i);
    await assert.rejects(indexFactsCommit(directory, "HEAD", AbortSignal.abort()), { name: "AbortError" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit indexing does not execute a repository signature verifier", { skip: process.platform === "win32" }, async () => {
  const { directory, git, commit } = await fixture();
  try {
    const raw = git("cat-file", "commit", commit);
    const signed = raw.replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n");
    const oid = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: directory, input: signed, encoding: "utf8" }).trim();
    const verifier = join(directory, "verifier");
    await writeFile(verifier, '#!/bin/sh\nprintf invoked > verifier-invoked\nexit 1\n', { mode: 0o700 });
    git("config", "gpg.program", verifier);
    git("config", "log.showSignature", "true");
    await indexFactsCommit(directory, oid);
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(join(directory, "verifier-invoked")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active commit cancellation waits for the Git subprocess to exit", { skip: process.platform === "win32" }, async () => {
  const { directory } = await fixture();
  const priorPath = process.env.PATH;
  const priorStart = process.env.FACTS_TEST_START;
  const priorDone = process.env.FACTS_TEST_DONE;
  const controller = new AbortController();
  try {
    const { mkdir, access } = await import("node:fs/promises");
    const { delimiter } = await import("node:path");
    const { setTimeout: delay } = await import("node:timers/promises");
    const bin = join(directory, "bin");
    await mkdir(bin);
    const started = join(directory, "started");
    const done = join(directory, "done");
    await writeFile(join(bin, "git"), `#!${process.execPath}\nconst fs = require("node:fs");\nprocess.on("SIGTERM", () => {\n  setTimeout(() => {\n    fs.writeFileSync(process.env.FACTS_TEST_DONE, "done");\n    process.exit(0);\n  }, 150);\n});\nfs.writeFileSync(process.env.FACTS_TEST_START, "ready");\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${delimiter}${priorPath}`;
    process.env.FACTS_TEST_START = started;
    process.env.FACTS_TEST_DONE = done;
    const checked = assert.rejects(indexFactsCommit(directory, "HEAD", controller.signal), { name: "AbortError" });
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await access(started).then(() => true, () => false)) {
        ready = true;
        break;
      }
      await delay(10);
    }
    controller.abort();
    await checked;
    assert.equal(ready, true, "Git shim must have started before cancellation");
    assert.equal(await readFile(done, "utf8"), "done", "rejection must wait for child exit");
  } finally {
    controller.abort();
    const { setTimeout: delay } = await import("node:timers/promises");
    await delay(200);
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorStart === undefined) delete process.env.FACTS_TEST_START;
    else process.env.FACTS_TEST_START = priorStart;
    if (priorDone === undefined) delete process.env.FACTS_TEST_DONE;
    else process.env.FACTS_TEST_DONE = priorDone;
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized committed input preserves the last published commit generation", async () => {
  const { directory, git, commit } = await fixture();
  try {
    await indexFactsCommit(directory, commit);
    const pointer = join(directory, ".pi", "facts-commit-cache", "facts.json");
    const previous = await readFile(pointer, "utf8");
    await writeFile(join(directory, "large.py"), "#".repeat(1024 * 1024 + 1));
    git("add", "large.py");
    git("commit", "-m", "oversized input");
    await assert.rejects(indexFactsCommit(directory, "HEAD"), /byte limit/);
    assert.equal(await readFile(pointer, "utf8"), previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed package scope and submodule omissions are explicit", async () => {
  const { directory, git, commit } = await fixture();
  try {
    const { mkdir } = await import("node:fs/promises");
    const cwd = join(directory, "packages", "app");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "compile" } }));
    git("add", ".");
    git("update-index", "--add", "--cacheinfo", `160000,${commit},vendor/module`);
    git("commit", "-m", "scope and submodule");
    const result = await indexFactsCommit(cwd, "HEAD");
    assert.equal(result.database.source!.scope, "packages/app");
    assert.equal(result.database.receipts!.commandCwd, "packages/app");
    assert.equal(result.database.receipts!.buildCommand, "npm run build");
    assert.ok(result.omitted.some((entry) => entry.path === "vendor/module" && entry.reason === "submodule"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit working-tree comparison reports match exactly for a clean checkout of HEAD", async () => {
  const { directory, commit } = await fixture();
  try {
    const clean = await compareCommitToWorkingTree(directory, commit);
    assert.equal(clean.outcome, "match");
    assert.ok(Number.isFinite(clean.elapsedMs) && clean.elapsedMs >= 0);
    await writeFile(join(directory, "source.ts"), "export const dirtyValue = 2;\n");
    const dirty = await compareCommitToWorkingTree(directory, commit);
    assert.equal(dirty.outcome, "differs");
    assert.ok(Number.isFinite(dirty.elapsedMs) && dirty.elapsedMs >= 0);
    await writeFile(join(directory, "untracked.py"), "def stray():\n  pass\n");
    assert.equal((await compareCommitToWorkingTree(directory, commit)).outcome, "differs");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit working-tree comparison reports differs for a non-HEAD commit", async () => {
  const { directory, git, commit } = await fixture();
  try {
    await writeFile(join(directory, "source.ts"), "export const nextValue = 3;\n");
    git("add", ".");
    git("commit", "-m", "second");
    assert.notEqual(git("rev-parse", "HEAD"), commit);
    const comparison = await compareCommitToWorkingTree(directory, commit);
    assert.equal(comparison.outcome, "differs");
    assert.ok(Number.isFinite(comparison.elapsedMs) && comparison.elapsedMs >= 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("commit working-tree comparison reports unavailable when Git is missing", { skip: process.platform === "win32" }, async () => {
  const { directory, commit } = await fixture();
  const priorPath = process.env.PATH;
  try {
    const { mkdir } = await import("node:fs/promises");
    const { delimiter } = await import("node:path");
    const emptyBin = join(directory, "empty-bin");
    await mkdir(emptyBin);
    process.env.PATH = `${emptyBin}${delimiter}`;
    const comparison = await compareCommitToWorkingTree(directory, commit);
    assert.equal(comparison.outcome, "unavailable");
    assert.ok(comparison.outcome === "unavailable" && comparison.reason === "git is not available");
    assert.ok(Number.isFinite(comparison.elapsedMs) && comparison.elapsedMs >= 0);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(directory, { recursive: true, force: true });
  }
});

// A reason-text classifier must not turn caller cancellation into a deadline.
for (const reason of [undefined, "stop", 42, Symbol("stop"), new Error("deadline maxBuffer ENOENT"), { deadline: true }]) {
  test(`preaborted comparison preserves caller provenance for ${typeof reason}`, async () => {
    const result = await compareCommitToWorkingTree(".", "unused", AbortSignal.abort(reason));
    assert.equal(result.outcome, "unavailable");
    assert.ok(result.outcome === "unavailable" && result.reason === "git cancelled");
  });
}

// Subscribe before reading: readiness comes from a real child, not a timed
// sleep. Shared utility: non-empty validation + watcher cleanup are handled
// there; this suite's default non-empty semantics match.
async function withProbe(mode: string, action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "facts-probe-test-"));
  const priorPath = process.env.PATH;
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const worker = await readFile(new URL("./support/facts-probe-worker.mjs", import.meta.url), "utf8");
    // The worker imports the shared atomic-marker helper relatively, so the
    // helper must be copied next to the shim for the import to resolve.
    await writeFile(join(bin, "atomic-marker.mjs"), await readFile(new URL("./support/atomic-marker.mjs", import.meta.url), "utf8"));
    await writeFile(join(bin, "git"), worker.replace("#!/usr/bin/env node", `#!${process.execPath}`), { mode: 0o700 });
    await writeFile(join(directory, "mode"), mode);
    process.env.PATH = `${bin}${delimiter}${priorPath ?? ""}`;
    await action(directory);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    // Failed assertions must not leak a hostile fixture child.
    try {
      const { pid } = parseReadyMarker(await readFile(join(directory, "ready"), "utf8"));
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

function parseReadyMarker(raw: string): { pid: number; starttime?: string } {
  const [pid, starttime] = raw.trim().split(/\s+/);
  return { pid: Number(pid), starttime: starttime && starttime !== "unknown" ? starttime : undefined };
}

function procProcessState(pid: number, starttime?: string): "exited" | "alive" | "unknown" {
  if (starttime === undefined) return "unknown";
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "exited";
    return "unknown";
  }
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (after[19] !== starttime) return "exited"; // PID reused: the original child is gone.
  return after[0] === "Z" ? "exited" : "alive";
}

function readProcStat(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  } catch {
    return undefined;
  }
}

function assertChildExited(pid: number, starttime?: string) {
  // A just-exited child can linger as an unreaped zombie under load, and its
  // PID can even be reused in low-pid_max environments, so a plain ESRCH
  // probe is not identity-safe. Poll /proc state (starttime identity) when
  // available, falling back to ESRCH polling on POSIX systems without it.
  // A genuinely leaked child survives the 250ms SIGKILL escalation and keeps
  // answering far beyond this window, so the assertion still fires.
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    const state = procProcessState(pid, starttime);
    if (state === "exited") return;
    if (state === "unknown") {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const stat = readProcStat(pid);
  assert.fail(
    `comparison returned before its real Git child exited (pid=${pid} expected-starttime=${starttime ?? "n/a"} stat=${stat === undefined ? "absent" : stat})`,
  );
}

for (const reason of [undefined, "stop", 42, Symbol("stop"), new Error("deadline"), { stop: true }]) {
  test(`active caller cancellation waits for close with ${typeof reason} reason`, { skip: process.platform === "win32", timeout: 25_000 }, async () => {
    await withProbe("delayed", async (directory) => {
      const controller = new AbortController();
      const pending = compareCommitToWorkingTree(directory, "unused", controller.signal);
      const { pid, starttime } = parseReadyMarker(await waitForMarker(directory, "ready"));
      controller.abort(reason);
      const result = await pending;
      assert.deepEqual(result.outcome === "unavailable" ? result.reason : result.outcome, "git cancelled");
      assert.equal(await readFile(join(directory, "done"), "utf8"), "yes");
      assertChildExited(pid, starttime);
    });
  });
}

test("caller cancellation kills a Git child that ignores SIGTERM before returning", { skip: process.platform === "win32", timeout: 25_000 }, async () => {
  await withProbe("hostile", async (directory) => {
    const controller = new AbortController();
    const pending = compareCommitToWorkingTree(directory, "unused", controller.signal);
    const { pid, starttime } = parseReadyMarker(await waitForMarker(directory, "ready"));
    controller.abort("deadline");
    const result = await pending;
    assert.ok(result.outcome === "unavailable" && result.reason === "git cancelled");
    assertChildExited(pid, starttime);
  });
});

test("real per-command deadline wins over a later caller abort and reaps hostile Git", { skip: process.platform === "win32", timeout: 25_000 }, async () => {
  await withProbe("hostile", async (directory) => {
    const controller = new AbortController();
    const pending = compareCommitToWorkingTree(directory, "unused", controller.signal);
    const { pid, starttime } = parseReadyMarker(await waitForMarker(directory, "ready"));
    await waitForMarker(directory, "terminated");
    controller.abort(new Error("later caller"));
    const result = await pending;
    assert.ok(result.outcome === "unavailable" && result.reason === "git deadline exceeded");
    assert.ok(result.elapsedMs >= 14_900 && result.elapsedMs < 20_000);
    assertChildExited(pid, starttime);
  });
});

test("actual Git output above 1MiB is unavailable and its SIGTERM-resistant child is reaped", { skip: process.platform === "win32", timeout: 25_000 }, async () => {
  await withProbe("overflow", async (directory) => {
    const pending = compareCommitToWorkingTree(directory, "unused");
    const { pid, starttime } = parseReadyMarker(await waitForMarker(directory, "ready"));
    const result = await pending;
    assert.ok(result.outcome === "unavailable" && result.reason === "git output exceeded the capture buffer");
    assertChildExited(pid, starttime);
  });
});

test("describeGitFailure maps Git probe failures to stable reasons without throwing", () => {
  assert.equal(describeGitFailure(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), "git is not available");
  assert.equal(describeGitFailure(new Error("Facts Git deadline exceeded")), "git deadline exceeded");
  assert.equal(describeGitFailure(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), "git deadline exceeded");
  assert.equal(describeGitFailure(Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" })), "git output exceeded the capture buffer");
  assert.equal(describeGitFailure(new Error("child stdout maxBuffer exceeded")), "git output exceeded the capture buffer");
  assert.equal(describeGitFailure(new Error("fatal: bad object")), "git failed");
  for (const weird of [undefined, null, "boom", 42, {}, Symbol("weird")]) {
    const described = describeGitFailure(weird);
    assert.equal(typeof described, "string");
    assert.ok(described.length > 0);
  }
});

test("a working-tree refresh never retains committed provenance from a reused cache", async () => {
  const { directory, commit } = await fixture();
  try {
    const { FactsStore } = await import("../lib/facts/facts-store.ts");
    const { FactsService } = await import("../lib/facts/facts-service.ts");
    const pinned = await indexFactsCommit(directory, commit);
    await new FactsStore(directory).save(pinned.database);
    await writeFile(join(directory, "source.ts"), "export const working = 2;\n");
    const service = new FactsService(directory);
    await service.sync();
    assert.equal(service.getDatabase()!.source, undefined);
    assert.equal(service.querySymbol("working").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
