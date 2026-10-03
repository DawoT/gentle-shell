/**
 * Facts-informed review-tier PROPOSAL (S3, facts-informed-review).
 *
 * BOUNDARY (hard contract): this is a pure display-layer advisory for the
 * parent's triage conversation. The native/Go tier (`nativeTier`, decoded by
 * review-risk-assessment.ts) is ALWAYS the authoritative verdict and is only
 * echoed here. The proposal returned by `proposeReviewTier` must never
 * replace, override, or be fed back into any native computation.
 */
import type { TreePairDigest } from "./facts-tree-pair.ts";

export type TierProposalErrorCode = "unknown-digest";

export class TierProposalError extends Error {
  readonly code: TierProposalErrorCode;
  constructor(code: TierProposalErrorCode, message: string) {
    super(message);
    this.name = "TierProposalError";
    this.code = code;
  }
}

export type TierName = "passive" | "low" | "medium" | "high";

export interface TierProposal {
  /** Display-only advisory tier; never authoritative. */
  proposal: "low" | "medium" | "high";
  /** Deterministic, sorted rationale lines (all triggered rules). */
  rationale: string[];
  /** Native tier, echoed as-is; always authoritative. */
  nativeTier: TierName;
  /** Always false: the native tier owns the verdict. */
  authoritative: false;
}

export interface TierProposalLedgerSummary {
  open: number;
  fixed: number;
}

export interface TierProposalInput {
  digest: TreePairDigest;
  nativeTier: TierName;
  nativeReasons?: string[];
  ledger?: TierProposalLedgerSummary;
}

function isTreePairDigest(value: unknown): value is TreePairDigest {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.baseTree === "string" &&
    typeof d.candidateTree === "string" &&
    Array.isArray(d.changedPaths) &&
    Array.isArray(d.files) &&
    Array.isArray(d.boundaryEdges) &&
    typeof d.unchangedDependents === "number" &&
    d.files.every(
      (f: unknown) =>
        typeof f === "object" &&
        f !== null &&
        typeof (f as Record<string, unknown>).path === "string",
    )
  );
}

function isTestsOrDocs(path: string): boolean {
  return path.startsWith("tests/") || path.startsWith("docs/") || path.endsWith(".md");
}

/**
 * Propose a display-only review tier from Facts evidence. Rules ordered by
 * precedence (first match wins for the tier); rationale lists ALL triggered
 * rules, deterministically sorted. Ledger lines are context only and never
 * change the tier. See module doc for the native-authority boundary.
 */
export function proposeReviewTier(input: TierProposalInput): TierProposal {
  if (!isTreePairDigest(input.digest)) {
    throw new TierProposalError(
      "unknown-digest",
      "proposeReviewTier: digest does not match TreePairDigest shape",
    );
  }
  const { digest, nativeTier, ledger } = input;
  const rationale: string[] = [];
  let proposal: "low" | "medium" | "high" | undefined;

  const allPaths = digest.files.map((f) => f.path);
  if (allPaths.length === 0) {
    proposal = "low";
    rationale.push("no executable files changed: proposing low tier");
  } else if (allPaths.every(isTestsOrDocs)) {
    proposal = "low";
    rationale.push("all changed files are tests/docs/markdown: fixture or documentation-only change");
  } else {
    const outside = allPaths.filter((p) => !isTestsOrDocs(p));
    if (digest.unchangedDependents > 0) {
      proposal = "high";
      rationale.push(
        `changed files outside tests/docs affect ${digest.unchangedDependents} unchanged dependents: proposing high tier`,
      );
    } else if (digest.boundaryEdges.length > 0) {
      proposal = "medium";
      rationale.push(
        `${digest.boundaryEdges.length} module-boundary edge(s) touched: proposing at least medium tier`,
      );
    } else {
      proposal = "medium";
      rationale.push(
        `${outside.length} changed file(s) outside tests/docs with no other signal: proposing medium tier`,
      );
    }
    if (digest.boundaryEdges.length > 0 && proposal === "high") {
      rationale.push(
        `${digest.boundaryEdges.length} module-boundary edge(s) touched (context; high tier already applies)`,
      );
    }
  }

  // Ledger enrichment: context only, never changes the tier.
  if (ledger && ledger.open > 0) {
    rationale.push(`${ledger.open} prior open advisories in ledger`);
  }
  if (ledger && ledger.fixed > 0) {
    rationale.push(`${ledger.fixed} prior advisories fixed in ledger`);
  }

  // R3-locale-sort: localeCompare is ICU/locale dependent and made the
  // rationale ordering vary across environments. Rationales are ASCII
  // identifiers/sentences — sort by code units for byte-stable determinism.
  rationale.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { proposal, rationale, nativeTier, authoritative: false };
}
