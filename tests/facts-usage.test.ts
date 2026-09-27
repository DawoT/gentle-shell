import assert from "node:assert/strict";
import test from "node:test";
import { FactsUsage } from "../lib/facts/facts-usage.ts";

test("usage counts real outcomes and never credits a repeated file version twice", () => {
  const usage = new FactsUsage();
  const source = { path: "a.ts", sha: "one", sourceBytes: 1000 };
  usage.record({ status: "ready", returned: 1, text: "x".repeat(100), sources: [source, source] });
  usage.record({ status: "snapshot", returned: 1, text: "x".repeat(100), sources: [source] });
  usage.record({ status: "ready", returned: 0, text: "empty" });
  usage.record({ status: "unavailable", returned: 0, text: "offline" });
  usage.record({ status: "error", returned: 0, text: "" });
  const result = usage.snapshot();
  assert.equal(result.queries, 5);
  assert.equal(result.answered, 2);
  assert.equal(result.empty, 1);
  assert.equal(result.unavailable, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.cursorPages, 1);
  assert.equal(result.responseBytes, 212);
  assert.equal(result.baselineBytes, 1000);
  assert.equal(result.estimatedReductionTokens, 197);
});

test("usage exposes unknown baseline and negative estimates without claiming monetary savings", () => {
  const usage = new FactsUsage();
  usage.record({ status: "ready", returned: 1, text: "long response" });
  assert.equal(usage.snapshot().estimatedReductionTokens, null);
  usage.record({ status: "ready", returned: 1, text: "x".repeat(100), sources: [{ path: "a", sha: "1", sourceBytes: 4 }] });
  assert.ok(usage.snapshot().estimatedReductionTokens! < 0);
  assert.equal("costSaved" in usage.snapshot(), false);
});

test("usage caps retained version identities without double credit or unbounded growth", () => {
  const usage = new FactsUsage();
  const sources = Array.from({ length: 4100 }, (_, index) => ({ path: `${index}.ts`, sha: "1", sourceBytes: 10 }));
  usage.record({ status: "ready", returned: 4100, text: "", sources });
  usage.record({ status: "ready", returned: 1, text: "", sources: [sources[0]] });
  assert.equal(usage.snapshot().baselineFiles, 4096);
  assert.equal(usage.snapshot().baselineBytes, 40960);
  assert.equal(usage.snapshot().baselineCapped, true);
});

test("source sizes measure UTF-8 parser input and schema accepts legacy but rejects invalid sizes", async () => {
  const { extractSourceFacts } = await import("../lib/facts/facts-languages.ts");
  const { isFactsDatabase } = await import("../lib/facts/facts-schema.ts");
  const source = 'export const greeting = "こんにちは";';
  const facts = await extractSourceFacts("a.ts", source, "sha");
  assert.equal(facts.sourceBytes, Buffer.byteLength(source));
  const database = { version: "1.2.0", root: "/repo", updatedAt: 1, files: { "a.ts": facts } };
  assert.equal(isFactsDatabase(database), true);
  for (const invalid of [-1, 1.5, "100", Infinity]) {
    assert.equal(isFactsDatabase({ ...database, files: { "a.ts": { ...facts, sourceBytes: invalid } } }), false);
  }
  const { sourceBytes, ...legacy } = facts;
  assert.equal(isFactsDatabase({ ...database, files: { "a.ts": legacy } }), true);
});
