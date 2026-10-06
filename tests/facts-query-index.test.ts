import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type FileFacts } from "../lib/facts/facts-types.ts";
import type { FactsModuleEdge } from "../lib/facts/facts-module-resolver.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { buildFactsQueryIndex, querySymbolsLinear, queryDependencyEvidenceLinear, querySymbolsWithIndex, queryDependencyEvidenceWithIndex } from "../lib/facts/facts-query-index.ts";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stubFile(path: string, sha: string, symbols: { name: string; isExported: boolean }[], imports: string[]): FileFacts {
  return {
    path,
    sha,
    symbols: symbols.map((s, index) => ({ ...s, kind: "function", startLine: index * 3 + 1, endLine: index * 3 + 2, signature: `fn${index}()` })),
    imports,
    exports: [],
  } as unknown as FileFacts;
}

/** Deterministic random workspace: files with symbols/imports plus resolver-style edges. */
function randomWorkspace(seed: number): { db: FactsDatabase; edges: FactsModuleEdge[] } {
  const rand = mulberry32(seed);
  const count = 5 + Math.floor(rand() * 12);
  const paths = Array.from({ length: count }, (_, i) => `src/mod${i}.ts`);
  const db: FactsDatabase = { version: FACTS_DATABASE_VERSION, root: "/repo", updatedAt: 0, files: {} };
  const specifiersByImporter = new Map<string, string[]>();
  for (const path of paths) {
    const symbols = Array.from({ length: Math.floor(rand() * 4) }, (_, k) => ({
      name: `Sym${Math.floor(rand() * 8)}${k}`,
      isExported: rand() > 0.4,
    }));
    const imports = Array.from({ length: Math.floor(rand() * 4) }, () => `./mod${Math.floor(rand() * count)}.ts`);
    db.files[path] = stubFile(path, `sha-${Math.floor(rand() * 1e9)}`, symbols, imports);
    specifiersByImporter.set(path, imports);
  }
  // One non-TypeScript file with imports: produces the unresolved tail.
  const plain = `docs/notes${Math.floor(rand() * 3)}.md`;
  db.files[plain] = stubFile(plain, `sha-plain-${Math.floor(rand() * 1e9)}`, [], ["some-bare-pkg"]);
  const edges: FactsModuleEdge[] = [];
  for (const importer of Object.keys(db.files).sort()) {
    const file = db.files[importer];
    if (!importer.endsWith(".ts")) {
      for (const specifier of file.imports) {
        edges.push({ importer, specifier, evidence: "unresolved", reason: "language-resolution-not-supported" });
      }
      continue;
    }
    for (const specifier of [...new Set(file.imports)].sort()) {
      const target = rand() > 0.3 ? specifier.replace("./", "src/") : undefined;
      edges.push({
        importer,
        specifier,
        ...(target && Object.hasOwn(db.files, target) ? { target } : {}),
        evidence: target ? "typescript" : "unresolved",
        ...(target ? {} : { reason: "module-not-found" }),
      });
    }
  }
  return { db, edges };
}

const QUERIES = [
  { name: "Sym0" },
  { name: "sym0" },
  { name: "Sym3" },
  { name: undefined, file: "src/mod1.ts" },
  { name: "Sym1", file: "src/mod1.ts" },
  { name: "Missing" },
];

const EVIDENCE_QUERIES: Array<[string, { transitive?: boolean }]> = [
  ["src/mod0.ts", {}],
  ["src/mod1.ts", { transitive: true }],
  ["src/mod2.ts", { transitive: true }],
  ["mod1.ts", { transitive: true }],
  ["./missing.ts", {}],
  ["Sym0", { transitive: true }],
  ["some-bare-pkg", {}],
];

test("index results are indistinguishable from the linear reference across randomized workspaces", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { db, edges } = randomWorkspace(seed);
    const index = buildFactsQueryIndex(db, edges, "gen-1");
    for (const query of QUERIES) {
      assert.deepEqual(querySymbolsWithIndex(index, query), querySymbolsLinear(db, query), `seed ${seed} query ${JSON.stringify(query)}`);
    }
    for (const [target, options] of EVIDENCE_QUERIES) {
      assert.deepEqual(
        queryDependencyEvidenceWithIndex(index, target, options),
        queryDependencyEvidenceLinear(db, edges, target, options),
        `seed ${seed} evidence ${target} ${JSON.stringify(options)}`,
      );
    }
  }
});

test("index build never mutates the database or the edges array", () => {
  const { db, edges } = randomWorkspace(7);
  const dbSnapshot = JSON.stringify(db);
  const edgesSnapshot = JSON.stringify(edges);
  buildFactsQueryIndex(db, edges, "gen-1");
  assert.equal(JSON.stringify(db), dbSnapshot);
  assert.equal(JSON.stringify(edges), edgesSnapshot);
  assert.equal(edges.length, JSON.parse(edgesSnapshot).length);
});

test("BFS records keep the shallowest depth and the last edge in original array order", () => {
  // Two exported owners put both targets in the frontier at depth 1, so the
  // importer x.ts matches two edges in the same level: the record must come
  // from the LAST matching edge in original array order (and flipping the
  // array order must flip the winner).
  const build = (edgeOrder: "middle-first" | "core-first") => {
    const db: FactsDatabase = {
      version: FACTS_DATABASE_VERSION,
      root: "/repo",
      updatedAt: 0,
      files: {
        "x.ts": stubFile("x.ts", "s1", [], ["./middle", "@app/core"]),
        "middle.ts": stubFile("middle.ts", "s2", [{ name: "shared", isExported: true }], []),
        "core.ts": stubFile("core.ts", "s3", [{ name: "shared", isExported: true }], []),
      },
    };
    const edgeMiddle: FactsModuleEdge = { importer: "x.ts", specifier: "./middle", target: "middle.ts", evidence: "typescript" };
    const edgeCore: FactsModuleEdge = { importer: "x.ts", specifier: "@app/core", target: "core.ts", evidence: "typescript" };
    const edges = edgeOrder === "middle-first" ? [edgeMiddle, edgeCore] : [edgeCore, edgeMiddle];
    const index = buildFactsQueryIndex(db, edges, "g");
    const actual = queryDependencyEvidenceWithIndex(index, "shared", { transitive: true });
    const expected = queryDependencyEvidenceLinear(db, edges, "shared", { transitive: true });
    assert.deepEqual(actual, expected);
    return actual;
  };

  const middleFirst = build("middle-first");
  assert.deepEqual(middleFirst.map((item) => item.file), ["x.ts"]);
  assert.equal(middleFirst[0]?.depth, 1);
  assert.equal(middleFirst[0]?.via, "core.ts", "the last matching edge in array order wins");

  const coreFirst = build("core-first");
  assert.equal(coreFirst[0]?.via, "middle.ts", "flipping the array order flips the winner");
});

test("the literal-specifier fallback still produces syntactic evidence", () => {
  const db: FactsDatabase = {
    version: FACTS_DATABASE_VERSION,
    root: "/repo",
    updatedAt: 0,
    files: { "x.ts": stubFile("x.ts", "s1", [], ["left-pad"]) },
  };
  const edges: FactsModuleEdge[] = [{ importer: "x.ts", specifier: "left-pad", evidence: "unresolved", reason: "module-not-found" }];
  const index = buildFactsQueryIndex(db, edges, "g");
  const actual = queryDependencyEvidenceWithIndex(index, "left-pad", {});
  const expected = queryDependencyEvidenceLinear(db, edges, "left-pad", {});
  assert.deepEqual(actual, expected);
  assert.equal(actual[0]?.evidence, "syntactic");
  assert.equal(actual[0]?.via, "left-pad");
});

test("the service uses the index and rebuilds it when the generation changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-query-index-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  try {
    await writeFile(join(dir, "source.ts"), "export const alpha = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });
    assert.deepEqual(service.querySymbol("alpha").map((r) => r.file), ["source.ts"]);

    await writeFile(join(dir, "source.ts"), "export const beta = 2;\n");
    service.markWorkspaceDirty("manual");
    await service.sync(undefined, { mode: "auto" });
    assert.deepEqual(service.querySymbol("alpha"), []);
    assert.deepEqual(service.querySymbol("beta").map((r) => r.file), ["source.ts"]);

    // The published evidence chain is untouched by indexing.
    const edges = service.getResolutionEdges();
    assert.deepEqual(service.getResolutionEdges(), edges);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a fast-path served generation keeps answering through the same index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-query-index-fast-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });
    const fast = await service.sync(undefined, { mode: "auto" });
    assert.equal(fast.path, "fast");
    assert.deepEqual(service.querySymbol("value").map((r) => r.file), ["source.ts"]);
    assert.equal(service.getPhaseMetrics().phases.query_lookup?.count, 1, "queries stay metered through the index");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real harness keeps its stage proofs green with indexed queries", async () => {
  const { dir, cleanup } = await (async () => {
    const d = await mkdtemp(join(tmpdir(), "facts-query-index-e2e-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: d });
    execFileSync("git", ["config", "user.name", "T"], { cwd: d });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: d });
    return { dir: d, cleanup: () => rm(d, { recursive: true, force: true }) };
  })();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const evidence = service.queryDependencyEvidence("source.ts", { transitive: true });
    assert.deepEqual(evidence, []);
  } finally {
    await cleanup();
  }
});
