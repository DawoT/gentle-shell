import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";
import { runSuiteWithProofs } from "../lib/proofs/proof-runner.ts";
import type { TestInventoryEntry } from "../lib/proofs/proof-invalidation.ts";

const SHA = (n: number) => `sha-${n}`;

function inventory(): TestInventoryEntry[] {
  return [
    { name: "math.test.ts", fingerprint: "f1".padEnd(64, "0"), coverage: { files: { "math.ts": SHA(1) } }, confidence: "hermetic_unit", sideEffects: "pure_validation" },
    { name: "ui.test.ts", fingerprint: "f2".padEnd(64, "0"), coverage: { files: { "widget.ts": SHA(9) } }, confidence: "hermetic_unit", sideEffects: "pure_validation" },
  ];
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofs-runner-"));
  const ledger = new ProofLedger(join(dir, "proofs"));
  return {
    dir,
    ledger,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function baseOptions(ledger: ProofLedger, overrides: Record<string, unknown> = {}) {
  const inv = inventory();
  const executed: string[] = [];
  return {
    inv,
    executed,
    options: {
      ledger,
      inventory: inv,
      fingerprintFor: (entry: TestInventoryEntry) => ({ fingerprint: entry.fingerprint, inputsDigest: "d".repeat(64) }),
      coverageFor: (entry: TestInventoryEntry) => entry.coverage,
      currentFileDigests: { "math.ts": SHA(1), "widget.ts": SHA(9) },
      reaches: (changed: string, covered: string) => changed === "widget.ts" && covered === "widget.ts",
      changedFiles: [] as string[],
      runTest: async (entry: TestInventoryEntry) => {
        executed.push(entry.name);
        return { passed: true, exitCode: 0, durationMs: 10 };
      },
      agent: "proof-runner-test",
      allowUnreachableReuse: true,
      ...overrides,
    },
  };
}

test("the first run executes everything and publishes proofs", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const { options } = baseOptions(ledger);
    const result = await runSuiteWithProofs(options);
    assert.equal(result.green, true);
    assert.equal(result.executed.length, 2);
    assert.equal(result.reused.length, 0);
    assert.equal(result.unaccounted.length, 0);
    assert.equal((await ledger.current(options.inventory[0].fingerprint))?.status, "passed");
  } finally {
    await cleanup();
  }
});

test("an unchanged second run reuses everything without executing", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    assert.equal(first.executed.length, 2);

    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 0, "the runner never executed");
    assert.equal(result.reused.length, 2);
    assert.equal(result.green, true);
    assert.ok(result.reused[0].seq >= 1, "reuse explains which published proof it relied on");
  } finally {
    await cleanup();
  }
});

test("an affected test executes while the unaffected one is reused", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);

    const second = baseOptions(ledger, { changedFiles: ["widget.ts"] });
    const result = await runSuiteWithProofs(second.options);
    assert.deepEqual(second.executed, ["ui.test.ts"], "only the affected test executes");
    assert.deepEqual(result.reused.map((item) => item.name), ["math.test.ts"]);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("a failing executed test turns the suite red and never blocks its own rerun", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger, {
      runTest: async (entry: TestInventoryEntry) => entry.name === "ui.test.ts" ? { passed: false, exitCode: 1, durationMs: 3 } : { passed: true, exitCode: 0, durationMs: 10 },
    });
    const red = await runSuiteWithProofs(first.options);
    assert.equal(red.green, false, "a failed executed constituent cannot compose green");
    assert.equal((await ledger.current("f2".padEnd(64, "0")))?.status, "failed");

    // A cached failure is evidence: the next run executes the test again.
    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    assert.deepEqual(second.executed.includes("ui.test.ts"), true);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("stage independence: a throwing runner fails its own test only", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const { options } = baseOptions(ledger, {
      runTest: async (entry: TestInventoryEntry) => {
        if (entry.name === "ui.test.ts") throw new Error("runner crashed");
        return { passed: true, exitCode: 0, durationMs: 10 };
      },
    });
    const result = await runSuiteWithProofs(options);
    assert.equal(result.green, false);
    assert.equal(result.executed.length, 2);
    assert.equal(result.executed.find((item) => item.name === "ui.test.ts")?.passed, false);
    assert.equal(result.executed.find((item) => item.name === "math.test.ts")?.passed, true);
    assert.equal(result.unaccounted.length, 0);
  } finally {
    await cleanup();
  }
});

test("forceRun bypasses reuse and publishes fresh evidence", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    const seqBefore = (await ledger.current("f1".padEnd(64, "0")))?.seq;

    const second = baseOptions(ledger, { forceRun: true });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 2, "force-run executes even with valid proofs");
    assert.equal(result.reused.length, 0);
    const seqAfter = (await ledger.current("f1".padEnd(64, "0")))?.seq;
    assert.equal((seqAfter ?? 0) > (seqBefore ?? 0), true, "fresh evidence is published");
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("noCache neither reuses nor publishes", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    const before = await ledger.current("f1".padEnd(64, "0"));

    const second = baseOptions(ledger, { noCache: true });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 2);
    assert.equal(result.reused.length, 0);
    const after = await ledger.current("f1".padEnd(64, "0"));
    assert.equal(after?.seq, before?.seq, "the ledger view stayed untouched");
    assert.deepEqual(after, before);
  } finally {
    await cleanup();
  }
});

test("a policy-rejected proof surfaces its explanation in the executed entry", async () => {
  const { dir, ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    // Turn the published math proof into a non-hermetic one on disk.
    const forged = JSON.stringify({ ...JSON.parse(JSON.stringify(await ledger.current("f1".padEnd(64, "0")))), confidence: "controlled_integration" });
    await (await import("node:fs/promises")).writeFile(join(dir, "proofs", "records", "f1".padEnd(64, "0"), "current.json"), forged);

    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    const math = result.executed.find((item) => item.name === "math.test.ts");
    assert.equal(math?.passed, true);
    assert.match(math?.reason ?? "", /controlled_integration|hermeticity/i);
  } finally {
    await cleanup();
  }
});

test("unknown reachability triggers the conservative fallback across the suite", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);

    const second = baseOptions(ledger, {
      changedFiles: ["mystery.ts"],
      reaches: () => "unknown" as const,
    });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(result.fallback, true);
    assert.equal(result.reused.length, 0, "fallback executes instead of reusing");
    assert.equal(result.executed.length, 2);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});
