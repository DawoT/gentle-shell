# Feature: facts-probe-lifecycle-acceptance

## Intent and authorization

Strengthen Facts Git comparison reliability and observable tool contracts after live
dogfooding. User authorized implementation, a feature branch, local work-unit commits,
and a feature/tracker branch chain. No push, PR creation, merge, model configuration,
or changes to unrelated concurrent work are authorized.

Branch: `odd/facts-probe-lifecycle-acceptance`.
Starting boundary: `f6c7c6e3019db0f7f875a7e661191ba51a476cf6`.
Delivery strategy: `auto-chain`; chain strategy: `feature-branch-chain`.
Forecast: 320–530 authored changed lines, generated output excluded. Three reviewable
units, each with behavior/tests/evidence together. Running committed count: 0.

## Problem and architectural decisions

- Cancellation currently loses provenance: preabort and arbitrary reasons can appear
  as deadlines or generic Git failures. Track abort origin, not user reason text.
- The comparison runner can return on callback before the child closes. Adopt the
  existing Git-object lifecycle pattern: await close, bounded kill escalation.
- Extension synchronization text/details need consumer-level integration assertions.
  Fixtures must ignore `.pi/` so indexing does not dirty an otherwise clean tree.
- Cache writer locking already polls every 25ms for up to 15s. Do not add nested retry,
  extend latency, or reclaim legacy/unknown owners. Characterize contention first.

## Constraints and acceptance

Keep the public comparison signature and match/differs/unavailable result shape.
Untracked files still count as differs. Keep Git environment isolation, the 15s
per-command deadline, and capture cap. No generalized retry/process framework or
public timeout API solely for testing. Use isolated fixtures, real subprocesses,
readiness handshakes, bounded cleanup, and no fixed sleep-based race assertions.
No shared-checkout cleanup, destructive Git, test-only production methods, invented
RED evidence, or re-opening consumed review lineages.

Use test-first for behavior changes: observed expected RED, minimal GREEN, refactor.
For tests characterizing existing correct behavior, immediate GREEN is legitimate;
record it as characterization, not invented RED. Independently verify commands and
native risk assessment; source changes require current native review when RDD is on.
Review only the unit or PR slice, not the accumulated stacked feature history.

## Classification and isolation

T1/T2: R1×M (local subprocess lifecycle and extension integration), delegated writer
because multi-file edits/preparation exceed inline scope. T3: R2×M characterization
of shared cache concurrency; no shared lock production edit without new evidence.
Use a separate read-only verifier and native immutable-tree reviewers. Prompt scope
is not claimed as a verified sandbox; concurrency acceptance requires human review
before merge. No SHS cryptographic certification or isolation guarantee is claimed;
no governance bootstrap or forged A/V signatures is in this feature's scope.

## Tasks

- [x] T1 — **DONE** (`89c2f6cd`): typed first-abort provenance (caller/deadline/buffer)
  rejects as GitProbeFailure; `describeGitFailure` returns "git cancelled" for any
  caller reason; settlement waits for child close with 250ms SIGKILL escalation;
  timer/listener cleanup on close. Public API/union unchanged. 15 new real-subprocess
  tests with readiness handshakes; POSIX-only probes skip on Windows.
  Evidence: RED 27 tests / 12 pass / 15 fail before production writes; GREEN 27/27
  focused, Facts 249/249, typecheck 186 baseline no regressions, 11 runtime modules
  match. Independent verifier confirmed current 27/27 + typecheck, first-origin
  preservation, PID-gone-before-return, real ~15.26s deadline. Verifier-noted gaps:
  no stderr-overflow/multibyte/second-command-deadline cases, Windows unverified,
  descendant cleanup unproven. Running committed count: 187. (Doc anomaly: this
  entry was externally mutated to "VERIFIED, COMMIT/REVIEW PENDING" between parent
  writes; concurrent actor suspected; reconciled to committed evidence.)
- [ ] T2 — **PENDING**: assert visible match/differs/unavailable synchronization
  messages and metadata through existing mock Pi tool registration with real Git.
  Include clean fixtures and isolated untracked changes. Update unavailable wording
  if needed to cover cancellation honestly. Surfaces: `tests/facts-extension.test.ts`,
  `tests/facts-commit.test.ts`, `lib/facts/facts-commit-extension.ts`.
  Route: delegated writer, independent verifier.
- [ ] T3 — **PENDING**: characterize cross-process commit-cache contention, release,
  cancellation and owner preservation with readiness gates. No production retry by
  default; any proven production defect requires rescoping before a writer touches
  lock code. Surfaces: `tests/facts-lock.test.ts`, `tests/facts-process.test.ts`,
  `tests/support/facts-commit-worker.mjs` if needed. Route: delegated writer and
  independent verifier. Close with applicable full Facts checks and live acceptance.

## Verification

- Focused: `node --experimental-strip-types --test tests/facts-commit.test.ts`.
- Integration: `node --experimental-strip-types --test tests/facts-extension.test.ts`.
- Lock/process: `node --experimental-strip-types --test tests/facts-lock.test.ts tests/facts-process.test.ts`.
- Closure: `pnpm test:facts`, `node scripts/check-types.mjs`,
  `node --experimental-strip-types --check lib/facts/facts-commit-extension.ts`,
  `pnpm run check:runtime-modules`.
- Before this feature: 12/12 focused, 234/234 Facts, typecheck baseline 186/no
  regressions, 11 runtime modules match. No zero-diagnostic claim.
- Build generated modules only if affected by the actual changed import graph.
  Full `pnpm test` may involve concurrent unrelated changes; report actual outcomes.

## Evidence and next action

Exploration: comparison runner conflates abort/deadline, while Git-object runner
already waits for close and escalates; lock already has bounded abortable polling.
T1 writer evidence: expected RED exit 1 (27 tests: 12 pass/15 fail), then GREEN
27/27; full Facts 249/249; typecheck baseline 186/no regressions; runtime parity11.
Independent verifier: focused27/27 exit0 (~19.46s), typecheck exit0/no regressions.
Real deadline ~15.26s; actual1MiB+1 stdout capture and hostile SIGTERM-ignore child;
PID absent before cleanup. First-origin deadline survived later caller cancellation.
Private typed failures, child.close settlement,250ms escalation; no new exports.
Native ASSESS could not classify due untracked inventory: treated as high and ran
independent verifier. Commit and fresh bounded native review remain pending.
Platform gaps: POSIX lifecycle probes skip Windows; descendant cleanup, actual stderr
exhaustion/multibyte boundaries and synchronous execFile-throw cleanup not verified.
These are coverage limits, not assertions that the paths passed. Next: commit T1.
Unrelated agents/model-routing/Codex-native edits and the prior tracking document
are retained outside every unit's staging scope.
