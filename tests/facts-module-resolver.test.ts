import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveFactsModules } from "../lib/facts/facts-module-resolver.ts";
import type { FileFacts } from "../lib/facts/facts-types.ts";

async function fixture(t: test.TestContext, entries: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "facts-resolver-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(entries)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

function facts(path: string, imports: string[] = []): FileFacts {
  return { path, sha: "test", symbols: [], imports, exports: [] };
}

test("resolves tsconfig aliases against indexed local sources", async (t) => {
  const root = await fixture(t, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
    "src/main.ts": "",
    "src/util.ts": "",
  });
  assert.deepEqual(resolveFactsModules(root, {
    "src/main.ts": facts("src/main.ts", ["@app/util"]),
    "src/util.ts": facts("src/util.ts"),
  }), [{ importer: "src/main.ts", specifier: "@app/util", target: "src/util.ts", evidence: "typescript" }]);
});

test("uses the nearest package config including inherited aliases in a referenced monorepo", async (t) => {
  const root = await fixture(t, {
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./packages/app" }] }),
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@shared/*": ["packages/shared/*"] } } }),
    "packages/app/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.base.json" }),
    "packages/app/main.ts": "",
    "packages/shared/util.ts": "",
  });
  assert.deepEqual(resolveFactsModules(root, {
    "packages/app/main.ts": facts("packages/app/main.ts", ["@shared/util"]),
    "packages/shared/util.ts": facts("packages/shared/util.ts"),
  }), [{ importer: "packages/app/main.ts", specifier: "@shared/util", target: "packages/shared/util.ts", evidence: "typescript" }]);
});

test("reports existing but unindexed destinations without claiming a local edge", async (t) => {
  const root = await fixture(t, { "main.ts": "", "hidden.ts": "" });
  const [edge] = resolveFactsModules(root, { "main.ts": facts("main.ts", ["./hidden"]) });
  assert.equal(edge.evidence, "unresolved");
  assert.equal(edge.reason, "outside-index");
  assert.equal(edge.target, undefined);
});

test("uses a named project reference config for a source in that project", async (t) => {
  const root = await fixture(t, {
    "tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./app/tsconfig.app.json" }] }),
    "app/tsconfig.app.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@local/*": ["src/*"] } } }),
    "app/src/main.ts": "",
    "app/src/util.ts": "",
  });
  assert.deepEqual(resolveFactsModules(root, {
    "app/src/main.ts": facts("app/src/main.ts", ["@local/util"]),
    "app/src/util.ts": facts("app/src/util.ts"),
  }), [{ importer: "app/src/main.ts", specifier: "@local/util", target: "app/src/util.ts", evidence: "typescript" }]);
});

test("keeps absent modules unresolved and does not guess with malformed config", async (t) => {
  const root = await fixture(t, { "main.ts": "", "tsconfig.json": "{broken" });
  assert.equal(resolveFactsModules(root, { "main.ts": facts("main.ts", ["./missing"]) })[0].reason, "invalid-tsconfig");
  await rm(join(root, "tsconfig.json"));
  assert.equal(resolveFactsModules(root, { "main.ts": facts("main.ts", ["./missing"]) })[0].reason, "module-not-found");
});

test("no-tsconfig projects resolve relative modules with explicitly labelled defaults", async (t) => {
  const root = await fixture(t, { "main.js": "", "util.js": "" });
  const [edge] = resolveFactsModules(root, {
    "main.js": facts("main.js", ["./util.js"]),
    "util.js": facts("util.js"),
  });
  assert.equal(edge.target, "util.js");
  assert.equal(edge.reason, "default-compiler-options");
});

test("resolver bounds metadata reads instead of consuming oversized tsconfig", async (t) => {
  const root = await fixture(t, {
    "tsconfig.json": JSON.stringify({ padding: "x".repeat(1024 * 1024 + 1) }),
    "main.ts": "",
    "util.ts": "",
  });
  assert.throws(() => resolveFactsModules(root, {
    "main.ts": facts("main.ts", ["./util"]),
    "util.ts": facts("util.ts"),
  }), /metadata.*limit/i);
});

test("confined resolution refuses configuration inherited from outside the snapshot", async (t) => {
  const external = await fixture(t, {});
  const root = await fixture(t, {
    "tsconfig.json": JSON.stringify({ extends: join(external, "config.json") }),
    "source.ts": "",
    "target.ts": "",
  });
  await writeFile(join(external, "config.json"), JSON.stringify({ compilerOptions: { baseUrl: root, paths: { alias: ["./target.ts"] } } }));
  const edges = resolveFactsModules(root, {
    "source.ts": facts("source.ts", ["alias"]),
    "target.ts": facts("target.ts"),
  }, { confined: true });
  assert.equal(edges[0].evidence, "unresolved");
  assert.equal(edges[0].reason, "invalid-tsconfig");
});

test("resolution read-set detects metadata bytes and previously absent config", async (t) => {
  const api = await import("../lib/facts/facts-module-resolver.ts");
  const root = await fixture(t, {
    "main.ts": "", "util.ts": "",
    "tsconfig.json": '{"compilerOptions":{"baseUrl":"."}}',
  });
  const snapshot = api.resolveFactsModuleSnapshot(root, { "main.ts": facts("main.ts", ["./util"]), "util.ts": facts("util.ts") });
  assert.equal(api.validateFactsModuleSnapshot(snapshot), true);
  await writeFile(join(root, "tsconfig.json"), '{"compilerOptions":{"baseUrl":"."}}\n');
  assert.equal(api.validateFactsModuleSnapshot(snapshot), false);
  await rm(join(root, "tsconfig.json"));
  const absent = api.resolveFactsModuleSnapshot(root, { "main.ts": facts("main.ts", ["./util"]) });
  assert.equal(api.validateFactsModuleSnapshot(absent), true);
  await writeFile(join(root, "tsconfig.json"), '{}');
  assert.equal(api.validateFactsModuleSnapshot(absent), false);
});

test("resolution validates inherited external config and package metadata", async (t) => {
  const api = await import("../lib/facts/facts-module-resolver.ts");
  const parent = await fixture(t, {
    "base.json": '{"compilerOptions":{"strict":true}}',
    "workspace/tsconfig.json": '{"extends":"../base.json"}',
    "workspace/main.ts": "",
    "workspace/node_modules/pkg/package.json": '{"types":"a.d.ts"}',
    "workspace/node_modules/pkg/a.d.ts": "",
    "workspace/node_modules/pkg/b.d.ts": "",
  });
  const root = join(parent, "workspace");
  const files = { "main.ts": facts("main.ts", ["pkg"]) };
  const first = api.resolveFactsModuleSnapshot(root, files);
  assert.equal(api.validateFactsModuleSnapshot(first), true);
  await writeFile(join(parent, "base.json"), '{"compilerOptions":{"strict":false}}');
  assert.equal(api.validateFactsModuleSnapshot(first), false);
  const second = api.resolveFactsModuleSnapshot(root, files);
  await writeFile(join(root, "node_modules/pkg/package.json"), '{"types":"b.d.ts"}');
  assert.equal(api.validateFactsModuleSnapshot(second), false);
});

test("intra-resolution probe drift produces a retryable invalid snapshot", async (t) => {
  const api = await import("../lib/facts/facts-module-resolver.ts");
  const { default: ts } = await import("typescript");
  const root = await fixture(t, { "one.ts": "", "two.ts": "", "util.ts": "" });
  const original = ts.sys.fileExists;
  let probes = 0;
  t.mock.method(ts.sys, "fileExists", (path: string) => {
    if (path === join(root, "util.ts") && ++probes > 1) return false;
    return original(path);
  });
  const snapshot = api.resolveFactsModuleSnapshot(root, {
    "one.ts": facts("one.ts", ["./util"]),
    "two.ts": facts("two.ts", ["./util"]),
  });
  assert.ok(probes > 1);
  assert.equal(snapshot.consistent, false);
  assert.equal(api.validateFactsModuleSnapshot(snapshot), false);
});
