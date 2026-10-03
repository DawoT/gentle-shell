import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

let workspace: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", workspace, ...args]);
  return stdout.trim();
}

async function writeTree(relPath: string, content: string) {
  const destination = join(workspace, relPath);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, content);
}

test.before(async () => {
  workspace = await mkdtemp(join(tmpdir(), "gentle-tree-pair-"));
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeTree("src/modified.ts", "export function kept(): number {\n  return 1;\n}\n");
  await writeTree("src/deleted.ts", "export function gone(): void {}\n");
  await writeTree("src/stable.ts", "export function stable(): void {}\n");
  await writeTree("src/importer-stable.ts", 'import { kept } from "./modified.ts";\nexport function useStable(): number {\n  return kept();\n}\n');
  await writeTree("src/importer-stable2.ts", 'import { fresh } from "./added.ts";\nexport function useAdded(): string {\n  return fresh();\n}\n');
  await writeTree("src/importer-changed.ts", 'import { stable } from "./stable.ts";\nexport function useChanged(): void {}\n');
  await git("add", "-A");
  await git("commit", "-qm", "base");
  // Mutations: one add, one modify, one delete; unchanged file untouched.
  await writeTree("src/added.ts", "export function fresh(): string {\n  return \"new\";\n}\n");
  await writeTree("src/modified.ts", "export function kept(): number {\n  return 2;\n}\nexport function extra(): void {}\n");
  await rm(join(workspace, "src/deleted.ts"));
  await git("add", "-A");
  await git("commit", "-qm", "candidate");
});

test.after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const { computeTreePairDigest, TreePairDigestError } = await import("../lib/facts/facts-tree-pair.ts");

test("classifies added/modified/deleted files with hand-derived symbol deltas", async () => {
  const baseTree = await git("rev-parse", "HEAD~1^{tree}");
  const candidateTree = await git("rev-parse", "HEAD^{tree}");
  const changedPaths = (await git("diff", "--name-only", baseTree, candidateTree)).split("\n").sort();
  const digest = await computeTreePairDigest(workspace, baseTree, candidateTree, changedPaths);
  assert.deepEqual(digest.changedPaths, ["src/added.ts", "src/deleted.ts", "src/modified.ts"]);
  assert.deepEqual(digest.files.map((f) => f.path), ["src/added.ts", "src/deleted.ts", "src/modified.ts"]);
  const byPath = new Map(digest.files.map((f) => [f.path, f]));
  assert.equal(byPath.get("src/added.ts")?.classification, "added");
  assert.deepEqual(byPath.get("src/added.ts")?.exportedSymbols.base, []);
  assert.deepEqual(byPath.get("src/added.ts")?.exportedSymbols.candidate, [{ name: "fresh", kind: "function" }]);
  assert.equal(byPath.get("src/deleted.ts")?.classification, "deleted");
  assert.deepEqual(byPath.get("src/deleted.ts")?.exportedSymbols.base, [{ name: "gone", kind: "function" }]);
  assert.deepEqual(byPath.get("src/deleted.ts")?.exportedSymbols.candidate, []);
  assert.equal(byPath.get("src/modified.ts")?.classification, "modified");
  assert.deepEqual(byPath.get("src/modified.ts")?.exportedSymbols.base, [{ name: "kept", kind: "function" }]);
  assert.deepEqual(byPath.get("src/modified.ts")?.exportedSymbols.candidate, [
    { name: "extra", kind: "function" },
    { name: "kept", kind: "function" },
  ]);
  assert.equal(digest.baseTree, baseTree);
  assert.equal(digest.candidateTree, candidateTree);
  assert.equal(typeof digest.extractedAt, "number");
});

test("boundary edges only when an edge crosses the changed/unchanged boundary", async () => {
  const baseTree = await git("rev-parse", "HEAD~1^{tree}");
  const candidateTree = await git("rev-parse", "HEAD^{tree}");
  const digest = await computeTreePairDigest(workspace, baseTree, candidateTree, ["src/added.ts", "src/deleted.ts", "src/modified.ts"]);
  // src/importer-stable.ts (unchanged) -> src/modified.ts (changed): cross-boundary.
  // src/importer-stable2.ts (unchanged, imports ./added.ts which only exists in the
  // candidate) -> src/added.ts (changed): second cross-boundary edge.
  assert.deepEqual(digest.boundaryEdges.map((e) => [e.importer, e.target]), [
    ["src/importer-stable.ts", "src/modified.ts"],
    ["src/importer-stable2.ts", "src/added.ts"],
  ]);
  // src/importer-changed.ts is itself in changedPaths? No — it was never mutated, but its
  // target src/stable.ts is also unchanged, so no edge from it qualifies.
  // unchangedDependents: edges from unchanged files INTO changed files.
  assert.equal(digest.unchangedDependents, 2);
  // Unchanged files never appear in digest.files.
  assert.ok(!digest.files.some((f) => f.path === "src/stable.ts"));
  assert.ok(!digest.files.some((f) => f.path === "src/importer-stable.ts"));
});

test("multi-edge boundary ordering is deterministic and sorted by importer", async () => {
  // Verifier gap (S2a review receipt): single-edge fixtures cannot detect a dropped
  // boundaryEdges.sort. Two crossing edges must appear in sorted-importer order.
  const baseTree = await git("rev-parse", "HEAD~1^{tree}");
  const candidateTree = await git("rev-parse", "HEAD^{tree}");
  const digest = await computeTreePairDigest(workspace, baseTree, candidateTree, ["src/added.ts", "src/deleted.ts", "src/modified.ts"]);
  assert.ok(digest.boundaryEdges.length >= 2, "fixture must produce at least two boundary edges");
  const importers = digest.boundaryEdges.map((e) => e.importer);
  assert.deepEqual(importers, [...importers].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test("digest is deterministic across repeated calls", async () => {
  const baseTree = await git("rev-parse", "HEAD~1^{tree}");
  const candidateTree = await git("rev-parse", "HEAD^{tree}");
  const first = await computeTreePairDigest(workspace, baseTree, candidateTree, ["src/modified.ts"]);
  const second = await computeTreePairDigest(workspace, baseTree, candidateTree, ["src/modified.ts"]);
  assert.deepEqual({ ...first, extractedAt: 0 }, { ...second, extractedAt: 0 });
  assert.equal(typeof first.extractedAt, "number");
});

test("unknown tree rejects with typed error, no partial result", async () => {
  await assert.rejects(
    computeTreePairDigest(workspace, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "HEAD^{tree}", []),
    (error: unknown) => error instanceof TreePairDigestError && error.code === "unknown-tree",
  );
});

test("empty diff (same tree twice) yields empty digest arrays", async () => {
  const tree = await git("rev-parse", "HEAD^{tree}");
  const digest = await computeTreePairDigest(workspace, tree, tree, []);
  assert.deepEqual(digest.files, []);
  assert.deepEqual(digest.boundaryEdges, []);
  assert.equal(digest.unchangedDependents, 0);
});
