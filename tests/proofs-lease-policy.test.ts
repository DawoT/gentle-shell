import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionLeaseRegistry } from "../lib/proofs/proof-lease.ts";
import { decideProofReuse } from "../lib/proofs/proof-policy.ts";
import type { ProofRecord } from "../lib/proofs/proof-ledger.ts";

const FINGERPRINT = "a".repeat(64);

function record(overrides: Partial<ProofRecord> = {}): ProofRecord {
  return {
    proofVersion: 1,
    seq: 1,
    fingerprint: FINGERPRINT,
    status: "passed",
    confidence: "hermetic_unit",
    sideEffects: "pure_validation",
    inputsDigest: "b".repeat(64),
    startedAt: 1_000,
    finishedAt: 2_000,
    ...overrides,
  };
}

test("single-flight: one owner executes and equivalent callers wait", () => {
  const leases = new ExecutionLeaseRegistry();
  const first = leases.acquire(FINGERPRINT, "agent-a");
  assert.equal(first.state, "acquired");
  assert.equal(first.lease?.owner, "agent-a");

  const second = leases.acquire(FINGERPRINT, "agent-b");
  assert.equal(second.state, "wait");
  assert.equal(second.owner, "agent-a", "the waiter learns who owns the execution");

  first.lease?.release();
  const third = leases.acquire(FINGERPRINT, "agent-c");
  assert.equal(third.state, "acquired", "release frees the fingerprint");
});

test("a dead owner is provably lost and the lease can be taken over", () => {
  let now = 1_000;
  const leases = new ExecutionLeaseRegistry({ now: () => now, leaseTtlMs: 5_000 });
  const first = leases.acquire(FINGERPRINT, "agent-a");
  assert.equal(first.state, "acquired");

  now += 6_000; // no heartbeat: the lease expired
  const takeover = leases.acquire(FINGERPRINT, "agent-b");
  assert.equal(takeover.state, "acquired");
  assert.equal(takeover.lease?.owner, "agent-b");
  assert.equal(takeover.tookOver, true, "provenance records the takeover");

  // A heartbeat keeps a live owner in possession.
  now = 2_000;
  const fresh = new ExecutionLeaseRegistry({ now: () => now, leaseTtlMs: 5_000 });
  const live = fresh.acquire(FINGERPRINT, "agent-a");
  assert.equal(live.state, "acquired");
  now += 4_000;
  live.lease?.heartbeat();
  now += 4_000;
  assert.equal(fresh.acquire(FINGERPRINT, "agent-b").state, "wait", "heartbeat keeps the lease alive");
});

test("reuse requires a passed, hermetic, pure-validation proof of the same fingerprint", () => {
  const decision = decideProofReuse(FINGERPRINT, record(), { now: () => 2_000 });
  assert.equal(decision.decision, "reuse");
  assert.equal(decision.proof?.fingerprint, FINGERPRINT);
  assert.match(decision.reason, /hermetic_unit/);
  assert.equal(decision.explain.fingerprint, FINGERPRINT);
  assert.equal(decision.explain.ageMs, 0);
});

test("a failed proof is evidence, never a block on re-execution", () => {
  const decision = decideProofReuse(FINGERPRINT, record({ status: "failed", exitCode: 1 }));
  assert.equal(decision.decision, "execute");
  assert.match(decision.reason, /failed/);
});

test("invalidated, stale and expired proofs force execution with their reason", () => {
  for (const status of ["invalidated", "stale", "expired"] as const) {
    const decision = decideProofReuse(FINGERPRINT, record({ status, invalidationReason: "source tree changed" }));
    assert.equal(decision.decision, "execute");
    assert.match(decision.reason, /source tree changed|invalidated|stale|expired/);
  }
});

test("mutating and non-hermetic proofs are never transparently reused", () => {
  const mutating = decideProofReuse(FINGERPRINT, record({ sideEffects: "local_mutation" }));
  assert.equal(mutating.decision, "no_reuse");
  assert.match(mutating.reason, /side effect/i);

  const external = decideProofReuse(FINGERPRINT, record({ sideEffects: "external_side_effect" }));
  assert.equal(external.decision, "no_reuse");

  const integration = decideProofReuse(FINGERPRINT, record({ confidence: "controlled_integration" }));
  assert.equal(integration.decision, "no_reuse");
  assert.match(integration.reason, /hermeticity/i);
});

test("a proof in flight or an absent proof means execute", () => {
  assert.equal(decideProofReuse(FINGERPRINT, null).decision, "execute");
  const inflight = decideProofReuse(FINGERPRINT, record({ status: "running" }));
  assert.equal(inflight.decision, "execute");
  assert.match(inflight.reason, /in flight/);
});

test("a defensive fingerprint mismatch never reuses", () => {
  const decision = decideProofReuse(FINGERPRINT, record({ fingerprint: "c".repeat(64) }));
  assert.equal(decision.decision, "execute");
  assert.match(decision.reason, /mismatch/);
});
