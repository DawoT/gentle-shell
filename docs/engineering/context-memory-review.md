# Context and memory review of 93c66d92

The implementation was reviewed against the quality-first context plan. The
initial worktree was clean. Corrections are uncommitted and preserve the existing
workspace-local `.agents/memory` layout.

## Corrected behavior

- Context planning preserves structured messages, late requirements and tool
  call/result pairs. The previous algorithm retained only the first ten snippets
  of 200 characters and fabricated an assistant acknowledgment. It has been
  replaced with a lossless planner that requests native compaction above target
  and reports estimated overflow. Workspace `STATE.md` no longer becomes system
  authority. The replacement tests exercise information preservation and session
  authority; the old tests asserted the unsafe behavior.
- Compaction summaries remain session-local. Pi passes the active branch entry
  IDs to both search and read, so abandoned branch checkpoints are unavailable.
  No cross-session evidence publication protocol is implemented by this change.
- Writers use the existing Facts process lock around quota admission, append
  and fsync. Large concurrent records cannot interleave or both consume the last
  available quota. An incomplete tail is rejected explicitly; recovery must use
  the original session transcript. Reads reject nonregular and oversized files.
  Session file opens use `O_NOFOLLOW`; symlink directories are refused.
- Reads scan only the current bounded session file, without the old arbitrary
  256-file/4,096-record cutoff. Cancellation is forwarded to file reads.
  Pagination uses Unicode code points. Tool metadata no longer duplicates the
  retrieved summary text.
- Request totals measure the sanitized Responses payload after `onPayload`.
  Component counts remain explicitly labeled as normalized transcript counts.
  Telemetry describes an attempted request, not confirmed delivery. Model window
  and output reserve inputs are validated.
- Facts discards an old history receipt when persistence of the current snapshot
  fails. A digest checks integrity; it is not proof of authenticated provenance.
- Standalone MCP no longer queries memory using a fabricated shared identity.
  Memory calls explicitly report `session_scope_required`. Facts queries remain
  available. A trusted session/branch binding is required before enabling memory
  retrieval through this transport.

## Verification

Regression tests reproduced the failures before correction:

- `/tmp/context-builder-review-red.log`
- `/tmp/memory-isolation-review-red.log`
- `/tmp/budget-model-red.log`
- `/tmp/payload-budget-red.log`
- `/tmp/facts-stale-receipt-red.log`
- `/tmp/mcp-scope-review-red.log`

The focused bridge/Facts extension run passed 113 tests. The additional stdio
MCP tests passed 2 tests. The writer tests include independent Node processes
competing for the final quota and checking that the accepted record is readable.
Typecheck retained its 188 recorded diagnostics without regressions. Runtime
generation and package resource checks passed.

The final full run (`/tmp/agent-review-full-final.log`) passed 4,154 tests,
skipped 41 and failed zero. Provider contract and runtime harness stages also
passed. These results cover the corrections in this review, not the remaining
native compaction and cross-host binding work below.

Run the relevant checks with:

```sh
node --experimental-strip-types --test tests/codex-web-*.test.ts tests/facts-extension.test.ts tests/facts-mcp-server.test.ts
npm run typecheck
npm test
```

## Native Pi compaction integration

`lib/codex-web/native-compaction.ts` schedules Pi's native `ctx.compact` after
`agent_settled`, only for the bridge provider, with an idle agent and no pending
messages. It permits one active compaction and suppresses repeated attempts at
the same session/leaf. Pi owns summarization and transcript persistence; the
existing `session_compact` hook stores the checkpoint for branch-scoped retrieval.
Instructions retain objectives, scoped permissions, unresolved obligations,
evidence, and uncertain tool execution status.

Automatic scheduling remains disabled by default. To opt in for evaluation,
start Gentle Shell with `GENTLE_CODEX_WEB_AUTO_COMPACT=1`. The configured
`contextTargetTokens` is compared against Pi's reported usage. Pi's retention
settings must leave enough old context to summarize; a target below its retained
recent-token floor may not be achievable. Failure retains the transcript, emits
a UI warning, and requires `/compact` to retry the same leaf explicitly.

The installed-runtime regression completes a real Pi compaction with a
deterministic local provider, observes the transcript entry and memory checkpoint,
and checks that the next request uses the summary rather than the old full prompt.
This verifies integration, not semantic fidelity of an actual model's summary.
The focused integration run passed 116 tests (`/tmp/integration-review-gentle.log`);
typecheck retained 188 baseline diagnostics without regressions. Runtime generation
and package resource checks passed. The earlier full-suite result predates this
new scheduler and must not be read as its full-suite certification.

## Remaining plan requirements

Provider limit validation now runs in `onPayload`, before the HTTP adapter can
wrap a local configuration error as a generic connection failure. Sanitized
payload sizing also precedes immutable recovery admission. A regression with an
output reserve equal to the model window reproduced three spurious admission
receipts despite zero model requests; correction leaves no receipts and reports
the actual reserve error. Records: `/tmp/pre-admission-budget-red.log`,
`/tmp/budget-diagnostic-red.log`, `/tmp/pre-admission-budget-green.log`.

The context planner is not yet wired to hard provider admission. Post-turn
compaction cannot prevent an oversized initial prompt or a large next tool result.
`bytes / 4` is an estimate and cannot guarantee fit for all text, images or
tokenizers. Quality evaluation must demonstrate preservation of objectives,
constraints, unresolved obligations and source references before enabling
automatic compaction by default. No token-savings percentage is claimed.

Standalone MCP needs an authorized, dynamic session/branch binding. Project-wide
memory must publish structured evidence separately from session objectives and
permissions. Historical Facts receipts still require comparison with current
workspace evidence before reuse. Search remains a bounded linear scan (16 MiB
per session); incremental indexing and bounded MCP producer work remain open.

Static symlink rejection is not isolation from a hostile process that can rename
the workspace's directories concurrently. Shared project storage is writable by
the local user and hashes do not authenticate its author. These changes have no
independent merge certification and do not complete the broader context plan.
