/**
 * Tests for proposeReviewTier (S3, facts-informed-review).
 * Display-only advisory: native tier is always authoritative; the proposal
 * never feeds back into native computation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TreePairDigest } from "../lib/facts/facts-tree-pair.ts";
import {
  proposeReviewTier,
  TierProposalError,
} from "../lib/facts/facts-tier-proposal.ts";

function digest(overrides: Partial<TreePairDigest> = {}): TreePairDigest {
  return {
    baseTree: "aaa",
    candidateTree: "bbb",
    changedPaths: [],
    files: [],
    boundaryEdges: [],
    unchangedDependents: 0,
    extractedAt: 0,
    ...overrides,
  };
}

describe("proposeReviewTier", () => {
  it("proposes low when no files changed", () => {
    const p = proposeReviewTier({ digest: digest(), nativeTier: "medium" });
    assert.equal(p.proposal, "low");
    assert.match(p.rationale[0] ?? "", /no executable files/i);
  });

  const table = [
    { name: "all under tests/", paths: ["tests/a.ts", "tests/b.test.ts"], expected: "low" },
    { name: "all under docs/", paths: ["docs/guide.md"], expected: "low" },
    { name: "markdown only", paths: ["README.md"], expected: "low" },
    { name: "mixed, dependents 0", paths: ["lib/a.ts", "tests/a.test.ts"], dependents: 0, expected: "medium" },
    { name: "mixed, dependents 2", paths: ["lib/a.ts"], dependents: 2, expected: "high" },
  ] as const;

  for (const t of table) {
    it(`rule selection: ${t.name} -> ${t.expected}`, () => {
      const p = proposeReviewTier({
        digest: digest({
          changedPaths: [...t.paths],
          files: t.paths.map((path) => ({
            path,
            classification: "modified" as const,
            exportedSymbols: { base: [], candidate: [] },
          })),
          unchangedDependents: "dependents" in t ? t.dependents : 0,
        }),
        nativeTier: "low",
      });
      assert.equal(p.proposal, t.expected);
    });
  }

  it("boundary edges force at least medium", () => {
    const p = proposeReviewTier({
      digest: digest({
        changedPaths: ["lib/x.ts"],
        files: [
          { path: "lib/x.ts", classification: "modified", exportedSymbols: { base: [], candidate: [] } },
        ],
        boundaryEdges: [
          { importer: "lib/a.ts", specifier: "../tests/x.ts", importerChanged: false, targetChanged: true },
        ],
      }),
      nativeTier: "low",
    });
    assert.ok(["medium", "high"].includes(p.proposal));
  });

  it("rationale lists all triggered rules", () => {
    const p = proposeReviewTier({
      digest: digest({
        changedPaths: ["lib/a.ts"],
        files: [{ path: "lib/a.ts", classification: "modified", exportedSymbols: { base: [], candidate: [] } }],
        unchangedDependents: 1,
        boundaryEdges: [
          { importer: "lib/b.ts", specifier: "./a.ts", importerChanged: false, targetChanged: true },
        ],
      }),
      nativeTier: "medium",
    });
    assert.ok(p.rationale.some((l) => /unchanged dependents/i.test(l)));
    assert.ok(p.rationale.some((l) => /boundary edge/i.test(l)));
  });

  it("ledger enrichment adds context lines without changing tier", () => {
    const base = { digest: digest(), nativeTier: "low" as const };
    const without = proposeReviewTier(base);
    const withLedger = proposeReviewTier({
      ...base,
      ledger: { open: 3, fixed: 5 },
    });
    assert.equal(withLedger.proposal, without.proposal);
    assert.ok(withLedger.rationale.some((l) => l.includes("3 prior open advisories in ledger")));
    assert.ok(withLedger.rationale.some((l) => l.includes("5 prior advisories fixed in ledger")));
  });

  it("echoes native tier and authoritative:false always", () => {
    for (const nativeTier of ["passive", "low", "medium", "high"] as const) {
      const p = proposeReviewTier({ digest: digest(), nativeTier });
      assert.equal(p.nativeTier, nativeTier);
      assert.equal(p.authoritative, false);
    }
  });

  it("rationale is deterministic across calls", () => {
    const input = {
      digest: digest({
        changedPaths: ["lib/a.ts", "lib/b.ts"],
        files: [
          { path: "lib/b.ts", classification: "added" as const, exportedSymbols: { base: [], candidate: [] } },
          { path: "lib/a.ts", classification: "modified" as const, exportedSymbols: { base: [], candidate: [] } },
        ],
      }),
      nativeTier: "low" as const,
      ledger: { open: 1, fixed: 0 },
    };
    assert.deepEqual(proposeReviewTier(input), proposeReviewTier(input));
  });

  it("rejects unknown digest shape with typed error", () => {
    for (const bad of [undefined, null, {}, { files: "nope" }, { ...digest(), files: 42 }]) {
      assert.throws(
        () => proposeReviewTier({ digest: bad as never, nativeTier: "low" }),
        (err: unknown) => err instanceof TierProposalError,
      );
    }
  });

  it("sorts rationale by code units, not locale (R3-locale-sort)", () => {
    // Characterization: the production comparator is deliberately code-unit based
    // (localeCompare is ICU/locale dependent). This test pins byte-stable order
    // for a multi-line rationale so CI in any locale observes the same array.
    const input = {
      digest: digest({
        files: [{ path: "src/a.ts", classification: "modified" as const, exportedSymbols: { base: [], candidate: [] } }],
        boundaryEdges: [{ importer: "src/x.ts", specifier: "./a.ts", target: "src/a.ts", importerChanged: false, targetChanged: true }],
        unchangedDependents: 3,
      }),
      nativeTier: "medium" as const,
      ledger: { open: 2, fixed: 1 },
    };
    const p = proposeReviewTier(input);
    const sortedByCodeUnits = [...p.rationale].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(p.rationale, sortedByCodeUnits);
    assert.ok(p.rationale.length >= 3, "fixture must produce at least three rationale lines");
  });
});
