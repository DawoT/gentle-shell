import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFactsTree } from "../lib/facts/facts-git-objects.ts";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "facts-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  return root;
}

test("Facts reads an uncommitted immutable tree while ignoring later checkout edits", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "api.ts"), 'export const original = 1;');
  execFileSync("git", ["add", "."], { cwd: root });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(join(root, "api.ts"), 'export const dirty = 2;');
  const result = await readFactsTree(root, tree);
  assert.equal(result.tree, tree);
  assert.match(result.files.get("api.ts")!.toString(), /original/);
  await assert.rejects(readFactsTree(root, "HEAD^{tree}"), /tree identifier/);
});

test("Facts reads controller-selected isolated objects without ambient Git redirection", async (t) => {
  const root = await fixture(t);
  const objects = join(root, "isolated-objects");
  await mkdir(objects);
  const environment = { ...process.env, GIT_OBJECT_DIRECTORY: objects };
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, env: environment, input: 'export const isolated = true;', encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["mktree"], { cwd: root, env: environment, input: `100644 blob ${blob}\tapi.ts\n`, encoding: "utf8" }).trim();
  await assert.rejects(readFactsTree(root, tree));
  const result = await readFactsTree(root, tree, undefined, { objectDirectory: objects });
  assert.match(result.files.get("api.ts")!.toString(), /isolated/);
  await assert.rejects(readFactsTree(root, tree, undefined, { objectDirectory: "relative" }), /object directory/);
});

test("tree indexing is ephemeral and preserves tree identity without inventing a commit", async (t) => {
  const { indexFactsTree } = await import("../lib/facts/facts-tree.ts");
  const { stat } = await import("node:fs/promises");
  const root = await fixture(t);
  await writeFile(join(root, "api.ts"), 'export function login(name: string): boolean { return !!name; }');
  execFileSync("git", ["add", "."], { cwd: root });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(join(root, "api.ts"), 'export const dirty = true;');
  const result = await indexFactsTree(root, tree);
  assert.equal(result.tree, tree);
  assert.equal(result.database.lastHeadCommit, undefined);
  assert.equal(result.database.source, undefined);
  assert.equal(result.database.files["api.ts"].symbols[0].name, "login");
  await assert.rejects(stat(join(root, ".pi")), { code: "ENOENT" });
});

test("tree reads reject corrupted nested tree objects even when the root remains valid", async (t) => {
  const { deflateSync } = await import("node:zlib");
  const { chmod } = await import("node:fs/promises");
  const root = await fixture(t);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "api.ts"), 'export const original = 1;');
  execFileSync("git", ["add", "."], { cwd: root });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  const nested = execFileSync("git", ["rev-parse", `${tree}:src`], { cwd: root, encoding: "utf8" }).trim();
  const object = execFileSync("git", ["cat-file", "tree", nested], { cwd: root });
  const changed = Buffer.from(object);
  const name = changed.indexOf(Buffer.from("api.ts"));
  assert.ok(name >= 0);
  changed.write("bad.ts", name);
  await chmod(join(root, ".git", "objects", nested.slice(0, 2), nested.slice(2)), 0o600);
  await writeFile(join(root, ".git", "objects", nested.slice(0, 2), nested.slice(2)), deflateSync(Buffer.concat([Buffer.from(`tree ${changed.length}\0`), changed])));
  await assert.rejects(readFactsTree(root, tree), /checksum|corrupt/i);
});

test("impact compares frozen trees before any commit exists", async (t) => {
  const { analyzeFactsTrees } = await import("../lib/facts/facts-impact.ts");
  const root = await fixture(t);
  await writeFile(join(root, "api.ts"), 'export const value = 1;');
  await writeFile(join(root, "consumer.ts"), 'import { value } from "./api"; export const copy = value;');
  execFileSync("git", ["add", "."], { cwd: root });
  const base = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(join(root, "api.ts"), 'export const value = 2;');
  execFileSync("git", ["add", "."], { cwd: root });
  const candidate = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  await writeFile(join(root, "consumer.ts"), 'export const dirty = true;');
  const result = await analyzeFactsTrees(root, base, candidate);
  assert.equal(result.baseTree, base);
  assert.equal(result.candidateTree, candidate);
  assert.deepEqual(result.impact.changedSources, [{ file: "api.ts", change: "modified" }]);
  assert.ok(result.impact.consumers.some((entry) => entry.file === "consumer.ts"));
});

test("tree filenames preserve a leading UTF-8 BOM as part of the path", async (t) => {
  const root = await fixture(t);
  const path = "\ufeffapi.ts";
  await writeFile(join(root, path), 'export const exact = 1;');
  execFileSync("git", ["add", "."], { cwd: root });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  const result = await readFactsTree(root, tree);
  assert.ok(result.files.has(path));
  assert.equal(result.files.has("api.ts"), false);
});

test("tree parsing supports SHA-256 object identifiers", async (t) => {
  const root = await fixture(t);
  await rm(join(root, ".git"), { recursive: true, force: true });
  execFileSync("git", ["init", "-b", "main", "--object-format=sha256"], { cwd: root });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "api.ts"), 'export const sha256 = true;');
  execFileSync("git", ["add", "."], { cwd: root });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(tree.length, 64);
  const result = await readFactsTree(root, tree);
  assert.match(result.files.get("src/api.ts")!.toString(), /sha256/);
});

test("isolated trees can reference blobs from an explicit alternate object store", async (t) => {
  const root = await fixture(t);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: 'export const shared = 1;', encoding: "utf8" }).trim();
  const objects = join(root, "isolated-objects");
  await mkdir(objects);
  const alternate = join(root, ".git", "objects");
  const environment = { ...process.env, GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate };
  const tree = execFileSync("git", ["mktree"], { cwd: root, env: environment, input: `100644 blob ${blob}\tapi.ts\n`, encoding: "utf8" }).trim();
  const result = await readFactsTree(root, tree, undefined, { objectDirectory: objects, alternateObjectDirectories: [alternate] });
  assert.match(result.files.get("api.ts")!.toString(), /shared/);
});
