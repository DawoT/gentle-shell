import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGoFacts } from "../lib/facts/facts-go-extractor.ts";

test("Go extracts generic declarations, receivers, imports and documentation without bodies", async () => {
  const facts = await extractGoFacts("pkg/store.go", `package store
import (
  "context"
  alias "example.com/store/model"
)
// Store holds records.
type Store[T any] struct { Value T }
type Reader interface { Read(context.Context) error }
type ID = string
const Limit = 8
var current ID
// Load returns a record.
func (s *Store[T]) Load(ctx context.Context) (T, error) { panic("never execute") }
func Map[T any](value T) T { return value }
func hidden() {}
`, "blob");
  assert.equal(facts.sha, "blob");
  assert.deepEqual(facts.imports, ["context", "example.com/store/model"]);
  assert.equal(facts.symbols.find((symbol) => symbol.name === "Store")?.kind, "class");
  assert.equal(facts.symbols.find((symbol) => symbol.name === "Reader")?.kind, "interface");
  assert.equal(facts.symbols.find((symbol) => symbol.name === "ID")?.kind, "typeAlias");
  assert.equal(facts.symbols.find((symbol) => symbol.name === "Limit")?.kind, "constant");
  const method = facts.symbols.find((symbol) => symbol.name === "Store.Load");
  assert.equal(method?.signature, "func (s *Store[T]) Load(ctx context.Context) (T, error)");
  assert.equal(method?.docstring, "Load returns a record.");
  assert.equal(method?.startLine, 13);
  assert.equal(method?.endLine, 13);
  assert.equal(facts.symbols.find((symbol) => symbol.name === "Map")?.signature, "func Map[T any](value T) T");
  assert.ok(facts.exports.includes("Store.Load"));
  assert.ok(!facts.exports.includes("hidden"));
  assert.ok(!JSON.stringify(facts).includes("never execute"));
});

test("Go rejects malformed syntax explicitly", async () => {
  await assert.rejects(extractGoFacts("bad.go", "package x\nfunc broken(", "blob"), /Go.*pars|pars.*Go/i);
});

test("Go aborts before starting and bounds source input", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractGoFacts("x.go", "package x", "blob", controller.signal), { name: "AbortError" });
  await assert.rejects(extractGoFacts("x.go", "x".repeat(1024 * 1024 + 1), "blob"), /limit/i);
});

test("Go extraction never executes init functions or resolves imported modules", async () => {
  const facts = await extractGoFacts("main.go", `package main
import _ "invalid.example/never-download-this"
func init() { panic("repository source executed") }
func main() {}
`, "blob");
  assert.deepEqual(facts.imports, ["invalid.example/never-download-this"]);
  assert.equal(facts.symbols.length, 2);
});

test("cancelling the first Go caller preserves another caller's shared build", async () => {
  const { extractGoFacts: extract } = await import(new URL("../lib/facts/facts-go-extractor.ts?independent-build", import.meta.url).href);
  const controller = new AbortController();
  const first = extract("first.go", "package first", "first", controller.signal);
  const second = extract("second.go", "package second\nfunc Available() {}", "second");
  const secondResult = second.then((facts: Awaited<ReturnType<typeof extractGoFacts>>) => ({ facts }), (error: unknown) => ({ error }));
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  const result = await secondResult;
  assert.ok("facts" in result, "independent caller must not inherit cancellation");
  assert.equal(result.facts.symbols[0].name, "Available");
});

test("a waiting Go caller cancels before the shared build finishes", async () => {
  const { extractGoFacts: extract } = await import(new URL("../lib/facts/facts-go-extractor.ts?waiting-build", import.meta.url).href);
  let finished = false;
  const first = extract("first.go", "package first", "first").finally(() => {
    finished = true;
  });
  const controller = new AbortController();
  const second = extract("second.go", "package second", "second", controller.signal);
  const rejected = assert.rejects(second, { name: "AbortError" });
  controller.abort();
  try {
    const promptly = await Promise.race([
      rejected.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(promptly, true, "cancellation must not await compiler IO");
    await rejected;
    assert.equal(finished, false);
  } finally {
    await first;
  }
});
