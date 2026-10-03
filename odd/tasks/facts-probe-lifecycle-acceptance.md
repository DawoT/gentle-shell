# Feature: facts-probe-lifecycle-acceptance

## Intent and authorization

Stabilize the current branch, completing Facts acceptance and the routing/Codex-native
WIP dependency closure. The user authorized local work-unit commits and a
feature/tracker branch chain, chose Codex experimental/opt-in, and confirmed other
writers are paused. No push, PR, merge, global/model configuration changes,
destructive Git, review abandonment, reset, or recovery is authorized.
Original WIP authorship is not established. Preserve existing behavior unless a
verified defect or the explicit opt-in policy requires a change.

Branch: `odd/facts-probe-lifecycle-acceptance`.
Initial boundary: `f6c7c6e3019db0f7f875a7e661191ba51a476cf6`.
Delivery: `auto-chain`, `feature-branch-chain`.
Original Facts forecast: 320–530 authored lines. Expanded Codex closure is a separate
review slice; include existing untracked lines in its count. T1 code count: 199
(additions + deletions: 187 + 12), not the previously reported additions-only 187.

## Architectural decisions and constraints

- Cancellation classification uses first-abort provenance, not caller reason text.
- Await Git child close and bound termination escalation. Preserve the public
  comparison signature/union, Git environment isolation, 15s per-command deadline,
  capture cap, and untracked-as-differs semantics.
- Synchronization integration tests exercise registered tools with real Git. Ignore
  generated `.pi/` caches in isolated clean fixtures.
- Writer locks already wait up to 15s with 25ms abortable polling. No nested retry,
  longer latency budget, or reclaim of legacy/unknown owners without new evidence.
- Codex registration/use is explicitly experimental and opt-in. Ordinary tests must
  not read real credentials or perform inference. Opted-in live tests need a deadline.
  Validate auth fields and preserve HTTP Request semantics; credential-bearing
  endpoint overrides must remain local loopback, not arbitrary remote origins.
- Existing routing normalization and pin precedence must remain coherent with the
  Codex child-extension dependency. No credential files may be read or written.
- No generalized retry/process framework or public API solely for tests. Use real
  process boundaries, readiness handshakes, bounded cleanup and no sleep-based races.

## Classification and execution

T1/T2: R1×M. S1 credentials and T3 shared-concurrency characterization: R2×M.
One bounded writer at a time; separate read-only verifier and immutable native review.
Prompt restrictions are not claimed as a verified sandbox. Human review remains
required before merge for sensitive units; no cryptographic SHS certification,
forged signatures, governance bootstrap or isolation guarantee is claimed.
Use observed behavioral RED→GREEN before production changes. Characterization of
already-correct behavior may be immediately GREEN; record that honestly. Native
review covers a work unit/PR slice, never an accumulated feature branch or checkbox.

## Tasks

- [x] T1 — DONE: code `89c2f6cd`, tracking `e3ca739f`. Typed first-failure provenance,
  stable `git cancelled`, child-close settlement, 250ms SIGKILL escalation and
  timer/listener cleanup. Fifteen real-subprocess cases added, public API unchanged.
  RED: 27 tests/12 pass/15 fail before production writes. GREEN: 27/27 focused,
  Facts249/249, baseline typecheck186/no regressions, runtime parity11. Independent
  verifier confirmed focused27/27 and typecheck, first-origin retention, real15.26s
  deadline and PID absence before return. POSIX lifecycle cases skip on Windows;
  stderr/multibyte/second-command deadlines, descendants and synchronous spawn-throw
  cleanup were not verified. Native unit review remains pending (see authority note).
- [x] S1 — DONE: three functional groups committed and reviewed.
  A routing normalization `fdba399c`; B standalone opt-in provider `2a675ba3`
  (review `review-5c8c33e43ed32190` approved, authority burned, revision
  `sha256:62b4b1bef4d20a4628473aeb04a290e8acec6a109e0f4fa2088bc7bf199e7108`, 14
  informational advisories); C child integration + hermetic fixture `e58597d5`
  (192/192 routing, offline Codex 26/26, live skip by default). Project-local
  repair: `.pi/subagents.json` default model set to the already-declared
  `zai/glm-5.3-flash` after the opt-in gate made the codex default unregisterable
  (git-ignored file; user asked for the fix; no global/model config changed).
- [x] PR-slice review T1+A+C+docs: `review-4d9987194c26b39b` approved and
  acknowledged (base `f6c7c6e3`, 20 files/1422 lines, target
  `sha256:65fc37c91725ff27c12590793e3bb54847e07fa150e8f5eb89a94f5546c0ac27`,
  consumed `sha256:120daf50fb8718c1102abd1ca12329a1c7e49461ba733abb27134b8ebd9de2e2`,
  authority burned). 17 informational advisories logged as future backlog
  (provider duplication/complexity, thinking-alias duplication, auth JWT/claim
  suggestions, test-coverage suggestions). A first START attempt failed closed
  on an expired consent binding (`consent-binding-expired`, no lineage); the
  retry minted a fresh envelope and completed.
- [x] T2 — DONE (`8439152c`): four real-Git integration tests pin the facts_commit
  synchronization contract (match/differs/unavailable messages, details.synchronization
  with outcome/elapsedMs/reason, untracked-only differs, comparison-only shim failure
  after successful indexing). Fixture now ignores .pi/ before its initial commit.
  Unavailable wording made cancellation-honest. RED 34/33/1 on old wording, then GREEN
  34/34 + 27/27; typecheck baseline unchanged.
- [x] T3 — DONE (`ff8ba749`): five cross-process characterizations of the commit-cache
  writer lock with IPC handshakes (no marker races): serialization, mid-wait
  cancellation (AbortError, foreign record untouched), SIGKILL recovery via valid
  identity, 0-byte corrupt record fails closed (15s then FactsBusyError, matching the
  restart incident), lock dir fully removed after release. Characterization only — no
  production change, no defect found. Lock 12/12, process 5/5, crash-recovery skips
  non-linux.
- [x] Review disposition T2+T3 slice: consent for this candidate was DECLINED by the
  human in the host UI (`consent-declined-this-candidate`; medium, 5 files/365 lines,
  target `sha256:628da831de45874a8100d5d5fe670ae58eeadf7c6d7b87719197565ced3fa711`,
  no lineage created). Candidate-scoped skip; delivery follows ordinary repository
  policy; future candidates still ask. Recorded, not re-run.
- [x] Restart incident: Facts unavailable after restart — `.pi/facts.lock` held a
  0-byte owner record (unknown owner, fail-closed by design). Manual recovery:
  unlink record AND rmdir the lock directory (an empty dir is never self-reclaimed).
  Facts reindexed 551 files / 7188 symbols; procedure recorded in memory and below.
  Full suite after T2+T3: 5033 tests / 4998 pass / 0 fail / 35 safe skips; typecheck
  186 baseline, no regressions.
- [x] S2 — DONE: full-branch closure verified. First full `pnpm test` runs
  exposed three fixture defects (not production regressions): the probe worker's
  ready marker could be read empty between create and write (pid 0 → kill(0,0)
  hits the process group), the deadline test hit the same race on the terminated
  marker, and the dev-binary surfacing fixture inherited managed-child markers
  (shellEnabled false → toast fallback). Fixed test-side: atomic write+rename
  markers, non-empty marker validation, /proc-starttime identity exit assertion
  with ESRCH fallback, child-marker stripping with restoration. Final full suite:
  5025 tests / 4990 pass / 0 fail / 35 safe skips (live opt-in, platform),
  provider-contract and runtime-harness stages pass; typecheck 186 baseline, no
  regressions; runtime parity 11. The codex-web bridge runtime test passed
  isolated and in the green full run after one load-sensitive failure — watched,
  not patched. Commit `71155878`.
  Stale open lineage `review-4c803bbb8b5f5886` (old 5-file routing WIP candidate,
  no captures) awaits user disposition; not abandoned without authorization.
  Remaining scope: T2 (synchronization message/details assertions) and T3
  (commit-cache contention characterization) stay PENDING as the next Facts
  follow-ups. No push/PR/merge performed. Advisory backlog: 14 (provider slice)
  + 17 (PR slice) informational findings.

## Verification commands

Focused routing: `node --experimental-strip-types --test tests/agents-config.test.ts tests/gentle-agents.test.ts`.
Codex offline: run the four non-live `tests/codex-native-*.test.ts` files explicitly.
Facts: `node --experimental-strip-types --test tests/facts-commit.test.ts tests/facts-extension.test.ts tests/facts-lock.test.ts tests/facts-process.test.ts`.
Closure: `pnpm test:facts`, `pnpm test`, `node scripts/check-types.mjs`, extension
syntax checks and `pnpm run check:runtime-modules`. Build only affected generated
modules. Typecheck is baseline-aware, not diagnostic-free. Live Codex inference is
not authorized by the stabilization request; tests must skip without reading auth.

## Authority and incident evidence

ASSESS failed with undeclared untracked paths; conservative high verification was
satisfied by writer and separate verifier. Committed-range START returned
`native-start-retained-selection-candidate-mismatch`: selector/candidate mismatch,
not proven inventory churn. Repeated inventory
`sha256:26e554098224bc50e5aad01aa758f108f773aa79cc855c9ae4c2170bc3f91cb8` stayed stable.
Resolving workspace selection created `review-4c803bbb8b5f5886` on five routing paths,
not T1 or the untracked Codex closure. It remains reviewing; no capture or
acknowledgement observed. Do not infer approval of any broader unit.
A task-file status differed from an earlier parent write; attribution was not
established. Reconciled from observed evidence, not an assertion of another actor.
An initial live Facts declaration query was blocked by cache contention; no lock
recovery used. Source-derived scout found malformed-auth trim TypeError, ungated live
inference and dependency on untracked Codex extension.

## S1 partial evidence and active blocker

Writer observed RED (offline20:17pass/3fail; additional redirect/default-provider/
child-gate failures), then offline GREEN26/26. Routing192:191pass/1fail; inherited
Web-subagent fixture reads `.execute` from undefined tool (also failed before the
production child-gate edit). Live test with explicit disabled flags:1 safe skip,
no real auth/inference. Typecheck186/no regressions and runtime parity11 passed.
No full suite or independent S1 verdict yet; do not mark S1 done or commit as verified.
Full S1 footprint1050 lines: routing normalization24 + coherent Codex1026; independent
slicing diagnosis pending. Do not minify/remove tests or split broken dependencies.
Verifier launch failed: `could not select model codex-native/gpt-6.1-sol in child;
provider unavailable`. Read-only incident checks confirmed project
`.pi/subagents.json` default model is that Codex model, while runtime
`GENTLE_CODEX_NATIVE` is unset and the extension registers only for exact value `1`.
No global/project model configuration was changed. User must explicitly opt in this
harness runtime or authorize a different available model before delegated work can
resume. Live acceptance remains separately opt-in and is not authorized.
Next: resolve harness opt-in/routing; diagnose fixture, verify slices, finish S1,
then T2/T3 and full branch gates. No new commit since `e3ca739f`.
