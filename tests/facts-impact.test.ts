import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFactsImpact } from "../lib/facts/facts-impact.ts";
import type { FactsDatabase } from "../lib/facts/facts-types.ts";

function database(files: Record<string, string>, edges: Array<[string, string]>): FactsDatabase {
  return {
    version: "1.2.0", root: "/repo", updatedAt: 1,
    files: Object.fromEntries(Object.entries(files).map(([path, sha]) => [path, { path, sha, symbols: [], imports: [], exports: [] }])),
    moduleEdges: edges.map(([importer, target]) => ({ importer, target, specifier: `./${target}`, evidence: "typescript" })),
  };
}

test("impact traverses old and new graphs, including removed files and cycles", () => {
  const base = database({ "api.ts": "1", "client.ts": "1", "app.ts": "1" }, [["client.ts", "api.ts"], ["app.ts", "client.ts"], ["client.ts", "app.ts"]]);
  const candidate = database({ "client.ts": "1", "app.ts": "1" }, [["app.ts", "client.ts"], ["client.ts", "app.ts"]]);
  const result = analyzeFactsImpact(base, candidate);
  assert.deepEqual(result.changedSources, [{ file: "api.ts", change: "deleted" }]);
  assert.ok(result.consumers.some((entry) => entry.file === "app.ts" && entry.side === "base" && entry.depth === 1));
  assert.ok(result.resolutionChangedImporters.includes("client.ts"));
  assert.ok(result.consumers.length < 10);
});

test("configuration-only edge changes seed impact without pretending source changed", () => {
  const files = { "a.ts": "1", "b.ts": "1", "client.ts": "1", "app.ts": "1" };
  const result = analyzeFactsImpact(database(files, [["client.ts", "a.ts"], ["app.ts", "client.ts"]]), database(files, [["client.ts", "b.ts"], ["app.ts", "client.ts"]]));
  assert.deepEqual(result.changedSources, []);
  assert.deepEqual(result.resolutionChangedImporters, ["client.ts"]);
  assert.ok(result.consumers.some((entry) => entry.file === "app.ts" && entry.depth === 1));
});

test("unresolved imports remain uncertainty, never edges or a zero-risk assertion", () => {
  const base = database({ "a.py": "1", "b.py": "1" }, []);
  base.moduleEdges = [{ importer: "b.py", specifier: "a", evidence: "unresolved", reason: "language-resolution-not-supported" }];
  const next = { ...base, files: { ...base.files, "a.py": { ...base.files["a.py"], sha: "2" } } };
  const result = analyzeFactsImpact(base, next);
  assert.equal(result.coverage.base.unresolvedImports, 1);
  assert.deepEqual(result.consumers, []);
  assert.equal(result.assessment, "potential-file-dependents-only");
  assert.throws(() => analyzeFactsImpact(base, { ...next, root: "/other" }), /repository/);
});

test("impact records shortest import paths and honours direct-only mode", () => {
  const edges: Array<[string, string]> = [["client.ts", "api.ts"], ["app.ts", "client.ts"], ["client.ts", "app.ts"]];
  const before = database({ "api.ts": "1", "client.ts": "1", "app.ts": "1" }, edges);
  const after = database({ "api.ts": "2", "client.ts": "1", "app.ts": "1" }, edges);
  const result = analyzeFactsImpact(before, after);
  assert.ok(result.consumers.some((entry) => entry.file === "app.ts" && entry.depth === 2 && entry.origin === "api.ts" && entry.via === "client.ts"));
  assert.ok(analyzeFactsImpact(before, after, { transitive: false }).consumers.every((entry) => entry.depth === 1));
  assert.deepEqual(analyzeFactsImpact(before, before).consumers, []);
});

test("filesystem evidence with an indexed target counts as resolved coverage", () => {
	const files = { "a.ts": "1", "b.ts": "1" };
	const base = database(files, []);
	base.moduleEdges = [{ importer: "a.ts", specifier: "./b.json", target: "b.ts", evidence: "filesystem" }];
	const after = { ...base, files: { ...base.files, "b.ts": { ...base.files["b.ts"], sha: "2" } } };
	const result = analyzeFactsImpact(base, after);
	assert.equal(result.coverage.base.resolvedImports, 1);
	assert.equal(result.coverage.base.unresolvedImports, 0);
	assert.ok(result.consumers.some((entry) => entry.file === "a.ts" && entry.side === "base" && entry.depth === 1));
});

test("missing graph coverage and renames do not silently become semantic equivalence", () => {
  const before = database({ "old.ts": "same" }, []);
  delete before.moduleEdges;
  const after = database({ "new.ts": "same" }, []);
  const result = analyzeFactsImpact(before, after);
  assert.equal(result.coverage.base.graphAvailable, false);
  assert.deepEqual(result.changedSources, [{ file: "new.ts", change: "added" }, { file: "old.ts", change: "deleted" }]);
  const oversized = { ...after, moduleEdges: Array.from({ length: 100001 }, () => ({ importer: "new.ts", specifier: "x", evidence: "unresolved" as const })) };
  assert.throws(() => analyzeFactsImpact(before, oversized), /limit/);
});
