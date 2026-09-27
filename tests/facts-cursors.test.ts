import assert from "node:assert/strict";
import test from "node:test";
import { FactsCursors } from "../lib/facts/facts-cursors.ts";

test("cursor continuation preserves results when the source array changes", () => {
  const cursors = new FactsCursors();
  const rows = ["a", "b", "c"];
  const first = cursors.start("query:Shared", "generation-1", rows, { limit: 1 });
  rows.splice(1, 1, "new");
  const second = cursors.resume(first.details.nextCursor!, "query:Shared", { limit: 1 });
  assert.match(second.text, /^b\n\nSnapshot generation-1/);
  assert.equal(second.details.generation, "generation-1");
  const last = cursors.resume(second.details.nextCursor!, "query:Shared", { limit: 1 });
  assert.equal(last.text, "c");
  assert.equal(last.details.nextCursor, null);
});

test("cursors reject different queries, unknown tokens and expired results", () => {
  let now = 100;
  const cursors = new FactsCursors({ ttlMs: 10, now: () => now });
  const first = cursors.start("query:a", "g1", ["a", "b"], { limit: 1 });
  assert.throws(() => cursors.resume(first.details.nextCursor!, "query:b", {}), /query/);
  assert.throws(() => cursors.resume("invented", "query:a", {}), /expired|unknown/);
  now = 111;
  assert.throws(() => cursors.resume(first.details.nextCursor!, "query:a", {}), /expired|unknown/);
});

test("cursor retention evicts old results within a byte budget", () => {
  const cursors = new FactsCursors({ maxBytes: 20 });
  const first = cursors.start("one", "g1", ["1234567890", "abcdefghij"], { limit: 1 });
  cursors.start("two", "g2", ["1234567890", "abcdefghij"], { limit: 1 });
  assert.throws(() => cursors.resume(first.details.nextCursor!, "one", {}), /expired|unknown/);
  assert.throws(() => cursors.start("large", "g3", ["x".repeat(21)], {}), /budget/);
});

test("continuation is visible in model-facing text", () => {
  const cursors = new FactsCursors();
  const page = cursors.start("q", "g1", ["a", "b"], { limit: 1 });
  assert.ok(page.text.includes(page.details.nextCursor!));
  assert.match(page.text, /g1/);
});

test("invalid pagination cannot evict an existing cursor", () => {
  const cursors = new FactsCursors({ maxEntries: 1 });
  const page = cursors.start("q", "g1", ["a", "b"], { limit: 1 });
  assert.throws(() => cursors.start("invalid", "g2", ["c", "d"], { limit: 0 }));
  assert.equal(cursors.resume(page.details.nextCursor!, "q", {}).text, "b");
});
