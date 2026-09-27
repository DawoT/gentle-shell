import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExecutionReceipts } from "../lib/facts/facts-receipts-extractor.ts";
import { FactsStore } from "../lib/facts/facts-store.ts";
import { FactsService } from "../lib/facts/facts-service.ts";

test("FactsStore rejects incompatible versions and malformed cached facts", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const store = new FactsStore(dir);
    await mkdir(join(dir, ".pi"));
    for (const data of [
      { version: "1.0.0", root: dir, updatedAt: 1, files: {} },
      { version: "1.2.0", root: dir, updatedAt: 1, files: { "bad.ts": null } },
      { version: "1.2.0", root: dir, updatedAt: 1, files: { "bad.ts": { path: "bad.ts", sha: "sha", symbols: [], imports: [123], exports: [] } } },
    ]) {
      await writeFile(join(dir, ".pi", "facts.json"), JSON.stringify(data));
      assert.equal(await store.load(), null);
    }
  } finally {
    await cleanup();
  }
});

test("FactsService reuses a valid disk cache without rewriting unchanged data", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    await new FactsService(dir).sync();
    const cache = join(dir, ".pi", "facts.json");
    const original = await readFile(cache, "utf8");
    await utimes(cache, new Date(1000), new Date(1000));
    const result = await new FactsService(dir).sync();
    assert.equal(result.cachedCount, 1);
    assert.equal(result.indexedCount, 0);
    assert.equal(await readFile(cache, "utf8"), original);
    assert.equal((await stat(cache)).mtimeMs, 1000);
  } finally {
    await cleanup();
  }
});

test("FactsService replaces cached paths after a staged rename", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const renamed = true;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "source"], { cwd: dir });
    const service = new FactsService(dir);
    await service.sync();
    execFileSync("git", ["mv", "source.ts", "renamed.ts"], { cwd: dir });

    await service.sync();
    assert.deepEqual(service.querySymbol("renamed").map((result) => result.file), ["renamed.ts"]);
  } finally {
    await cleanup();
  }
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-store-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("extractExecutionReceipts extracts package manager, scripts and dependencies", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const pkg = {
      name: "sample-project",
      scripts: {
        test: "node --test",
        build: "tsc",
        lint: "eslint .",
      },
      packageManager: "pnpm@11.1.1",
      dependencies: {
        express: "^4.18.2",
      },
      devDependencies: {
        typescript: "^5.0.0",
      },
    };
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    await writeFile(join(dir, "pnpm-lock.yaml"), "# lockfile");

    const receipts = await extractExecutionReceipts(dir);

    assert.ok(receipts);
    assert.equal(receipts.packageManager, "pnpm@11.1.1");
    assert.equal(receipts.testCommand, "pnpm test");
    assert.equal(receipts.buildCommand, "pnpm run build");
    assert.equal(receipts.lintCommand, "pnpm run lint");
    assert.equal(receipts.dependencies["express"], "^4.18.2");
    assert.equal(receipts.devDependencies["typescript"], "^5.0.0");
  } finally {
    await cleanup();
  }
});

test("extractExecutionReceipts returns safe defaults when package.json is missing", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const receipts = await extractExecutionReceipts(dir);
    assert.ok(receipts);
    assert.deepEqual(receipts.dependencies, {});
    assert.deepEqual(receipts.devDependencies, {});
  } finally {
    await cleanup();
  }
});

test("FactsStore saves and loads facts database atomically", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const store = new FactsStore(dir);
    const initial = await store.load();
    assert.equal(initial, null);

    const sampleData = {
      version: "1.2.0",
      root: dir,
      updatedAt: Date.now(),
      files: {
        "src/index.ts": {
          path: "src/index.ts",
          sha: "sha_abc",
          symbols: [{
            name: "app",
            kind: "constant" as const,
            signature: "const app = 1;",
            startLine: 1,
            endLine: 1,
            isExported: true,
          }],
          imports: [],
          exports: ["app"],
        },
      },
    };

    await store.save(sampleData);

    const loaded = await store.load();
    assert.ok(loaded);
    assert.equal(loaded.version, "1.2.0");
    assert.equal(loaded.files["src/index.ts"]?.symbols[0]?.name, "app");
  } finally {
    await cleanup();
  }
});

test("FactsService coordinates initial sync, incremental updates, and symbol queries", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    // 1. Setup repository files
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "test-app",
      scripts: { test: "node --test" },
    }));
    await writeFile(join(dir, "calc.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    await writeFile(join(dir, "app.ts"), "import { add } from './calc.ts';\nexport const result = add(1, 2);\n");

    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });

    // 2. Initial sync
    const service = new FactsService(dir);
    const firstSync = await service.sync();

    assert.equal(firstSync.indexedCount, 2);
    assert.equal(firstSync.cachedCount, 0);

    // 3. Query symbol
    const addSymbols = service.querySymbol("add");
    assert.equal(addSymbols.length, 1);
    assert.equal(addSymbols[0]?.symbol.name, "add");
    assert.equal(addSymbols[0]?.file, "calc.ts");
    assert.match(addSymbols[0]?.symbol.signature, /function add/);

    // 4. Query dependents
    const dependents = service.queryDependents("./calc.ts");
    assert.ok(dependents.includes("app.ts"));

    // 5. Re-sync without changes: should be 100% cache hits
    const secondSync = await service.sync();
    assert.equal(secondSync.indexedCount, 0);
    assert.equal(secondSync.cachedCount, 2);

    // 6. Incremental modify
    await writeFile(join(dir, "calc.ts"), "export function add(a: number, b: number, c: number = 0): number { return a + b + c; }\n");
    const thirdSync = await service.sync();
    assert.equal(thirdSync.indexedCount, 1);
    assert.equal(thirdSync.cachedCount, 1);

    const updatedAdd = service.querySymbol("add");
    assert.match(updatedAdd[0]?.symbol.signature, /c\?: number/);

    // 7. Verify prompt block
    const block = service.getSummaryPromptBlock();
    assert.ok(block.includes("[PROJECT GROUND TRUTH]"));
    assert.ok(block.includes("Indexed Files: 2"));
    assert.ok(block.includes("npm test"));
    assert.ok(block.includes("Declared Test Command"));
  } finally {
    await cleanup();
  }
});

test("FactsService resolves dependents by module path and exported symbol", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, "a"));
    await mkdir(join(dir, "b"));
    await writeFile(join(dir, "a", "util.ts"), "export function shared(): number { return 1; }\n");
    await writeFile(join(dir, "b", "util.ts"), "export function other(): number { return 2; }\n");
    await writeFile(join(dir, "a", "consumer.ts"), "import { shared } from './util.ts';\n");
    await writeFile(join(dir, "b", "consumer.ts"), "import { other } from './util.ts';\n");
    execFileSync("git", ["add", "."], { cwd: dir });

    const service = new FactsService(dir);
    await service.sync();

    assert.deepEqual(service.queryDependents("a/util.ts"), ["a/consumer.ts"]);
    assert.deepEqual(service.queryDependents("shared"), ["a/consumer.ts"]);
    assert.deepEqual(service.queryDependents("./util.ts"), []);
  } finally {
    await cleanup();
  }
});

test("FactsService accepts an unambiguous module basename from a nested directory", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "billing.ts"), "export const total = 1;\n");
    await writeFile(join(dir, "src", "checkout.ts"), "import { total } from './billing.ts';\n");
    execFileSync("git", ["add", "."], { cwd: dir });

    const service = new FactsService(dir);
    await service.sync();

    assert.deepEqual(service.queryDependents("./billing.ts"), ["src/checkout.ts"]);
  } finally {
    await cleanup();
  }
});

test("FactsService does not claim ground truth before a successful sync", () => {
  const service = new FactsService("/not-indexed");
  assert.equal(service.getSummaryPromptBlock(), "");
});

test("FactsService resolves JavaScript import specifiers to TypeScript sources", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "module.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "consumer.ts"), "import { value } from './module.js';\n");
    execFileSync("git", ["add", "."], { cwd: dir });

    const service = new FactsService(dir);
    await service.sync();

    assert.deepEqual(service.queryDependents("module.ts"), ["consumer.ts"]);
  } finally {
    await cleanup();
  }
});

test("FactsService resolves directory imports to indexed index files", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, "module"));
    await writeFile(join(dir, "module", "index.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "consumer.ts"), "import { value } from './module';\n");
    execFileSync("git", ["add", "."], { cwd: dir });

    const service = new FactsService(dir);
    await service.sync();

    assert.deepEqual(service.queryDependents("module/index.ts"), ["consumer.ts"]);
  } finally {
    await cleanup();
  }
});

test("FactsService uses the current package directory for command receipts", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, "packages", "app", "src"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10", scripts: { test: "root" } }));
    await writeFile(join(dir, "packages/app/package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
    const service = new FactsService(join(dir, "packages/app/src"));
    await service.sync();
    assert.equal(service.getReceipts()?.commandCwd, "packages/app");
    assert.equal(service.getReceipts()?.testCommand, undefined);
    assert.match(service.getSummaryPromptBlock(), /Command Directory: packages\/app/);
  } finally {
    await cleanup();
  }
});

test("overlapping syncs publish in request order without rolling back newer facts", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const oldValue = 1;\n");
    const service = new FactsService(dir);
    const older = service.sync();
    await entered.promise;
    await writeFile(join(dir, "source.ts"), "export const newValue = 2;\n");
    const newer = service.sync();
    // A later request must not complete while the earlier publication is held.
    const result = await Promise.race([
      newer.then(() => "published"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    release.resolve();
    await Promise.all([older, newer]);
    assert.equal(result, "waiting");
    assert.equal(service.querySymbol("newValue").length, 1);
    assert.equal(service.querySymbol("oldValue").length, 0);
    assert.equal((await new FactsStore(dir).load())?.files["source.ts"].symbols[0].name, "newValue");
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("cached hash describes the exact bytes parsed after the Git scan", async (t) => {
  const { dir, cleanup } = await createFixture();
  const load = FactsStore.prototype.load;
  try {
    await writeFile(join(dir, "source.ts"), "export const before = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    t.mock.method(FactsStore.prototype, "load", async function () {
      await writeFile(join(dir, "source.ts"), "export const after = 2;\n");
      return load.call(this);
    });
    const service = new FactsService(dir);
    await service.sync();
    const expected = execFileSync("git", ["hash-object", "--no-filters", "source.ts"], { cwd: dir, encoding: "utf8" }).trim();
    assert.equal(service.getDatabase()?.files["source.ts"].sha, expected);
    assert.equal(service.querySymbol("after").length, 1);
  } finally {
    await cleanup();
  }
});

test("cancelled sync leaves the last successful database untouched", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const before = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const snapshot = await readFile(join(dir, ".pi/facts.json"), "utf8");
    await writeFile(join(dir, "source.ts"), "export const after = 2;\n");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.sync(controller.signal), { name: "AbortError" });
    assert.equal(await readFile(join(dir, ".pi/facts.json"), "utf8"), snapshot);
    await service.sync();
    assert.equal(service.querySymbol("after").length, 1);
  } finally {
    await cleanup();
  }
});

test("FactsService rejects oversized sources without replacing the last good cache", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const source = join(dir, "large.ts");
    await writeFile(source, "export const small = true;\n");
    const service = new FactsService(dir);
    await service.sync();
    const cache = join(dir, ".pi", "facts.json");
    const previous = await readFile(cache, "utf8");
    await writeFile(source, "//" + "x".repeat(1024 * 1024));
    await assert.rejects(service.sync(), /byte limit/);
    assert.equal(await readFile(cache, "utf8"), previous);
  } finally {
    await cleanup();
  }
});

test("FactsService excludes unsupported files from scanning and cached counts", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "asset.bin"), Buffer.alloc(2 * 1024 * 1024));
    execFileSync("git", ["add", "."], { cwd: dir });
    const service = new FactsService(dir);
    await service.sync();
    const result = await service.sync();
    assert.equal(result.cachedCount, 1);
    assert.deepEqual(Object.keys(service.getDatabase()!.files), ["source.ts"]);
  } finally {
    await cleanup();
  }
});

test("independent services sharing a cache cannot publish an old snapshot last", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const oldValue = 1;\n");
    const service = new FactsService(dir);
    const older = service.sync();
    await entered.promise;
    await writeFile(join(dir, "source.ts"), "export const newValue = 2;\n");
    const secondService = new FactsService(dir);
    const newer = secondService.sync();
    // A later request must not complete while the earlier publication is held.
    const result = await Promise.race([
      newer.then(() => "published"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    release.resolve();
    await Promise.all([older, newer]);
    assert.equal(result, "waiting");
    assert.equal(secondService.querySymbol("newValue").length, 1);
    assert.equal(secondService.querySymbol("oldValue").length, 0);
    assert.equal((await new FactsStore(dir).load())?.files["source.ts"].symbols[0].name, "newValue");
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("cancelling a writer waiting for another instance preserves the owner's lock", async () => {
  const { dir, cleanup } = await createFixture();
  const store = new FactsStore(dir);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const owner = store.withWriterLock(async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    const controller = new AbortController();
    const waiter = new FactsService(dir).sync(controller.signal);
    setTimeout(() => controller.abort(), 40);
    await assert.rejects(waiter, { name: "AbortError" });
    assert.ok((await stat(join(dir, ".pi", "facts.lock"))).isDirectory());
  } finally {
    release.resolve();
    await owner;
    await cleanup();
  }
});

test("FactsStore refuses an oversized publication and preserves the existing cache", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const store = new FactsStore(dir);
    const database = { version: "1.2.0", root: dir, updatedAt: 1, files: {} };
    await store.save(database);
    const original = await readFile(join(dir, ".pi", "facts.json"), "utf8");
    await assert.rejects(store.save({ ...database, root: "x".repeat(64 * 1024 * 1024) }), /cache byte limit/);
    assert.equal(await readFile(join(dir, ".pi", "facts.json"), "utf8"), original);
  } finally {
    await cleanup();
  }
});

test("FactsStore refuses a valid but oversized disk cache", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, ".pi"));
    await writeFile(join(dir, ".pi", "facts.json"), JSON.stringify({
      version: "1.2.0",
      root: "x".repeat(64 * 1024 * 1024),
      updatedAt: 1,
      files: {},
    }));
    assert.ok(await new FactsStore(dir).load() === null);
  } finally {
    await cleanup();
  }
});

test("FactsService diagnostics retain the last successful sync and explain manifest failures", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const service = new FactsService(dir);
    await service.sync();
    const ready = service.getDiagnostics();
    assert.equal(ready.status, "ready");
    assert.ok(ready.lastSuccessfulSyncAt > 0);
    assert.ok(ready.lastDurationMs >= 0);
    await writeFile(join(dir, "package.json"), "{ broken");
    await assert.rejects(service.sync(), /Invalid/);
    const failed = service.getDiagnostics();
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.failure.code, "manifest");
    assert.equal(failed.lastSuccessfulSyncAt, ready.lastSuccessfulSyncAt);
    await rm(join(dir, "package.json"));
    await service.sync();
    assert.equal(service.getDiagnostics().status, "ready");
    assert.equal(service.getDiagnostics().failure, undefined);
  } finally {
    await cleanup();
  }
});

test("FactsStore distinguishes missing, incompatible, corrupt and reusable disk caches", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const store = new FactsStore(dir);
    await store.load();
    assert.equal(store.getLoadState(), "missing");
    await mkdir(join(dir, ".pi"), { recursive: true });
    const cache = join(dir, ".pi", "facts.json");
    await writeFile(cache, JSON.stringify({ version: "0.0.0" }));
    await store.load();
    assert.equal(store.getLoadState(), "incompatible");
    await writeFile(cache, "{ broken");
    await store.load();
    assert.equal(store.getLoadState(), "invalid");
    await store.save({ version: "1.2.0", root: dir, updatedAt: 1, files: {} });
    await store.load();
    assert.equal(store.getLoadState(), "hit");
  } finally {
    await cleanup();
  }
});

test("FactsStore does not publish after caller cancellation", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const store = new FactsStore(dir);
    const database = { version: "1.2.0", root: dir, updatedAt: 1, files: {} };
    await store.save(database);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(store.save({ ...database, updatedAt: 2 }, controller.signal), { name: "AbortError" });
    assert.equal((await store.load())?.updatedAt, 1);
  } finally {
    await cleanup();
  }
});

test("a long-lived service reconciles disk changes from another writer after a source reversion", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const path = join(dir, "source.ts");
    await writeFile(path, "export const original = 1;\n");
    const first = new FactsService(dir);
    await first.sync();
    await writeFile(path, "export const changed = 2;\n");
    await new FactsService(dir).sync();
    await writeFile(path, "export const original = 1;\n");
    await first.sync();
    assert.equal((await new FactsStore(dir).load())?.files["source.ts"].symbols[0].name, "original");
  } finally {
    await cleanup();
  }
});

test("FactsService resolves configured aliases and explains transitive impact", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }));
    await writeFile(join(dir, "src", "core.ts"), "export const compute = 1;\n");
    await writeFile(join(dir, "src", "middle.ts"), "export { compute } from '@app/core';\n");
    await writeFile(join(dir, "src", "consumer.ts"), "import { compute } from '@app/middle';\n");
    const service = new FactsService(dir);
    await service.sync();
    assert.deepEqual(service.queryDependents("src/core.ts"), ["src/middle.ts"]);
    assert.deepEqual(service.queryDependents("src/core.ts", { transitive: true }), ["src/consumer.ts", "src/middle.ts"]);
    const impact = service.queryDependencyEvidence("src/core.ts", { transitive: true });
    assert.equal(impact.find((item) => item.file === "src/consumer.ts")?.depth, 2);
    assert.equal(impact.find((item) => item.file === "src/middle.ts")?.evidence, "typescript");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@app/*": ["missing/*"] } } }));
    await service.sync();
    assert.deepEqual(service.queryDependents("src/core.ts"), []);
    assert.ok(service.getResolutionEdges().some((edge) => edge.evidence === "unresolved"));
  } finally {
    await cleanup();
  }
});

test("FactsService indexes Python and Go declarations alongside TypeScript", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "api.py"), "def python_api(value: int) -> int:\n  return value\n");
    await writeFile(join(dir, "api.go"), "package api\nfunc GoAPI(value int) int { return value }\n");
    const service = new FactsService(dir);
    await service.sync();
    assert.equal(service.querySymbol("python_api").length, 1);
    assert.equal(service.querySymbol("GoAPI").length, 1);
    assert.equal(service.getDatabase()?.files["api.py"].language, "python");
    assert.equal(service.getDatabase()?.files["api.go"].language, "go");
  } finally {
    await cleanup();
  }
});

test("Facts diagnostics explain native parser failures", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "broken.py"), "def (");
    const service = new FactsService(dir);
    await assert.rejects(service.sync());
    assert.equal(service.getDiagnostics().failure?.code, "parser");
    assert.match(service.getDiagnostics().failure?.message ?? "", /python|Python/);
  } finally {
    await cleanup();
  }
});

test("module metadata budget failure preserves cache and reports resolution phase", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "import './other';\nexport const value = 1;\n");
    await writeFile(join(dir, "other.ts"), "export const other = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const prior = await readFile(join(dir, ".pi", "facts.json"), "utf8");
    await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }));
    await assert.rejects(service.sync(), /metadata.*limit/i);
    assert.equal(service.getDiagnostics().failure?.code, "module_resolution");
    assert.equal(await readFile(join(dir, ".pi", "facts.json"), "utf8"), prior);
  } finally {
    await cleanup();
  }
});

test("FactsService retries when a cached source changes after the initial scan", async (t) => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const before = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const load = FactsStore.prototype.load;
    let changed = false;
    t.mock.method(FactsStore.prototype, "load", async function (signal?: AbortSignal) {
      const database = await load.call(this, signal);
      if (!changed) {
        changed = true;
        await writeFile(join(dir, "source.ts"), "export const after = 2;\n");
      }
      return database;
    });
    await service.sync();
    assert.equal(service.querySymbol("before").length, 0);
    assert.equal(service.querySymbol("after").length, 1);
    const persisted = await new FactsStore(dir).load();
    assert.equal(persisted.files["source.ts"].symbols[0].name, "after");
  } finally {
    t.mock.restoreAll();
    await cleanup();
  }
});

test("FactsService preserves its published cache when sources never stabilize", async (t) => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const stable = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const cache = join(dir, ".pi", "facts.json");
    const original = await readFile(cache, "utf8");
    const load = FactsStore.prototype.load;
    let changes = 0;
    t.mock.method(FactsStore.prototype, "load", async function (signal?: AbortSignal) {
      const database = await load.call(this, signal);
      changes++;
      // Changing an untouched file forces the validation to detect stale reuse.
      await writeFile(join(dir, `added-${changes}.ts`), `export const added${changes} = 1;\n`);
      return database;
    });
    await assert.rejects(service.sync(), /changed during analysis/);
    assert.equal(changes, 3);
    assert.equal(await readFile(cache, "utf8"), original);
    assert.equal(service.querySymbol("stable").length, 1);
    assert.equal(service.getDiagnostics().failure?.code, "snapshot_validation");
  } finally {
    t.mock.restoreAll();
    await cleanup();
  }
});

test("FactsService validates raw source bytes when Git normalizes line endings", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: dir });
    await writeFile(join(dir, "source.py"), "def normalized():\r\n  return 1\r\n");
    execFileSync("git", ["add", "source.py"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "normalized source"], { cwd: dir });
    const service = new FactsService(dir);
    await service.sync();
    assert.equal(service.querySymbol("normalized").length, 1);
    await service.sync();
    assert.equal(service.getDiagnostics().status, "ready");
  } finally {
    await cleanup();
  }
});

test("Facts persists resolved edges when configuration changes without source edits", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "import { value } from 'alias';\n");
    await writeFile(join(dir, "one.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "two.ts"), "export const value = 2;\n");
    const config = (target: string) => JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { alias: [target] } } });
    await writeFile(join(dir, "tsconfig.json"), config("./one.ts"));
    const service = new FactsService(dir);
    await service.sync();
    const pointer = JSON.parse(await readFile(join(dir, ".pi", "facts.json"), "utf8"));
    assert.equal(service.getGeneration(), pointer.generation);
    assert.equal((await new FactsStore(dir).load())!.moduleEdges?.[0].target, "one.ts");
    await writeFile(join(dir, "tsconfig.json"), config("./two.ts"));
    await service.sync();
    const store = new FactsStore(dir);
    assert.equal((await store.load())!.moduleEdges?.[0].target, "two.ts");
    assert.equal((await store.loadGeneration(pointer.generation)).moduleEdges?.[0].target, "one.ts");
  } finally {
    await cleanup();
  }
});

test("unchanged refresh does not revisit loaded symbol payloads to compare publications", async (t) => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const stable = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    const generation = service.getGeneration();
    const load = FactsStore.prototype.load;
    let visits = 0;
    t.mock.method(FactsStore.prototype, "load", async function (signal?: AbortSignal) {
      const database: Awaited<ReturnType<typeof load>> = await load.call(this, signal);
      for (const file of Object.values(database!.files)) {
        const symbols = file.symbols;
        Object.defineProperty(file, "symbols", {
          enumerable: true,
          get() {
            visits++;
            return symbols;
          },
        });
      }
      return database;
    });
    await service.sync();
    assert.equal(service.getGeneration(), generation);
    assert.equal(visits, 0, "unchanged file identities should avoid reserializing their symbol payloads");
  } finally {
    t.mock.restoreAll();
    await cleanup();
  }
});

test("refresh retries when resolver configuration changes after worker resolution", async (t) => {
  const { Worker } = await import("node:worker_threads");
  const { writeFileSync } = await import("node:fs");
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "main.ts"), 'import { value } from "@target";');
    await writeFile(join(dir, "a.ts"), 'export const value = 1;');
    await writeFile(join(dir, "b.ts"), 'export const value = 2;');
    const config = (target: string) => JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@target": [target] } } });
    await writeFile(join(dir, "tsconfig.json"), config("a.ts"));
    const emit = Worker.prototype.emit;
    let edited = false;
    t.mock.method(Worker.prototype, "emit", function (event: string, ...args: any[]) {
      if (!edited && event === "message" && args[0]?.facts?.inputs) {
        edited = true;
        writeFileSync(join(dir, "tsconfig.json"), config("b.ts"));
      }
      return emit.call(this, event, ...args);
    });
    const service = new FactsService(dir);
    await service.sync();
    assert.equal(edited, true);
    assert.equal(service.getResolutionEdges().find((edge) => edge.specifier === "@target")?.target, "b.ts");
  } finally {
    await cleanup();
  }
});

test("continuous resolver metadata drift preserves the last publication", async (t) => {
  const { Worker } = await import("node:worker_threads");
  const { writeFileSync } = await import("node:fs");
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "main.ts"), 'export const value = 1;');
    await writeFile(join(dir, "tsconfig.json"), '{}');
    const service = new FactsService(dir);
    await service.sync();
    const before = await readFile(join(dir, ".pi/facts.json"), "utf8");
    const generation = service.getGeneration();
    const emit = Worker.prototype.emit;
    let attempts = 0;
    t.mock.method(Worker.prototype, "emit", function (event: string, ...args: any[]) {
      if (event === "message" && args[0]?.facts?.inputs) {
        writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: ++attempts % 2 === 0 } }));
      }
      return emit.call(this, event, ...args);
    });
    await assert.rejects(service.sync(), /changed|snapshot/i);
    assert.equal(attempts, 3);
    assert.equal(service.getDiagnostics().failure?.code, "snapshot_validation");
    assert.equal(service.getGeneration(), generation);
    assert.equal(await readFile(join(dir, ".pi/facts.json"), "utf8"), before);
  } finally {
    await cleanup();
  }
});
