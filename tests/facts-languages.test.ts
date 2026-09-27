import assert from "node:assert/strict";
import test from "node:test";
import { extractSourceFacts, factsLanguage } from "../lib/facts/facts-languages.ts";

test("language routing covers Python, Go and JavaScript without guessing unknown files", () => {
  assert.equal(factsLanguage("pkg/main.py"), "python");
  assert.equal(factsLanguage("pkg/main.go"), "go");
  assert.equal(factsLanguage("index.mts"), "typescript");
  assert.equal(factsLanguage("index.cts"), "typescript");
  assert.equal(factsLanguage("notes.md"), undefined);
});

test("language registry preserves TypeScript extraction through lazy loading", async () => {
  const facts = await extractSourceFacts("index.ts", "export const value = 1;", "hash");
  assert.equal(facts.language, "typescript");
  assert.equal(facts.symbols[0].name, "value");
});

test("language registry rejects unsupported input and respects cancellation", async () => {
  await assert.rejects(extractSourceFacts("notes.md", "# docs", "hash"), /Unsupported/);
  const signal = AbortSignal.abort();
  await assert.rejects(extractSourceFacts("index.ts", "", "hash", signal), { name: "AbortError" });
});

test("Python registry works from an isolated copy with no TypeScript installation", async () => {
  const { mkdtemp, cp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "facts-no-typescript-"));
  try {
    await cp(new URL("../lib/facts/", import.meta.url), join(directory, "facts"), { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import { extractSourceFacts } from './facts/facts-languages.ts';
      const facts = await extractSourceFacts('api.py', 'def available():\\n  pass\\n', 'hash');
      console.log(facts.symbols[0].name);
    `], { cwd: directory, encoding: "utf8" });
    assert.equal(output.trim(), "available");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TypeScript parsing can be cancelled while processing a dense source", async () => {
  await extractSourceFacts("warm.ts", "export const warm = 1;", "warm");
  const source = Array.from({ length: 18000 }, (_, index) => `export interface I${index} { value: string; }`).join("\n");
  const controller = new AbortController();
  const pending = extractSourceFacts("dense.ts", source, "dense", controller.signal);
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(pending, { name: "AbortError" });
    const next = await extractSourceFacts("after.ts", "export const recovered = 1;", "after");
    assert.equal(next.symbols[0].name, "recovered");
  } finally {
    clearTimeout(timer);
  }
});

test("a queued TypeScript request cancels before an active parse finishes", async () => {
  await extractSourceFacts("warm.ts", "export const warm = 1;", "warm");
  const source = Array.from({ length: 18000 }, (_, index) => `export interface I${index} { value: string; }`).join("\n");
  let activeFinished = false;
  const active = extractSourceFacts("dense.ts", source, "dense").finally(() => { activeFinished = true; });
  const controller = new AbortController();
  const queued = extractSourceFacts("queued.ts", "export const queued = 1;", "queued", controller.signal);
  setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(queued, { name: "AbortError" });
    assert.equal(activeFinished, false);
  } finally {
    await active;
  }
});
