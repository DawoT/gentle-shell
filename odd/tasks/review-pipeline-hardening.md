# Feature: review-pipeline-hardening

## Intent and authorization

Fix the operational bottlenecks measured during dogfooding, highest software
engineering standards, TDD, sprints in order. User approved: in-repo sprints first,
upstream `gentle-ai` (Go) work deferred until needed (requires cloning that repo —
explicit authorization will be requested at that point). No push/PR/merge.

Branch: `odd/review-pipeline-hardening` (from current HEAD of odd/facts-informed-review).
Delivery: `auto-chain`, `feature-branch-chain` — one slice per sprint.

## Measured bottlenecks (evidence from dogfooding session)

1. Facade binding transcription: 4-6 bindings of 5-8KB JSON re-transcribed per
   review by the parent; one group capture REJECTED for dropped `value` fields.
   Protocol accepts full JSON only.
2. No safe recovery path for corrupt Facts locks: a 0-byte owner record blocked all
   Facts operations; manual recovery required reading facts-lock.ts internals.
3. Full-suite-only fixture races: empty-marker reads and non-hermetic child envs
   cost 3 extra full-suite runs; the atomic-marker pattern was hand-fixed twice.
4. Docs-only commits ring the full reminder cycle (reminder per mutation
   generation regardless of candidate class).
5. Review default base = accumulated branch base; parent must counter-slice every
   time (mismatch + stray-lineage incidents).

## Sprints (in-repo)

- [ ] S1 — Binding references in the capture facade. The capture/group tools accept
  an alternative input `{"bindingRef": N}` (or {bindingRef:"last-status", slot:N})
  resolving BYTE-EXACT to the Nth collectBinding of the most recent bound STATUS
  retained by the extension. Fail closed on missing/stale/out-of-range (typed
  error, same class as stale binding). Full-JSON path unchanged and takes
  precedence. No authority semantics change: refs resolve to provider-issued
  bytes only, never compose. Surfaces: extensions/gentle-ai.ts (capture tool
  input schema + resolution at parse site), tests/gentle-ai.test.ts, plus a new
  lib/review-capture-binding-ref.ts + tests if the resolution logic warrants a
  pure module.
- [ ] S2 — Facts lock doctor. Report mode: enumerate storage dirs (.pi/facts.lock,
  .pi/*cache*/facts.lock), validate each owner record against the recoverDeadOwner
  rules (version/pid/context/ESRCH) and classify valid-live / recoverable-dead /
  corrupt-unknown. Recovery mode (--recovery, explicit): remove ONLY
  corrupt-unknown or recoverable-dead locks via the same unlink+rmdir sequence,
  never touching storage data. CLI entry next to existing bin scripts; lib logic
  exported from facts-lock.ts (refactor: export pure validators, keep behavior).
  Tests: all classifications incl. the 0-byte incident shape.
- [ ] S3 — Shared atomic marker test utility. tests/support/atomic-marker.mjs:
  atomicWriteMarker(dir,name,content) (tmp+rename), waitForMarker (watcher +
  non-empty validation + timeout), restore for env-stripping not in scope.
  Migrate the fs-marker users: tests/facts-tree-pair.test.ts (none needed if no
  markers), tests/facts-commit.test.ts (withProbe/waitForMarker + worker shim),
  tests/support/facts-probe-worker.mjs (write side). No behavior change; tests
  stay green.
- [ ] S4 — Reminder suppression for docs-only mutations. The RDD reminder
  generator skips (or shortens) when the pending mutation generation contains
  only non-executable paths (docs/*.md, odd/**). Keep full reminder for anything
  executable. Surfaces: extensions/gentle-ai.ts reminder construction + tests.
- [ ] S5 — Closure: focused suites, typecheck, full pnpm test, per-slice reviews
  (user may decline via consent UI; record), receipts.

## Upstream backlog (blocked on cloning Gentleman-Programming/gentle-ai; ask then)

- U1: inject Facts subject digest into reviewer prompt materialization
  (measured 4x116KB redundancy).
- U2: risk tier from declaration-graph evidence instead of grep-level signals.
- U3: dispose/dismiss operation for stale open lineages (4c803bbb case).
- U4: default review base = last consumed boundary.

## TDD and constraints

Behavior changes test-first (observed RED→GREEN); characterization labeled.
S1 touches the review-authority path: refs must resolve byte-exact from
retained provider bindings, fail closed, never synthesize; full-JSON input
remains valid; native contract untouched. No credential/global config changes.
Review candidates are per-sprint slices vs last reviewed boundary; user may
decline via consent UI — record dispositions, never re-offer declined ranges.

## Verification

Per sprint: focused suites + `node scripts/check-types.mjs` (baseline 186,
no regressions). Closure: full `pnpm test`. Runtime modules: check
`scripts/build-runtime-modules.mjs` list — only build if generated sources
touched.

## Evidence

Exploration from session: capture parsing lives in extensions/gentle-ai.ts
(parseCanonicalReviewCaptureBinding, unwrapPublicCollectBindingWrapper);
lock rules in lib/facts/facts-lock.ts (recoverDeadOwner validators);
marker races fixed ad hoc in tests/support/facts-probe-worker.mjs and
tests/gentle-agents.test.ts; reminder text emitted per mutation generation.
No source mutation on this branch yet. Next: S1 writer, tests-first.
