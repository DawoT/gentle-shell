import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mapFactsIO } from "../lib/facts/facts-io.ts";
import { readFactsFile, FactsReadBudget } from "../lib/facts/facts-limits.ts";

test("Facts IO overlaps work within its concurrency bound and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapFactsIO([0, 1, 2, 3, 4], async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return value * 2;
  }, undefined, 2);
  assert.equal(peak, 2);
  assert.deepEqual(result, [0, 2, 4, 6, 8]);
});

test("Facts IO drains active operations and cancels queued work before rejecting", async () => {
  const failure = new Error("broken artifact");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = 0;
  let drained = false;
  let rejected = false;
  const pending = mapFactsIO([0, 1, 2, 3], async (value, signal) => {
    started++;
    if (value === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      throw failure;
    }
    await gate;
    assert.equal(signal.aborted, true);
    drained = true;
  }, undefined, 2);
  const checked = assert.rejects(pending, (error) => {
    rejected = true;
    assert.equal(drained, true);
    return error === failure;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, false);
  release();
  await checked;
  assert.equal(started, 2);
});

test("Facts IO respects caller cancellation without starting queued tasks", async () => {
  const controller = new AbortController();
  let started = 0;
  await assert.rejects(mapFactsIO([1, 2, 3], async (_value, signal) => {
    started++;
    controller.abort();
    signal.throwIfAborted();
  }, controller.signal, 1), { name: "AbortError" });
  assert.equal(started, 1);
});

test("concurrent Facts reads share one aggregate byte budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facts-io-"));
  try {
    await writeFile(join(directory, "a"), "ab");
    await writeFile(join(directory, "b"), "cd");
    const budget = new FactsReadBudget(3);
    await assert.rejects(mapFactsIO(["a", "b"], (name, signal) =>
      readFactsFile(join(directory, name), 10, signal, budget)), /byte limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
