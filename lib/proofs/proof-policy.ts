import type { ProofRecord } from "./proof-ledger.ts";

export type ReuseDecision = "reuse" | "execute" | "no_reuse";

export interface ReuseVerdict {
  decision: ReuseDecision;
  reason: string;
  proof?: ProofRecord;
  explain: {
    fingerprint: string;
    /** Milliseconds since the proof's finishedAt at decision time; null when absent. */
    ageMs: number | null;
    confidence?: string;
    sideEffects?: string;
  };
}

export interface ProofPolicyOptions {
  now?: () => number;
}

const REUSABLE_CONFIDENCE = new Set(["hermetic_static", "hermetic_unit"]);
const REUSABLE_SIDE_EFFECTS = new Set(["pure_validation", "reproducible_build"]);

/**
 * Explainable reuse policy. Every verdict names its exact inputs: a decision
 * is only accepted when it can be explained back with the fingerprint, the
 * proof age and the reason. Quality invariants enforced here: a failed proof
 * is evidence and never blocks execution; side-effecting commands are never
 * transparently replaced; reuse is disabled unless hermeticity is
 * demonstrated; unknown or missing proofs force conservative execution.
 */
export function decideProofReuse(fingerprint: string, proof: ProofRecord | null, options: ProofPolicyOptions = {}): ReuseVerdict {
  const now = (options.now ?? Date.now)();
  const explain = (partial: Omit<ReuseVerdict, "explain">, extra: { confidence?: string; sideEffects?: string } = {}): ReuseVerdict => ({
    ...partial,
    explain: {
      fingerprint,
      ageMs: proof?.finishedAt !== undefined ? now - proof.finishedAt : null,
      ...(extra.confidence ? { confidence: extra.confidence } : {}),
      ...(extra.sideEffects ? { sideEffects: extra.sideEffects } : {}),
    },
  });

  if (!proof) {
    return explain({ decision: "execute", reason: "No published proof for this fingerprint; execute conservatively." });
  }
  if (proof.fingerprint !== fingerprint) {
    return explain({ decision: "execute", reason: "Fingerprint mismatch between the requested state and the stored proof; execute conservatively." }, proof);
  }
  const common = { confidence: proof.confidence, sideEffects: proof.sideEffects };
  if (proof.status === "running") {
    return explain({ decision: "execute", reason: "A proof for this exact state is in flight; subscribe through the execution lease." }, common);
  }
  if (proof.status === "failed") {
    return explain({ decision: "execute", reason: "The previous proof failed; cached failure is evidence and must never block execution." }, common);
  }
  if (proof.status === "stale" || proof.status === "expired" || proof.status === "invalidated") {
    return explain({ decision: "execute", reason: `The proof was ${proof.status}${proof.invalidationReason ? `: ${proof.invalidationReason}` : ""}; execute and publish a replacement.` }, common);
  }
  if (proof.status === "aborted") {
    return explain({ decision: "execute", reason: "The previous execution was aborted before a verdict; execute." }, common);
  }
  // status === passed
  if (!REUSABLE_SIDE_EFFECTS.has(proof.sideEffects)) {
    return explain({ decision: "no_reuse", reason: "The command mutates local or external state; a proof may inform the agent but must not silently replace the side effects." }, common);
  }
  if (!REUSABLE_CONFIDENCE.has(proof.confidence)) {
    return explain({ decision: "no_reuse", reason: `Reuse is disabled for ${proof.confidence} confidence until hermeticity is demonstrated; execute.` }, common);
  }
  return explain({
    decision: "reuse",
    reason: `Reusable ${proof.confidence} proof with ${proof.sideEffects} side effects and matching fingerprint.`,
    proof,
  }, common);
}
