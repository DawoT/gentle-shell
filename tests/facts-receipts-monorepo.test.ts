import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractExecutionReceipts } from "../lib/facts/facts-receipts-extractor.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "facts-monorepo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages", "web", "src"), { recursive: true });
  return root;
}

test("receipts select the nearest package and inherit the root manager", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@10.0.0",
    scripts: { test: "root-tests", lint: "root-lint" },
  }));
  await writeFile(join(root, "packages/web/package.json"), JSON.stringify({
    scripts: { test: "vitest", build: "vite build" },
    dependencies: { react: "^19.0.0" },
  }));
  const result = await extractExecutionReceipts(root, join(root, "packages/web/src"));
  assert.equal(result.commandCwd, "packages/web");
  assert.equal(result.packagePath, "packages/web/package.json");
  assert.equal(result.packageManager, "pnpm@10.0.0");
  assert.equal(result.testCommand, "pnpm test");
  assert.equal(result.buildCommand, "pnpm run build");
  assert.equal(result.lintCommand, undefined);
  assert.deepEqual(result.dependencies, { react: "^19.0.0" });
});

test("receipts discover the ancestor lockfile without a root manifest", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "yarn.lock"), "");
  await writeFile(join(root, "packages/web/package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
  const result = await extractExecutionReceipts(root, join(root, "packages/web/src"));
  assert.equal(result.testCommand, "yarn test");
  assert.equal(result.packageManager, "yarn");
});

test("receipts annotate root commands and never walk above the repository", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const result = await extractExecutionReceipts(root);
  assert.equal(result.commandCwd, ".");
  assert.equal(result.packagePath, "package.json");
  await assert.rejects(extractExecutionReceipts(root, join(root, "..")), /outside|root/i);
});

for (const [name, content] of [
  ["malformed JSON", "{"],
  ["non-object manifest", "[]"],
  ["invalid script", JSON.stringify({ scripts: { test: true } })],
  ["invalid dependency", JSON.stringify({ dependencies: { react: 19 } })],
  ["unsupported manager", JSON.stringify({ packageManager: "custom@1" })],
  ["oversized manifest", " ".repeat(1024 * 1024 + 1)],
]) {
  test(`receipts reject ${name} with package context`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, "package.json"), content);
    await assert.rejects(extractExecutionReceipts(root), /package\.json/);
  });
}

test("receipts respect cancellation", async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractExecutionReceipts(root, root, { signal: controller.signal }), { name: "AbortError" });
});
