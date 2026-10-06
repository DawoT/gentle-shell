import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileFacts } from "../lib/facts/facts-types.ts";
import { resolveFactsModuleSnapshot, resolveFactsModuleSnapshotIncremental, type FactsResolutionCache } from "../lib/facts/facts-module-resolver.ts";
import { resolveModuleSnapshotInWorker } from "../lib/facts/facts-worker.ts";

function stub(path: string, sha: string, imports: string[]): FileFacts {
  return { path, sha, imports, symbols: [], exports: [] } as unknown as FileFacts;
}

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-resolution-cache-"));
  await mkdir(join(dir, "libs"), { recursive: true });
  await writeFile(join(dir, "math.ts"), "export function multiply(a: number, b: number): number { return a * b; }\n");
  await writeFile(join(dir, "main.ts"), "import { multiply } from './math.ts';\nexport const value = multiply(2, 3);\n");
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("incremental resolution reuses every unchanged importer", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["./math.ts"]),
      "math.ts": stub("math.ts", "sha-math-1", []),
    };
    const cache: FactsResolutionCache = new Map();
    const first = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.equal(first.freshImporters, 2);
    assert.equal(first.consistent, true);

    const second = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.equal(second.freshImporters, 0, "no importer changed: everything is served from the cache");
    assert.deepEqual(second.edges, first.edges);
    assert.equal(second.consistent, true);
  } finally {
    await cleanup();
  }
});

test("a changed importer re-resolves alone and keeps the rest cached", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "extra.ts"), "export const extra = true;\n");
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["./math.ts"]),
      "math.ts": stub("math.ts", "sha-math-1", []),
    };
    const cache: FactsResolutionCache = new Map();
    const first = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.deepEqual(first.edges.filter((edge) => edge.importer === "main.ts"), [
      { importer: "main.ts", specifier: "./math.ts", target: "math.ts", evidence: "typescript", reason: "default-compiler-options" },
    ]);

    const changed: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-2", ["./extra.ts"]),
      "extra.ts": stub("extra.ts", "sha-extra-1", []),
      "math.ts": files["math.ts"],
    };
    const second = resolveFactsModuleSnapshotIncremental(dir, changed, cache);
    assert.equal(second.freshImporters, 2, "the changed importer and the newly indexed file re-resolve");
    assert.deepEqual(second.edges.filter((edge) => edge.importer === "main.ts"), [
      { importer: "main.ts", specifier: "./extra.ts", target: "extra.ts", evidence: "typescript", reason: "default-compiler-options" },
    ]);
    assert.deepEqual(second.edges.filter((edge) => edge.importer === "math.ts"), []);
  } finally {
    await cleanup();
  }
});

test("a tsconfig change invalidates the importers that depend on it", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const tsconfig = {
      compilerOptions: {
        baseUrl: ".",
        module: "esnext",
        moduleResolution: "bundler",
        paths: { "@lib/*": ["./missing/*"] },
      },
    };
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify(tsconfig));
    await writeFile(join(dir, "libs", "math.ts"), "export const lib = true;\n");
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["@lib/math"]),
      "math.ts": stub("math.ts", "sha-math-1", []),
      "libs/math.ts": stub("libs/math.ts", "sha-lib-1", []),
    };
    const cache: FactsResolutionCache = new Map();
    const first = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.deepEqual(first.edges.filter((edge) => edge.importer === "main.ts"), [
      { importer: "main.ts", specifier: "@lib/math", evidence: "unresolved", reason: "module-not-found" },
    ]);

    // Redirect the mapping and provide the target: the same importer content
    // must re-resolve because its tsconfig probe changed.
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, paths: { "@lib/*": ["./libs/*"] } },
    }));
    await writeFile(join(dir, "libs", "math.ts"), "export const lib = true;\n");
    const second = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.equal(second.freshImporters, 3, "the tsconfig probe changed for every importer that walks to it");
    assert.deepEqual(second.edges.filter((edge) => edge.importer === "main.ts"), [
      { importer: "main.ts", specifier: "@lib/math", target: "libs/math.ts", evidence: "typescript" },
    ]);
  } finally {
    await cleanup();
  }
});

test("removing an importer prunes its cached edges", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "extra.ts"), "import { multiply } from './math.ts';\nexport const extra = multiply(1, 1);\n");
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["./math.ts"]),
      "extra.ts": stub("extra.ts", "sha-extra-1", ["./math.ts"]),
      "math.ts": stub("math.ts", "sha-math-1", []),
    };
    const cache: FactsResolutionCache = new Map();
    resolveFactsModuleSnapshotIncremental(dir, files, cache);

    const withoutExtra: Record<string, FileFacts> = { "main.ts": files["main.ts"], "math.ts": files["math.ts"] };
    const second = resolveFactsModuleSnapshotIncremental(dir, withoutExtra, cache);
    assert.equal(second.edges.some((edge) => edge.importer === "extra.ts"), false);
    assert.equal(second.freshImporters, 0);

    const third = resolveFactsModuleSnapshotIncremental(dir, withoutExtra, cache);
    assert.equal(third.freshImporters, 0, "the pruned importer stays out of the cache");
  } finally {
    await cleanup();
  }
});

test("incremental edges are indistinguishable from a fresh resolution", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "libs", "deep.ts"), "export const deep = 1;\n");
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["./math.ts", "./libs/deep.ts", "node:node:crypto"]),
      "math.ts": stub("math.ts", "sha-math-1", ["./missing-file.ts"]),
      "libs/deep.ts": stub("libs/deep.ts", "sha-deep-1", ["../math.ts"]),
    };
    const cache: FactsResolutionCache = new Map();
    const incremental = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    const fresh = resolveFactsModuleSnapshot(dir, files);
    assert.deepEqual(incremental.edges, fresh.edges);
    assert.equal(incremental.consistent, fresh.consistent);

    // The cached snapshot keeps agreeing with a fresh resolution of the same tree.
    const again = resolveFactsModuleSnapshotIncremental(dir, files, cache);
    assert.deepEqual(again.edges, fresh.edges);
  } finally {
    await cleanup();
  }
});

test("the worker resolver keeps its resolution cache across requests", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const files: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-1", ["./math.ts"]),
      "math.ts": stub("math.ts", "sha-math-1", []),
    };
    const first = await resolveModuleSnapshotInWorker(dir, files);
    const second = await resolveModuleSnapshotInWorker(dir, files);
    assert.equal(second.freshImporters, 0, "the long-lived worker reuses its per-root cache");
    assert.deepEqual(second.edges, first.edges);
    const changed: Record<string, FileFacts> = {
      "main.ts": stub("main.ts", "sha-main-2", ["./math.ts", "node:node:crypto"]),
      "math.ts": files["math.ts"],
    };
    const third = await resolveModuleSnapshotInWorker(dir, changed);
    assert.equal(third.freshImporters, 1);
  } finally {
    await cleanup();
  }
});
