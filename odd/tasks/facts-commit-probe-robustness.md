# Feature: facts-commit-probe-robustness

Round 5 of dogfooding. The recurring WARNING cluster (4 advisories across 3 reviews)
converges on `commitMatchesWorkingTree` (lib/facts/facts-commit.ts) — recurring findings
are a design signal, not noise.

## Context (advisory evidence)

- `R3-git-status-failure-conflation` (facts-commit.ts:36-46): the catch-all returns
  `false`, indistinguishable from "tree differs". The extension then renders "working-tree
  edits ... not included" — claiming edits exist when git may simply be unavailable.
- `R4-maxbuffer-silent-false` / `R3-gitstatus-maxbuffer`: `maxBuffer: 1 MiB` — output
  truncation throws and is caught into the same `false`.
- `R4-git-probe-latency` / `R4-sync-observability`: no timing, no reason, no visibility
  into which comparison path was taken.
- `R2-git-timeout-constant` / `R2-git-runner-name`: 15_000 magic number; the runner is
  named "status" but also runs rev-parse.
- `R3-porcelain-untracked`: untracked files count as "differs" — keep (honest: the
  working tree differs from the commit), now documented explicitly.

## Task (single cohesive work unit)

1. lib/facts/facts-commit.ts:
   - Rename `gitStatusCommand` -> `runGitCommand` (it runs rev-parse too); extract
     `GIT_COMMAND_DEADLINE_MS = 15_000`.
   - Replace `commitMatchesWorkingTree` with an exported tri-state API (no legacy alias —
     the extension is the only consumer, both are unreleased):
     ```ts
     export type CommitWorkingTreeComparison =
       | { outcome: "match"; elapsedMs: number }
       | { outcome: "differs"; elapsedMs: number }
       | { outcome: "unavailable"; reason: string; elapsedMs: number };
     export async function compareCommitToWorkingTree(cwd: string, commitId: string, signal?: AbortSignal): Promise<CommitWorkingTreeComparison>
     ```
     Semantics: match = HEAD equals commitId AND `status --porcelain` empty; differs =
     HEAD differs OR status non-empty; unavailable = git missing/failed/deadline
     exceeded/output truncated (maxBuffer, error code ENOBUFS or maxBuffer message)/signal
     aborted, each with a distinct `reason` string. Untracked counting documented in the
     doc comment. Never throws.
   - Small pure helper `describeGitFailure(error: unknown): string` for the reason
     mapping (testable directly).
2. lib/facts/facts-commit-extension.ts: render three honest lines — match (unchanged
   wording), differs (unchanged wording), unavailable (new: "Committed facts could not be
   compared to the working tree (git unavailable or timed out)."); add
   `details.synchronization = { outcome, elapsedMs, ...(reason) }` for observability.
3. tests/facts-commit.test.ts: test-first RED -> GREEN. Match/differs already exist as
   boolean assertions — migrate to tri-state. New: git-missing -> unavailable with
   reason (existing PATH-shim pattern); deadline exceeded -> unavailable reason; maxBuffer
   truncation -> unavailable reason (PATH shim emitting >1 MiB or a direct
   describeGitFailure unit case); elapsedMs present and >= 0 on all outcomes;
   describeGitFailure unit cases.

## Verification plan

- Focused RED -> GREEN: node --experimental-strip-types --test tests/facts-commit.test.ts
- Full: pnpm test:facts tail; typecheck regression verdict (orchestrator).
- Work-unit commit on feature branch `odd/facts-commit-probe-robustness` (stacked).

## Non-goals

- No change to untracked-file semantics (documented, stays "differs").
- No parallelization of rev-parse/status (correctness first; latency now observable).
- No extension-body unit tests (Pi runtime unavailable in tests — established pattern).
- The other ~30 backlog advisories stay backlog.

## Outcome (2026-10-03)

- Status: CODE COMMITTED, NATIVE REVIEW APPROVED; additional independent verification
  is pending due to verifier model routing. Commit `2456b1da`: tri-state `compareCommitToWorkingTree`
  (match/differs/unavailable + reason + elapsedMs), `runGitCommand` rename,
  `GIT_COMMAND_DEADLINE_MS`, `describeGitFailure` mapping (ENOBUFS/missing/deadline/
  failed), extension renders three honest lines + `details.synchronization`.
- Tests: focused 12/12 (RED->GREEN), facts suite 234/234, typecheck no regressions.
- Advisories closed by this unit: R3-git-status-failure-conflation, R4-maxbuffer-silent-
  false, R3-gitstatus-maxbuffer, R4-git-probe-latency (now observable),
  R4-sync-observability, R2-git-timeout-constant, R2-git-runner-name.
- Next (user-owned): delivery (push/PR/merge) under ordinary repository policy.

## Review status: APPROVED and acknowledged

- Correction to the interruption report: transcript corruption was not established.
  The earlier group call returned a valid forecast and ran no reviewers; the parent
  stopped prematurely. No provider rejection proved a channel integrity defect.
- Resumed lineage `review-5bb532c10727596e` using its current provider bindings.
  Four reviewers were prepared and admitted; native closure was `approved` with
  12 non-blocking advisories. They are separate later work, not correction obligations.
- Exact acknowledgement succeeded: target
  `sha256:0eb291915383d1f4b59f64294af4a480b9716e9c10983aad023d6e97b051fddf`,
  consumed revision
  `sha256:675c4f2df7e3317fe7f5d7c42bd26009e9b9e4a3472fa43af6ee7f2ceab3c199`,
  authority `burned` (`gentle-ai.review-acknowledged/v1`).
- The prior 14-line documentation delta was separately approved and acknowledged as
  low tier, with no lenses, under `review-c2ec481d51c30659` for target
  `sha256:ac68249519ed93ef331bf158942ebcc92b8fa502e28dbf98fbcfc72fefb9dacf`.
- Review scope limitation: the already-open code lineage covered the stacked
  29-file / 1191-line range, not only this work unit. Future starts should use a
  work-unit or PR slice rather than the accumulated feature branch.

## Additional verification: RESOLVED post-reload

- A fresh `gentle-ai-verify` run succeeded after reload (no model routing failure;
  no configuration changed by this session). Observed: focused 12/12, Facts 234/234,
  typecheck 186 baseline/no regressions, extension syntax check, 11 runtime modules
  match. Read-only live probes: dirty HEAD differs (~14ms), older commit differs,
  preaborted signal unavailable, missing Git (isolated PATH) unavailable with reason
  "git is not available".
- Parent live Facts checks: tri-state indexed at HEAD, legacy boolean only in history;
  `facts_commit(HEAD)` pins the commit and renders the honest snapshot disclaimer;
  repeated queries return the same generation; one transient parallel cache-writer
  lock refusal resolved by sequential retry.
- Known coverage limits at that boundary (superseded by the follow-up feature
  `facts-probe-lifecycle-acceptance`): cancellation-vs-deadline conflation, no real
  deadline/buffer-exhaustion probes, no extension synchronization assertions,
  no cross-process commit-cache contention coverage. Clean-match coverage existed
  only in fixtures; the checkout was dirty.
