# Facts roadmap closure report (2026-10-16)

Consolidated measurement record for the `gaps.yaml` closure criterion
"Observed wall-clock savings are reported alongside false-reuse rate and
fallback rate". Companion to `facts-baseline-2026-10.md` (the pre-optimization
baseline). All numbers below are a fresh harness run of
`pnpm benchmark:facts:real` at HEAD `2cbb6f851` (roadmap-complete tree),
7 samples per scenario, 1224-file corpus, tmpfs, linux.

## Fresh scenario numbers (7 samples, 1224 files, tmpfs)

| Scenario | p50 | p95 | Notes |
| --- | ---: | ---: | --- |
| cold | 2781.03ms | 3523.70ms | full index from scratch; grows with corpus |
| warm full sync | 242.07ms | 265.35ms | conservative authority path |
| postEdit | 353.48ms | 410.34ms | one edited file, full reconciliation |
| burstWall (3x unchanged full syncs) | 786.07ms | 896.16ms | serialized by writer lock, by design |
| autoRead (fast path) | 51.58ms | 63.27ms | **4.7x cheaper than warm full sync** |
| nameQuery (40 queries/batch) | 5.62ms | 6.02ms | ~0.14ms/query vs 0.794ms linear baseline |
| evidenceQuery (20 transitive) | 0.50ms | 7.51ms | per-generation index |
| lexicalQuery (10 ranked searches) | 237.32ms | 374.00ms | O(candidates), documented |

Fast-path phase breakdown: only the verifying `git_scan` plus `fast_path`
bookkeeping; zero module resolution, snapshot validation, cache load or
publication. The conservative full path remains reachable and authoritative
(kill switches tested; equivalence suites green).

## Comparison against recorded baselines

Absolute full-sync costs are NOT directly comparable across runs: the corpus
grew 910 -> 918 -> 1224 files during the roadmap, and cold/warm full sync
scales with corpus size. The comparable invariants are the ratios and the
phase shares, both stable or improved:

- Fast-path vs warm full sync: 4.9x (S1, 915 files) -> 4.2x (2026-10-15,
  1221 files) -> **4.7x (this run, 1224 files)**. The fast path never serves
  stale data: freshness is proven by a cheap deterministic workspace scan.
- Name lookup: 0.794ms/query linear (S5 baseline) -> ~0.14ms/query indexed
  in this run; `GENTLE_FACTS_DISABLE_QUERY_INDEX` equivalence remains tested.
- Burst full syncs stay serialized under the writer lock by design; the
  OBS-003 stampede elimination applies to auto/single-flight reads, which is
  the agent-facing path (autoRead above).

## False-reuse rate and fallback rate

- S7.4 conservatism tuning (commit `19efcd99b`): measured 0 false-reuse
  incidents across clean, covered-file mutation, revert and
  same-status-different-content cycles on the real repository; the granular
  runner re-digests reused proofs against current content and self-heals
  (FALSE-REUSE -> re-execute affected file) before any suite proof
  consolidates.
- Conservative fallback: pinned by tests — incomplete coverage mapping,
  unknown reachability, truncated observations or untrustworthy per-file runs
  fail closed to the full stage; proofs without runtime observation keep the
  exact S4.1 conservative verdict; exact-input invalidation is never
  overridden by runtime evidence.
- Live reuse measurement (tracker, 2026-10-15): ~368 of 370 test files
  reused per-file on a clean tree; affected files re-executed granularly.

## Closure criteria checklist (gaps.yaml)

| Criterion | Status | Evidence |
| --- | --- | --- |
| Repeated-query fast path measurably cheaper | met | autoRead 51.58ms vs warm 242.07ms (4.7x), this run |
| No regression in snapshot integrity, writer safety, cancellation, external-edit detection | met | facts suite 370/370 incl. guarantee tests (fresh run 2026-10-16) |
| Identical concurrent proof requests execute once | met | single-flight lease tests; proofs suite 66/66 |
| Relevant changes invalidate before reuse | met | layered invalidation + content-sensitive tree digest (`19efcd99b`) |
| Green suite never composed from stale constituents | met | constituent accounting + post-execution false-reuse audit |
| Every reused result explainable | met | `proof_status` states fingerprint, age, class, inputs, exact reason, provenance |
| E2E reuse disabled when hermeticity not demonstrable | met | reuse restricted to hermetic classes; runner reuse strictly opt-in (`GENTLE_PROOFS=1`) |
| Savings reported with false-reuse and fallback rates | met | this document |

## Still open (external or deferred by design)

- S0.4 / B1-L2: native review resume remains externally blocked. Fresh bound
  STATUS for both recorded lineages (2026-10-16) returns blocked/unrelated
  with an empty collect set — no resumable slot is offered; the human /reload
  precondition for B1 still applies. No fabricated closure.
- Deferred by design with documented triggers: S2.1 (manifest cost still
  ~0.3% of warm sync), S8.3 shared storage (gated on maturity metrics),
  cross-process lease (no multi-process demand yet), W4-W6 publication
  (user decision pending).
