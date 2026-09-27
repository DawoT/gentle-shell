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
