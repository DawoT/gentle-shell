import assert from "node:assert/strict";
import test from "node:test";
import { displayLanguage, factsLanguage } from "../lib/facts/facts-languages.ts";
import { symbolRow } from "../lib/facts/facts-response.ts";

test("display labels stay independent from extraction routing", () => {
  assert.equal(factsLanguage("src/app.mjs"), "typescript"); // routing buckets the JS family under the TS extractor
  assert.equal(displayLanguage("src/app.mjs"), "javascript"); // display reports the file's real language
});

test("displayLanguage derives JavaScript from script and JSX extensions", () => {
  assert.equal(displayLanguage("src/app.mjs"), "javascript");
  assert.equal(displayLanguage("src/app.js"), "javascript");
  assert.equal(displayLanguage("src/app.cjs"), "javascript");
  assert.equal(displayLanguage("src/app.jsx"), "javascript");
});

test("displayLanguage derives TypeScript from TypeScript extensions", () => {
  assert.equal(displayLanguage("src/app.ts"), "typescript");
  assert.equal(displayLanguage("src/app.tsx"), "typescript");
  assert.equal(displayLanguage("src/app.mts"), "typescript");
  assert.equal(displayLanguage("src/app.cts"), "typescript");
});

test("displayLanguage derives Python and Go from their extensions", () => {
  assert.equal(displayLanguage("src/app.py"), "python");
  assert.equal(displayLanguage("cmd/main.go"), "go");
});

test("displayLanguage handles uppercase extensions case-insensitively", () => {
  assert.equal(displayLanguage("src/app.MJS"), "javascript");
  assert.equal(displayLanguage("src/app.TS"), "typescript");
  assert.equal(displayLanguage("src/app.PY"), "python");
});

test("displayLanguage reports unknown for missing or unrecognized extensions", () => {
  assert.equal(displayLanguage("Makefile"), "unknown");
  assert.equal(displayLanguage("src/README"), "unknown");
  assert.equal(displayLanguage("src/app.md"), "unknown");
});

test("symbolRow renders the full line range with the signature", () => {
  assert.equal(
    symbolRow("src/app.ts", { startLine: 3, endLine: 9, signature: "function app(): void" }),
    "src/app.ts:3-9\nfunction app(): void",
  );
});

test("symbolRow renders the start line only when endLine is missing or invalid", () => {
  const missing = { startLine: 5, endLine: undefined, signature: "const value = 1;" } as any;
  assert.equal(symbolRow("src/app.ts", missing), "src/app.ts:5\nconst value = 1;");
  const invalid = { startLine: 5, endLine: Number.NaN, signature: "const value = 1;" } as any;
  assert.equal(symbolRow("src/app.ts", invalid), "src/app.ts:5\nconst value = 1;");
  const inverted = { startLine: 7, endLine: 3, signature: "class Stale {}" } as any;
  assert.equal(symbolRow("src/app.ts", inverted), "src/app.ts:7\nclass Stale {}");
});

test("symbolRow preserves the trailing empty line for empty signatures", () => {
  assert.equal(symbolRow("src/app.ts", { startLine: 2, endLine: 4, signature: "" }), "src/app.ts:2-4\n");
});
