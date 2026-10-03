# Feature: dogfooding-review-ux

Second dogfooding round: three gaps surfaced while the facts-gap-fixes candidate went
through the live native review (consent relay, capture group, reviewer routing).

## Context (evidence from the live run)

- Gap A: the reviewer-model refusal reads "no model is configured for review-risk;
  assign it a model in the agent model routing config" (`lib/review-host-relay.ts:612`)
  without naming any file. The operator must read source to discover the config lives at
  `gentleAiConfigHome()/models.json` (`~/.pi/gentle-ai/models.json`) with legacy project
  fallback `<cwd>/.pi/gentle-ai/models.json` (`extensions/gentle-ai.ts:1890-1903,
  readSavedModelConfig:1943`).
- Gap B: a consent envelope emitted by the native CLI (`review start --consent=relay`)
  is not answerable through the facade (`consent-binding-stale`,
  `consent-binding-unknown`). Investigation shows this is **by design**: consent
  bindings are session-held (`PendingReviewConsentRegistry`), the 10-minute window and
  cross-session refusal are asserted in `tests/native-review-parity.test.ts:333-338,
  464-483`, and the identical flow was already recorded in
  `odd/tasks/nan-usage-active-model.md:91`. Security property, not a bug.
- Gap C: fresh STATUS projects collect slots wrapped as `{"collectBinding": "<json>"}`
  (`publicReviewCaptureBindings`, `extensions/gentle-ai.ts:5905-5928`), but
  `gentle_review_capture_group` canonicalizes submitted entries as-is
  (`executeReviewCaptureGroupOperation:7978` via `parseCanonicalReviewCaptureBinding`),
  so echoing the facade's own wrapper shape can never match and fails with the
  misleading reason "collectBindings must be the complete distinct current reviewer
  group in exact provider order" (`:7731`). Single capture passed only because the
  operator submitted the unwrapped object.

## Tasks

### T1: Accept the facade's own STATUS binding shape in capture tools
- Extend `parseCanonicalReviewCaptureBinding` (extensions/gentle-ai.ts:7581): when the
  parsed value is a record whose only key is `collectBinding` (string or object),
  unwrap it and canonicalize the inner value (recursively). Real collect inputs never
  have a lone `collectBinding` key (they carry arguments/artifactSubject/submission/...),
  so the unwrap is unambiguous; document it as accepting the facade's public STATUS
  projection.
- This fixes both `gentle_review_capture` and `gentle_review_capture_group` (both go
  through the same parse) and makes the group's distinctness check compare unwrapped
  canonical forms.
- Test-first (RED -> GREEN) through the existing `__testing` harness in
  `tests/review-host-relay-routing.test.ts`: group accepts wrapper-shaped entries and
  proceeds; single capture accepts the wrapper; a non-collect-binding lone-key record
  still refuses. Unit-level parity: canonical(parse(wrapper)) === canonical(inner).
- Evidence: commit `7281025e` (+3 tests; 46/46 in the routing suite; check-types no
  regressions)

### T2: Name the model routing config path in the reviewer refusal
- Add optional `routingHint?: string` to `ReviewHostRelayRequest`
  (`lib/review-host-relay.ts`); when the selection is missing and the hint is present,
  the typed refusal appends it: "… assign it a model in the agent model routing config
  (<hint>)". Without a hint the message is unchanged (defense in depth preserved).
- Extension call sites (`extensions/gentle-ai.ts:7185` and `:8024`) pass a hint naming
  both resolution candidates: the global config home `models.json` and the legacy
  project `.pi/gentle-ai/models.json`.
- Test-first: refusal message includes the hint when provided and stays unchanged when
  absent.
- Evidence: commit `33b46114` (+2 tests, exact-equality both ways; relay suite 45/45,
  routing 46/46; check-types no regressions). Note: this branch also carries the
  user's own `ed0dd38d` (interactive facts_status wired to the classified summary),
  inherited at branch point.

### T3: Disposition Gap B as by-design (documentation only)
- Record in this doc + the Engram mirror that the consent-binding session scoping is a
  deliberate security property (evidence: parity tests + prior feature doc). No code
  change; closes with this doc's commit.
- Disposition: BY DESIGN — consent bindings are held per Pi session
  (`PendingReviewConsentRegistry`), the 10-minute window and cross-session refusal are
  asserted in `tests/native-review-parity.test.ts:333-338,464-483`, and the identical
  CLI-relay flow was already recorded in `odd/tasks/nan-usage-active-model.md:91`. The
  facade diagnostic already names the recovery (fresh START for the candidate). The
  live "failure" was operator error: the envelope was requested through the native CLI
  outside the facade session, so the facade correctly refused a binding it never held.
- Evidence: commit `<pending>` (this doc)

## Verification plan

- Per task: focused RED -> GREEN via `pnpm test:facts`? No — these live outside the
  facts glob. Use the package's node:test suites covering the touched files
  (`tests/review-host-relay-routing.test.ts` and siblings) plus `pnpm test` targeted
  runs as the writer observes.
- Final: relevant full suites via verifier agent.
- Work-unit commits on feature branch `odd/dogfooding-review-ux` (stacked on
  `odd/facts-gap-fixes`, which holds the approved previous feature).

## Non-goals

- No change to the native Go binary or to the session-scoped consent security model.
- No change to STATUS public projection shape (unwrap happens input-side).
- No work on the 13 advisory review findings (recorded separately on
  odd/tasks/facts-gap-fixes.md).
- No delivery (push/PR/merge) — user decision.

## Outcome (2026-10-03)

- Status: COMPLETE + REVIEWED. Commits: `7281025e` (T1), `33b46114` (T2), `6696a511`
  (docs/T3). The branch also carries the user's own `ed0dd38d` (interactive facts_status
  wired to the classified summary), inherited at branch point.
- Independent verification (gentle-ai-verify): focused suites 91/91; broader
  native-review suites 123/123; typecheck no regressions; diff scope exact per commit.
- Native review (lineage `review-72f3ef1383703846`, tier high, 4 lenses on
  `zai/glm-5.3-flash`): **approved**, authority burned (`gentle-ai.review-acknowledged/v1`,
  consumed `276b793e…`). 10 non-blocking advisory findings (9 SUGGESTION, 1 WARNING
  `R3-gitstatus-maxbuffer` in `lib/facts/facts-commit.ts:34-36`) — separate later work.
- Live note: the session's running extension predates T1, so live captures used the
  unwrapped shape; the wrapper parity fix benefits sessions started after `7281025e`
  (covered by the new routing tests).
- Next (user-owned): delivery (push/PR/merge) under ordinary repository policy.
