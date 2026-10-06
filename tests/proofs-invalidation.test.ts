import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProofValidity, selectMinimumTestSet } from "../lib/proofs/proof-invalidation.ts";
import type { ProofRecord } from "../lib/proofs/proof-ledger.ts";
import { FactsService } from "../lib/facts/facts-service.ts";

function record(overrides: Partial<ProofRecord> = {}): ProofRecord {
  return {
    proofVersion: 1,
    seq: 1,
    fingerprint: "a".repeat(64),
    status: "passed",
    confidence: "hermetic_unit",
    sideEffects: "pure_validation",
    inputsDigest: "b".repeat(64),
    startedAt: 1_000,
    finishedAt: 2_000,
    ...overrides,
  };
}

function coverage(files: Record<string, string>) {
  return { files };
}

test("unchanged coverage stays valid at the exact-input layer", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1" }), {
    changedFiles: [],
    currentFileDigests: { "math.ts": "sha1" },
    reaches: () => false,
  });
  assert.equal(verdict.valid, true);
  assert.equal(verdict.layer, "exact-input");
});

test("a covered file change invalidates at the exact-input layer", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1", "util.ts": "sha2" }), {
    changedFiles: ["math.ts"],
    currentFileDigests: { "math.ts": "sha1-changed", "util.ts": "sha2" },
    reaches: () => false,
  });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.layer, "exact-input");
  assert.deepEqual(verdict.changedFiles, ["math.ts"]);
  assert.match(verdict.reason, /math\.ts/);
});

test("a changed file that statically reaches the coverage invalidates", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1" }), {
    changedFiles: ["helper.ts"],
    currentFileDigests: { "math.ts": "sha1", "helper.ts": "sha3" },
    reaches: (from, to) => from === "helper.ts" && to === "math.ts",
  });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.layer, "static-reachability");
});

test("absence of a static path is NOT runtime independence by default", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1" }), {
    changedFiles: ["unrelated.ts"],
    currentFileDigests: { "math.ts": "sha1", "unrelated.ts": "sha4" },
    reaches: () => false,
  });
  assert.equal(verdict.valid, false, "conservative default: the changed file must invalidate");
  assert.match(verdict.reason, /runtime independence/i);
});

test("explicit unreachable reuse is allowed only for hermetic classes and recorded", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1" }), {
    changedFiles: ["unrelated.ts"],
    currentFileDigests: { "math.ts": "sha1", "unrelated.ts": "sha4" },
    reaches: () => false,
    allowUnreachableReuse: true,
  });
  assert.equal(verdict.valid, true);
  assert.match(verdict.reason, /no static path/i);

  const controlled = evaluateProofValidity(record({ confidence: "controlled_integration" }), coverage({ "math.ts": "sha1" }), {
    changedFiles: ["unrelated.ts"],
    currentFileDigests: { "math.ts": "sha1", "unrelated.ts": "sha4" },
    reaches: () => false,
    allowUnreachableReuse: true,
  });
  assert.equal(controlled.valid, false, "non-hermetic classes never get unreachable reuse");
});

test("unknown reachability is conservative even with unreachable reuse allowed", () => {
  const verdict = evaluateProofValidity(record(), coverage({ "math.ts": "sha1" }), {
    changedFiles: ["dynamic.ts"],
    currentFileDigests: { "math.ts": "sha1", "dynamic.ts": "sha5" },
    reaches: () => "unknown",
    allowUnreachableReuse: true,
  });
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /unknown/i);
});

test("an expired proof invalidates at the policy-expiry layer", () => {
  const verdict = evaluateProofValidity(record({ status: "expired" }), coverage({ "math.ts": "sha1" }), {
    changedFiles: [],
    currentFileDigests: { "math.ts": "sha1" },
    reaches: () => false,
  });
  assert.equal(verdict.valid, false);
  assert.equal(verdict.layer, "policy-expiry");
});

test("Facts edges drive the reachability layer on a real workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proofs-invalidation-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  try {
    await writeFile(join(dir, "math.ts"), "export function multiply(a: number, b: number): number { return a * b; }\n");
    await writeFile(join(dir, "main.ts"), "import { multiply } from './math.ts';\nexport const value = multiply(2, 3);\n");
    await writeFile(join(dir, "standalone.ts"), "export const alone = true;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync();

    // Reachability adapter over Facts: everything that transitively imports
    // the changed file is affected; everything else is not reached by it.
    const coveredByProof = "main.ts";
    const reaches = (from: string, to: string) => {
      if (from === to) return true;
      return service.queryDependencyEvidence(to, { transitive: true }).some((evidence) => evidence.file === from);
    };

    // The proof covers main.ts. A change to math.ts reaches it; a change to
    // standalone.ts does not produce a static path to main.ts.
    assert.equal(reaches("main.ts", "math.ts"), true);
    assert.equal(reaches("main.ts", "standalone.ts"), false);

    const mathChanged = evaluateProofValidity(record(), coverage({ [coveredByProof]: "sha-main" }), {
      changedFiles: ["math.ts"],
      currentFileDigests: { [coveredByProof]: "sha-main", "math.ts": "sha-math-changed", "standalone.ts": "sha-standalone" },
      reaches,
    });
    assert.equal(mathChanged.valid, false);
    assert.equal(mathChanged.layer, "static-reachability");

    // Conservative default: even the unrelated change invalidates, because
    // "no static path" is not proof of runtime independence.
    const standaloneChanged = evaluateProofValidity(record(), coverage({ [coveredByProof]: "sha-main" }), {
      changedFiles: ["standalone.ts"],
      currentFileDigests: { [coveredByProof]: "sha-main", "math.ts": "sha-math", "standalone.ts": "sha-standalone-changed" },
      reaches,
    });
    assert.equal(standaloneChanged.valid, false);
    assert.equal(standaloneChanged.layer, "static-reachability");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("selection reuses unaffected proofs and executes only affected tests", () => {
  const inventory = [
    { name: "math.test.ts", coverage: coverage({ "math.ts": "sha1" }), fingerprint: "f1".padEnd(64, "0"), confidence: "hermetic_unit" as const, sideEffects: "pure_validation" as const },
    { name: "ui.test.ts", coverage: coverage({ "widget.ts": "sha9" }), fingerprint: "f2".padEnd(64, "0"), confidence: "hermetic_unit" as const, sideEffects: "pure_validation" as const },
  ];
  const proofs = new Map([
    [inventory[0].fingerprint, record({ fingerprint: inventory[0].fingerprint })],
    [inventory[1].fingerprint, record({ fingerprint: inventory[1].fingerprint })],
  ]);
  const outcome = selectMinimumTestSet({
    inventory,
    proofFor: (entry) => proofs.get(entry.fingerprint) ?? null,
    currentFileDigests: { "math.ts": "sha1", "widget.ts": "sha9", "widget.css": "css1" },
    reaches: (from, to) => from === "widget.css" && to === "widget.ts",
    changedFiles: ["widget.css"],
    allowUnreachableReuse: true,
  });
  assert.equal(outcome.fallback, false, "mapping is complete for every changed file");
  assert.deepEqual(outcome.reuse.map((item) => item.name), ["math.test.ts"]);
  assert.deepEqual(outcome.execute.map((item) => item.name), ["ui.test.ts"]);
  assert.match(outcome.execute[0].reason, /widget\.css/);
});

test("unknown reachability flips the outcome to conservative fallback", () => {
  const inventory = [
    { name: "math.test.ts", coverage: coverage({ "math.ts": "sha1" }), fingerprint: "f1".padEnd(64, "0"), confidence: "hermetic_unit" as const, sideEffects: "pure_validation" as const },
  ];
  const outcome = selectMinimumTestSet({
    inventory,
    proofFor: (entry) => record({ fingerprint: entry.fingerprint }),
    currentFileDigests: { "math.ts": "sha1", "dynamic.ts": "sha5" },
    reaches: () => "unknown",
    changedFiles: ["dynamic.ts"],
  });
  assert.equal(outcome.fallback, true);
  assert.deepEqual(outcome.reuse, []);
  assert.deepEqual(outcome.execute.map((item) => item.name), ["math.test.ts"]);
  assert.match(outcome.execute[0].reason, /unknown|conservative/i);
});
