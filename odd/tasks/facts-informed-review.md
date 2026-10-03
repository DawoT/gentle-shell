# Feature: facts-informed-review

## Intent and authorization

Reduce review-pipeline cost per iteration using the Facts index as insumo (never as
verdict authority). User approved: all TDD, sequential sprints U1→U2→U3, stacked on
`odd/facts-probe-lifecycle-acceptance` at `0cff1543`. No push/PR/merge.

Branch: `odd/facts-informed-review`. Delivery: `auto-chain`, `feature-branch-chain`
(forecast exceeds 400 authored lines: ~550–800, so slices are per sprint).
Measured motivation: reviewer prompts are 4×~116KB near-identical per high review;
risk signals are crude (tests/docs classified medium); advisory ids repeat across
consecutive reviews (42 raw entries, manual dedup).

## Contract boundary (hard)

Go/provider owns: verdicts, lens prompt bytes (verbatim/frozen), role selection,
risk-tier computation + reason codes, bindings, next_transition. TS in-repo may only:
map/annotate closures, compute digests, propose tiers for display, persist ledgers.
Never contaminate review authority or synthesize provider content. Staleness fails
closed: keys are `changedPathManifestSha256` + pinned generations.

## Sprints

- [x] S1 (U1) — DONE: `51ca2619` ledger (620 lines: lib 327, tests 150+73 hook) +
  doc `56d41e2f`. ReviewAdvisoryLedgerStore: lock+generation pattern, key
  `lens|id|location|manifestSha`, occurrences across differing manifests only,
  path-persisted fix receipts, 500-entry LRU, corrupt/empty fails closed+rebuilds,
  two-instance serialization. Hook: mapAndClearLastEventClosure async, additive
  `recurrence` annotation post-decode (provider schema untouched), ledger failures
  never break closure (swallow+warn, collision-tested). Group path plumbs frozen
  manifestSha; single-capture records "" and skips comparison (S2 plumbing).
  RED: module-load fail before lib existed (ledger suite); hook tests labeled
  triangulation. GREEN: ledger 10/10, gentle-ai 104/104, typecheck baseline.
  Independent verifier READY (114 pass; 4 non-blocking coverage gaps noted).
  Native review `review-de10c3d1d9695ae4` medium/1-lens approved+acknowledged
  (consumed `sha256:0025285ed0122494e7d344e8dab6a26a66bfdc2d71dc377f7f381ce7d2ec2f4b`,
  5 informational advisories: R3-evict-current, R3-fix-race, R3-staging-eexist,
  R3-untested-wiring, R3-wiring-gap — recorded as backlog).
- [ ] S2a (U2 compute) — Tree-pair subject digest: `indexFactsTree` on (baseTree,
  candidateTree) restricted to changed paths, keyed by `changedPathManifestSha256`,
  stored under a new source.kind "tree-pair"; fail closed when candidate tree moved.
- [ ] S2b (U2 inject) — Feasibility gate FIRST: verify whether the relay contract
  permits host framing around frozen prompt bytes (`lib/review-host-relay.ts:9,100`).
  If prohibited: digest stays parent-facing triage context; document the limit.
- [ ] S3 (U3) — Facts-informed tier PROPOSAL (display/advisory only) over digest +
  ledger + decoded risk_reasons; never replaces Go tier.
- [ ] S4 — Closure: focused suites, typecheck, full `pnpm test`, slice reviews per
  delivery strategy (user may skip via consent UI; record dispositions).

## TDD and constraints

Behavior changes test-first (observed RED→GREEN); characterization may be immediate
GREEN, labeled. No test-only production exports. Real fixtures, no sleep races
(atomic markers), POSIX skips explicit. Concurrent work untouched. Review candidates
are per-sprint slices vs last reviewed boundary; user may decline via consent UI —
record dispositions, never re-offer for declined ranges.

## Verification

Per sprint: `node --experimental-strip-types --test <touched files>`;
`node scripts/check-types.mjs` baseline-aware (186, no regressions).
Closure: `pnpm test` full, `pnpm run check:runtime-modules` if generated modules
touched (none planned).

## Evidence

Exploration (scout): no advisory persistence exists today; `indexFactsTree` accepts
arbitrary trees (facts-tree.ts:42); `changedPathManifestSha256` flows start/status
(review-integration-v2.ts:1142,2058); Go boundary at native-review-cli.ts:803 /
review-risk-assessment.ts:74-79; relay bytes verbatim (review-host-relay.ts:9,100);
FactsStore generations pin frozen state (facts-store.ts:37-95). No source mutation
yet. Next: S1 writer, tests-first.
