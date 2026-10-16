# Facts SOTA improvement roadmap

Detailed successor roadmap for Gentle Facts, generated from the live
dogfooding campaign of 2026-10-16 (6 rounds, `docs/engineering/facts-dogfooding-2026-10-16.md`).
Every item below originates from friction actually experienced or verified
live during that campaign — not from armchair design. Parent context:
`odd/tasks/facts-gaps-roadmap.md` (original roadmap, implementation
complete) and `gaps.yaml` (original audit, scores quoted below).

Execution discipline: same as the parent roadmap. R1xM per unit (explorer
-> one bounded writer -> independent verifier where risk applies), RED
observed before GREEN, hermetic fixtures, no test weakening, work-unit
Conventional Commits, native assess per source unit. Baseline-first: no
optimization commit before the metric exists.

## Objective

Take Facts from "objective fulfilled with measured wall-clock numbers"
(today's verdict) to state-of-the-art agent evidence infrastructure by
eliminating the friction classes the dogfooding campaign actually hit,
then making the step-change bets (shared proofs, cross-repo federation)
explicitly and deliberately.

## Specs (S#)

- S1 Pre-commit smoke guard: a broken module import in an entry point
  (the campaign's duplicated-import incident: MCP bin 5/5 failing) must be
  caught in seconds by a load+tools/list smoke check, before any test
  suite runs.
- S2 Contention guard: running `pnpm test:facts` concurrently with a
  GENTLE_PROOFS full pass produced 6 spurious failures (observed
  2026-10-16; isolated rerun 380/380 twice). Concurrent verification over
  the same tree/ledger must either serialize or warn loudly — never
  silently report false failures.
- S3 Coverage-to-tests reverse query: per-file proofs already store V8
  coverage snapshots; no tool answers "which tests exercise this file?".
  Expose it (dogfooding proposal P5, still open).
- S4 Extension staleness indicator: session tools run the extension
  loaded at the last `/reload`; the campaign misdiagnosed two fixes as
  broken because of this (default-50 and imports-section). `facts_status`
  must state loaded-extension version vs working-tree version.
- S5 Empty-query telemetry: the usage meter counts misses ("empty: 2")
  but not which queries missed; parser and backfill priorities are blind.
- S6 Parser-version stamp: parser changes must structurally invalidate
  stored contract entities (verified empirically safe today — fresh parse
  matched live — but the guard is what makes it impossible by design).
- S7 Proactive impact hints: the extension already observes
  tool_execution_end for write/edit and knows dependents; it must surface
  "touched X: N dependents, M test files cover it" so agent behavior
  improves without agent discipline.
- S8 Symbol usage-site queries: file-level dependency edges exist; the
  campaign still needed grep to find consumers of a constant
  (`paginationProperties`) and call sites of `pageFacts`. Add
  symbol-level usage queries.
- S9 Focused-test selection in the ODD flow: small-path tasks run
  `facts_dependents(changed) -> importing tests` before any broader suite
  (the skill/docs integration still pending user approval).
- S10 Lexical query performance: 201.72ms p50 today, O(candidates); bring
  ranked discovery to milliseconds with a bounded ranking structure.
- S11 Shared proof ledger (S8.3 successor): namespaced by repo/platform/
  trust domain, gated on the measured maturity (false-reuse 0 recorded).
- S12 Cross-repo entity federation: this workspace already has the real
  case (gentle-ai <-> gentle-shell shared contracts); "who consumes this
  contract in the other repository?" is impossible today.
- S13 Optional semantic tier: hybrid lexical+embedding discovery, opt-in
  and isolated; the audit scored semantic search 5.5. Embeddings must
  never weaken the verified-evidence guarantee.

## Non-goals (learned the hard way)

- No watcher-trusted freshness (S1 design correction of the original
  roadmap stands: the deterministic re-scan is the right trade).
- No "fixing" the provider-mirrored $defs repetition (proven correct
  data, pinned by characterization test; the mirror must not be edited).
- No chasing autoRead below ~40ms with mtime probes: marginal gain,
  freshness-guarantee risk.
- No eager semantic tier: SOTA is not a vector DB bolted onto verified
  evidence; it stays optional until product decides.

## Tasks

Tiers gate sequencing; earlier tiers protect later ones.

### Tier 1 — Guard rails from real friction (days, each TDD-able now)

- T1.1 [S1] Pre-commit smoke guard: load every bin entry point +
  initialize + tools/list round-trip; wire into the test suite's first
  stage and (optionally) a pre-commit hook. RED: simulate a broken import
  in a fixture copy and assert the guard fails fast with a precise
  message.
- T1.2 [S2] Contention guard: advisory lock (or loud warning) around
  concurrent verification runs over the same tree/ledger; RED: two
  concurrent suite invocations must not both report green/fail
  ambiguously — reproduce the 6-failure contention scenario first.
- T1.3 [S3] facts_coverage tool (or extension of facts_entities-family
  surface): answer "which stored per-file proofs cover file X" from the
  ledger's runtime observations; read-only; RED: covered file lists its
  covering tests, uncovered file says so explicitly.
- T1.4 [S4] facts_status staleness: loaded extension version vs
  working-tree version, one line; RED: mismatched versions visible in the
  status block.
- T1.5 [S5] Empty-query telemetry: record last N empty queries (query
  kind + shape, no user data) surfaced in facts_status; RED: an empty
  lookup is visible with its shape.
- T1.6 [S6] Parser-version stamp in the DB + invalidation on change;
  RED: same file content re-parsed under a different parser version
  replaces entities (today it would not).

### Tier 2 — Flow integration (1-2 weeks; where agent ROI compounds)

- T2.1 [S7] Proactive impact hints: after write/edit/apply_diff, append a
  bounded hint line (dependents count + covering tests count) to the
  agent context; must be cheap (existing epoch dirty path) and
  cancellable (kill switch).
- T2.2 [S8] Symbol usage-site queries: extend the module resolver's
  recorded edges or symbol index to answer "callers/usage sites of
  symbol"; must stay exact (no fuzzy), bounded pages.
- T2.3 [S9] ODD/skills integration (requires user approval to edit
  assets): Explore uses facts_query(file) for surface maps; delegation
  briefs carry dependents counts; verification rule runs focused tests
  via facts_dependents before broader suites; task docs record dependents
  per surface.
- T2.4 [S10] Lexical performance: bounded ranking structure (trigram or
  precomputed candidate sets) targeting single-digit ms on this corpus;
  benchmark delta recorded against today's 201.72ms p50 baseline.
  ATTEMPTED 2026-10-16: rank tiebreak ordinals landed (numeric comparisons,
  semantics pinned by a differential oracle); corpus-scan tokens and
  Jaccard pruning were measured and reverted (no demonstrated win).
  FINAL MEASUREMENT CORRECTION (isolated A/B on the real corpus, 60-rep
  microbench): pre-ordinal 8.33/8.56ms vs ordinal 7.87/8.45ms per
  18-query batch — the pure search was ALREADY sub-millisecond per query,
  so the S10 single-digit target is met in steady state; the harness's
  155-220ms batch numbers were dominated by per-batch index rebuilds and
  measurement overhead, not search. Ordinals kept as a neutral-to-positive
  semantics-preserving cleanup; no bounded redesign needed for this
  target.

### Tier 3 — Step-change bets (product decisions, not bugs)

- T3.1 [S11] Shared proof ledger: design doc first (trust domains,
  namespace, revocation), then MVP behind a flag; the maturity gate
  (false-reuse 0) is already recorded — the open question is trust, not
  correctness.
- T3.2 [S12] Cross-repo entity federation: contract entities resolve
  across sibling repositories in the same workspace profile; start with
  the gentle-ai <-> gentle-shell contracts as the real pilot.
- T3.3 [S13] Semantic tier: opt-in hybrid discovery, isolated behind a
  flag, never part of fingerprint/reuse decisions; ship only with a
  measured query-quality delta, else drop.

## Acceptance criteria

- Every Tier 1 item: RED observed, suite green, typecheck 0, live probe
  recorded in this tracker with numbers.
- Tier 2 items: measured before/after (hint latency, usage-query p50,
  focused-test time saved per cycle, lexical p50) against recorded
  baselines from the dogfooding campaign.
- Tier 3 items: no implementation without an explicit user product
  decision recorded in the Log below.
- Global: no regression to the eight closure criteria of the original
  roadmap; kill switch or flag for every new fast path; false-reuse stays
  0 on the corpus.

## Log

- L1 (2026-10-16, user): "AGREGALO AL ROADMAP detalladamente" — this
  roadmap records the improvement analysis delivered after the final
  dogfooding verdict, grounded in the campaign's real friction.
- L2 (2026-10-16): Tier 1 executed and verified. Commits: 58bbba4b2 (T1.1
  smoke guard), c31a5db1e (T1.2 contention lock + WARNING, verified live
  in the incident scenario), 632c7bcd0 (T1.3 proof_coverage reverse
  query), 98f692de4 (T1.4 staleness indicator), cc7bdcb2a (T1.5
  empty-query shapes), e77623154 (T1.6 parser-version stamp with forced
  re-parse and fast-path ineligibility; live index reports stamp 1, 190
  entities intact). Each unit observed RED before GREEN except the two
  characterization/guard pins noted in the tracker (P13). Suite grew
  380 -> 386; typecheck 0 throughout; native assess over the tier range:
  medium, reviewDue false (under_budget). Tier 2 pending user approval
  for asset edits (T2.3) and scheduling; Tier 3 pending recorded product
  decisions.
- L3 (2026-10-16, user authorized Tier 2 + asset edits): Tier 2 executed.
  Commits: 1c308155b (T2.1 impact hints, ext 43/43), fb424f5d5 (T2.3
  ODD/skills integration: delegation briefs, verification focused-test
  selection, Explore facts_query, Specs dependents counts), af0dc5b08
  (T2.2 usage-site queries via recorded identifier references, suite
  392/392, runtime worker copy regenerated). T2.4 lexical performance:
  rank tiebreak ordinals landed with a differential-oracle pin; two
  further experiments (corpus-scan tokens, Jaccard pruning) measured no
  win and were reverted with their numbers; the single-digit target is
  NOT met and the bounded-ranking redesign stays as the open follow-up.
  Suite ended 393/393, typecheck 0.
