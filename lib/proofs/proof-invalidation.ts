import type { ConfidenceClass, ProofRecord, SideEffectClass } from "./proof-ledger.ts";

export interface ProofCoverage {
  /** path -> content digest at proof time. */
  files: Record<string, string>;
}

export type Reachability = boolean | "unknown";

export interface InvalidationContext {
  /** The observed changed files for this evaluation. */
  changedFiles: string[];
  /** path -> digest of the current state, used to verify covered files. */
  currentFileDigests: Record<string, string>;
  /** Static reachability from a changed file to a covered file; "unknown" is conservative. */
  reaches: (changedFile: string, coveredFile: string) => Reachability;
  /**
   * Opt-in reuse when no static path exists. Defaults to false: absence of a
   * static path is not proof of runtime independence, so unknown coupling
   * invalidates unless the caller explicitly trusts hermeticity.
   */
  allowUnreachableReuse?: boolean;
}

export type InvalidationLayer = "exact-input" | "static-reachability" | "policy-expiry" | "runtime-observation";

export interface InvalidationVerdict {
  valid: boolean;
  layer: InvalidationLayer;
  reason: string;
  changedFiles?: string[];
}

/**
 * Layered proof invalidation (gaps GF-P1-004), evaluated in strict order:
 * 1. policy-expiry       - only a passed proof can ever be reused.
 * 2. exact-input         - any covered file whose digest changed invalidates.
 * 3. static-reachability - a changed file with a static path into the covered
 *                          set invalidates; no static path is NOT runtime
 *                          independence, so without the explicit hermetic
 *                          opt-out the proof still invalidates, and unknown
 *                          reachability always invalidates.
 * Runtime observation (layer 4) is reserved for coverage-based refinement.
 */
export function evaluateProofValidity(proof: ProofRecord, coverage: ProofCoverage, context: InvalidationContext): InvalidationVerdict {
  if (proof.status === "expired") {
    return { valid: false, layer: "policy-expiry", reason: "The proof expired under the retention policy." };
  }
  if (proof.status !== "passed") {
    return { valid: false, layer: "policy-expiry", reason: `The proof is ${proof.status}; only a passed proof can be reused.` };
  }

  const coveredChanged = Object.keys(coverage.files).filter((path) => context.currentFileDigests[path] !== coverage.files[path]);
  if (coveredChanged.length > 0) {
    return {
      valid: false,
      layer: "exact-input",
      reason: `Covered files changed: ${coveredChanged.join(", ")}.`,
      changedFiles: coveredChanged,
    };
  }

  const notReachable: string[] = [];
  for (const changed of context.changedFiles) {
    let anyReach = false;
    let unknown = false;
    for (const covered of Object.keys(coverage.files)) {
      const reach = context.reaches(changed, covered);
      if (reach === "unknown") unknown = true;
      if (reach === true) anyReach = true;
    }
    if (unknown) {
      return {
        valid: false,
        layer: "static-reachability",
        reason: `Reachability of ${changed} into the covered set is unknown; execute conservatively.`,
        changedFiles: [changed],
      };
    }
    if (anyReach) {
      return {
        valid: false,
        layer: "static-reachability",
        reason: `A static path leads from the changed file ${changed} into the covered set.`,
        changedFiles: [changed],
      };
    }
    notReachable.push(changed);
  }

  const hermeticTrusted = context.allowUnreachableReuse === true && (proof.confidence === "hermetic_static" || proof.confidence === "hermetic_unit");
  if (hermeticTrusted && notReachable.length > 0) {
    return {
      valid: true,
      layer: "static-reachability",
      reason: `No static path from the changed files into the covered set and ${proof.confidence} hermeticity was explicitly trusted for this run.`,
      changedFiles: notReachable,
    };
  }
  if (notReachable.length > 0) {
    return {
      valid: false,
      layer: "static-reachability",
      reason: "No static path was found, but absence of a static path is not proof of runtime independence; execute conservatively.",
      changedFiles: notReachable,
    };
  }
  return { valid: true, layer: "exact-input", reason: "No changed files affect the covered set." };
}

export interface TestInventoryEntry {
  name: string;
  fingerprint: string;
  coverage: ProofCoverage;
  confidence: ConfidenceClass;
  sideEffects: SideEffectClass;
}

export interface SelectionItem {
  name: string;
  reason: string;
  proof?: ProofRecord;
}

export interface SelectionOutcome {
  reuse: SelectionItem[];
  execute: SelectionItem[];
  /** True when reachability mapping was incomplete for any reuse candidate. */
  fallback: boolean;
}

export interface SelectionContext {
  inventory: TestInventoryEntry[];
  proofFor: (entry: TestInventoryEntry) => ProofRecord | null;
  currentFileDigests: Record<string, string>;
  reaches: (changedFile: string, coveredFile: string) => Reachability;
  changedFiles: string[];
  allowUnreachableReuse?: boolean;
}

/**
 * Minimum test set selection (gaps GF-P2-001): reuse proofs that survive the
 * layered invalidation, execute everything else. The mapping is conservative:
 * unknown reachability marks the outcome as a fallback and executes the
 * affected entries. Every inventory entry is accounted for - a suite verdict
 * can never be composed from constituents the engine did not see.
 */
export function selectMinimumTestSet(context: SelectionContext): SelectionOutcome {
  const outcome: SelectionOutcome = { reuse: [], execute: [], fallback: false };
  for (const entry of context.inventory) {
    const proof = context.proofFor(entry);
    const verdict = evaluateProofValidity(proof ?? recordShell(entry), entry.coverage, {
      changedFiles: context.changedFiles,
      currentFileDigests: context.currentFileDigests,
      reaches: context.reaches,
      allowUnreachableReuse: context.allowUnreachableReuse,
    });
    if (proof && verdict.valid && proof.status === "passed") {
      outcome.reuse.push({ name: entry.name, reason: verdict.reason, proof });
      continue;
    }
    if (verdict.reason.toLowerCase().includes("unknown")) outcome.fallback = true;
    outcome.execute.push({
      name: entry.name,
      reason: proof
        ? `${verdict.reason}${verdict.changedFiles?.length ? ` Changed: ${verdict.changedFiles.join(", ")}.` : ""}`
        : "No proof exists for this entry; execute.",
    });
  }
  return outcome;
}

function recordShell(entry: TestInventoryEntry): ProofRecord {
  return {
    proofVersion: 1,
    seq: 0,
    fingerprint: entry.fingerprint,
    status: "passed",
    confidence: entry.confidence,
    sideEffects: entry.sideEffects,
    inputsDigest: "",
    startedAt: 0,
  };
}
