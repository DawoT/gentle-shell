import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";
import { computeProofFingerprint, proofInputsDigest, type ProofFingerprintInput } from "../lib/proofs/proof-fingerprint.ts";
import { ExecutionLeaseRegistry } from "../lib/proofs/proof-lease.ts";
import { decideProofReuse } from "../lib/proofs/proof-policy.ts";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function input(overrides: Partial<ProofFingerprintInput> = {}): ProofFingerprintInput {
  return {
    command: { argv: ["pnpm", "test", "tests/facts-store.test.ts"], cwd: ".", taskKind: "test", selection: ["tests/facts-store.test.ts"] },
    repository: { treeDigest: "a".repeat(64), factsGeneration: "b".repeat(64), manifestDigest: "c".repeat(64) },
    toolchain: { runtime: "node", runtimeVersion: process.version, runner: "node:test", runnerVersion: "1.0.0", os: process.platform, arch: process.arch },
    environment: { declared: {}, sensitive: {}, hmacKey: "gate-key" },
    ...overrides,
  };
}

test("same inputs reuse the proof without executing the runner; changed inputs execute", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proofs-gate-"));
  try {
    const ledger = new ProofLedger(join(dir, "proofs"));
    const leases = new ExecutionLeaseRegistry();
    let executions = 0;

    const runValidated = async (proofInput: ProofFingerprintInput): Promise<void> => {
      const fingerprint = computeProofFingerprint(proofInput);
      const acquisition = leases.acquire(fingerprint, "agent-a");
      assert.equal(acquisition.state, "acquired");
      const record = await ledger.start({
        fingerprint,
        inputsDigest: proofInputsDigest(proofInput),
        confidence: "hermetic_unit",
        sideEffects: "pure_validation",
        agent: acquisition.lease.owner,
      });
      executions += 1;
      await ledger.finish(record, {
        status: "passed",
        exitCode: 0,
        durationMs: 5,
        outputDigests: { stdout: digest("all tests passed"), stderr: digest("") },
      });
      acquisition.lease.release();
    };

    const reuseOrExecute = async (proofInput: ProofFingerprintInput): Promise<"reused" | "executed"> => {
      const fingerprint = computeProofFingerprint(proofInput);
      const verdict = decideProofReuse(fingerprint, await ledger.current(fingerprint));
      if (verdict.decision === "reuse") return "reused";
      if (verdict.decision !== "execute") throw new Error(`Unexpected verdict: ${verdict.reason}`);
      await runValidated(proofInput);
      return "executed";
    };

    const first = await reuseOrExecute(input());
    assert.equal(first, "executed");
    assert.equal(executions, 1);

    // The exact same state: the proof is reused, the runner never executes.
    const second = await reuseOrExecute(input());
    assert.equal(second, "reused");
    assert.equal(executions, 1);

    // Any input change (here the tree digest) invalidates reuse and executes.
    const changed = input({ repository: { ...input().repository, treeDigest: "f".repeat(64) } });
    const third = await reuseOrExecute(changed);
    assert.equal(third, "executed");
    assert.equal(executions, 2);
  } finally {
    await cleanup(dir);
  }
});

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
