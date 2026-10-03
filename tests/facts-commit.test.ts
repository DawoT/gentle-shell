import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
