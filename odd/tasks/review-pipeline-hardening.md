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
- [x] S2 — Facts lock doctor DONE: `88bc02b3` (doctor lib 121 + CLI 48 + tests 299).
  `node bin/gentle-facts-doctor.mjs [storageDir...] [--recovery] [--json]`: classifies
  absent/empty-dir/valid-live/valid-unknown-liveness/recoverable-dead/corrupt-unknown
  with rules transcribing recoverDeadOwner exactly (verifier: zero parity divergence,
  incl. O_NOFOLLOW + 4097-byte cap + EPERM-as-live). --recovery removes only
  recoverable-dead/corrupt-unknown/empty-dir (unlink+rmdir), never valid-* nor storage
  data. Exit 1 iff recovery still needed. facts-lock.ts refactor exports-only
  (readProcessContext); behavior byte-identical. 22 new tests incl. the exact 0-byte
  incident shape + real dead-pid ESRCH; lock 12/12, store 38/38, CLI exercised live
  (forged-context → corrupt-unknown, exit 1, data intact); typecheck no regressions.
  Review `review-0f8f3180c2ba9c63` medium/1-lens approved+acknowledged (consumed
  `sha256:1d7e2bcdfe3e742c90280fb5f3b31ef0dfc63913de27409237e454fdad97dfa5`; 3
  informational advisories backlog: R3-crash-nonregdir WARNING,
  R3-flaky-deadpid, R3-missing-nonregdir-coverage).
- [x] S3 — Atomic marker utility DONE: `07cefa0b` (utility 5 tests + migration).
  tests/support/atomic-marker.mjs: atomicWriteMarker (tmp+renameSync) + waitForMarker
  (fs.watch + initial check + non-empty validation + named 20s timeout, watcher/timer
  cleaned on all paths). Migrated: probe worker's three writes + facts-commit's local
  waitForMarker (formats unchanged; pid+starttime parse stays at call site). NOT
  migrated (no fs markers): facts-tree-pair, facts-extension (IPC only), gentle-agents
  env fixtures. Structural find: the probe fixture's bin copy needs the module copied
  alongside (first GREEN run failed 5x on ENOENT — fixed). RED module-load; GREEN 5/5
  + 27/27 + 22/22; typecheck no regressions. Migration labeled characterization.
  Review `review-99f4a8773d7eb69e` medium/1-lens approved+acknowledged (consumed
  `sha256:5cd22dcfc006e0f14cf9ca4e722706b164ceb5baa9ba7c3a496f13975b066628`; 4
  informational advisories backlog: R3-fs-watch-throw WARNING, R3-helper-copy-coupling,
  R3-vacuous-race, R3-validate-throws).
- [x] S4 — Docs-only reminder suppression DONE: `1a98a132` (+128/-3 in
  extensions/gentle-ai.ts + tests). Seam: renderAgentEndReviewPreflightMessage
  (~:7643) + emission at agent_end (~:10066). Compact variant for all-non-executable
  generations (.md, or under odd/ or docs/ — default-deny) keeps target sha +
  inspect-on-demand + leave-unreviewed note, drops START/consent paragraphs. Any
  executable file or unknown path list → full variant (fail open). Path visibility
  best-effort: tool_result seam → capped map (256) pruned via nudged receipt id;
  subagent-written/evicted paths fail open. Emitter timing/authority untouched.
  RED: 3 tests failed on unexported renderer. GREEN: 114/114; typecheck no
  regressions. Review `review-def635572087fdc2` medium/1-lens approved+acknowledged
  (consumed `sha256:533b47c62d683ce9514cf5b67df94280394181db7e8fb9cfb0c65fb617ae71c5`;
  4 informational advisories backlog: R3-prune-heuristic WARNING,
  R3-input-path-undefined, R3-integration-untested, R3-prune-order-assumption).
- [x] S1.1 — DONE: `fabc4d1d`. Frozen sha plumbed as optional trailing param through
  executeReviewHostRelayCapture + executeProviderRoleVectorCapture into
  mapAndClearLastEventClosure at every site (incl. correction-plan mapping), sourced
  from the already-negotiated STATUS (no second negotiation, no parallel cache).
  RED: exact assertion diff "+ sha / - ''"; first GREEN attempt silently misrouted
  the sha into implicitWorkspaceRoot — caught by the still-failing assertion.
  GREEN: gentle-ai 111/111, ledger 10/10; verifier PASS traced every call site
  argument-by-argument (swap-silent risk). Native review `review-bcbe3f8db8554c43`
  medium/1-lens approved+acknowledged (consumed
  `sha256:3a4c30d2e3e3e3061f1537d0e57b91b7992f86e2124610396fb5ef148c9b1a56`; 2
  informational advisories backlog: R3-optional-frozen-sha,
  R3-provider-ledger-coverage). Live proof deferred to next reload: this session's
  process still runs pre-fix mapping, so closures until then keep recording "".
  Legacy ""-entries (9) stay open, documented.
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
