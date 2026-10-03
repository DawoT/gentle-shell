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

- Status: COMPLETE. Commit `2456b1da`: tri-state `compareCommitToWorkingTree`
  (match/differs/unavailable + reason + elapsedMs), `runGitCommand` rename,
  `GIT_COMMAND_DEADLINE_MS`, `describeGitFailure` mapping (ENOBUFS/missing/deadline/
  failed), extension renders three honest lines + `details.synchronization`.
- Tests: focused 12/12 (RED->GREEN), facts suite 234/234, typecheck no regressions.
- Advisories closed by this unit: R3-git-status-failure-conflation, R4-maxbuffer-silent-
  false, R3-gitstatus-maxbuffer, R4-git-probe-latency (now observable),
  R4-sync-observability, R2-git-timeout-constant, R2-git-runner-name.
- Next (user-owned): delivery (push/PR/merge) under ordinary repository policy.
