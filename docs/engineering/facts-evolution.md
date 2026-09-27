# Facts evidence index — implementation contract

## Decision and scope

Extend the existing Facts feature into a versioned evidence index. Preserve the existing tools and the preceding uncommitted remediation. This work is R2 × L because it includes shared publication, worker cancellation and lock recovery; the module-resolution subtask is R1 × M.

Required deliverables:

1. Resolve local modules using project TypeScript configuration; expose resolution evidence and unresolved edges, plus transitive impact queries without claiming full semantic typechecking.
2. Publish immutable generations with bounded consistency validation; support reproducible indexing of a specific commit.
3. Bind pagination cursors to an immutable query result/generation with explicit expiration, bounded retention and no silent fallback to fresh results.
4. Store reusable facts per file and avoid rewriting the entire source inventory for one changed file; preserve safe publication and bounded storage.
5. Parse in cancellable workers, recover orphaned locks only with verified owner death, and retain conservative fallback where process identity cannot be verified.
6. Measure diverse workloads (large sources, dense symbols, packages, mass edits), validate the production-installed package, and document evidence and limitations.

## Acceptance and sequencing

Implement independent module resolution and cursor mechanics first, then integrate generations, storage and workers. Each significant behavior requires an observed failing test followed by passing focused and integration tests. Re-run package installation when runtime loading changes. Keep tests for the preceding behavior unless the contract intentionally changes it.

## Review and isolation

The available collaboration harness shares filesystem access and does not expose a verified per-agent write-denial mechanism. Agent identities provide independent review, not physical isolation. SHS option (c) applies: concurrency changes require human review before merge in addition to independent agent review. Implementation and local verification may continue. Do not invent approval signatures or claim this gate passed. No merge, deployment or publication is part of this authorization.

## Compatibility

Existing offset queries remain supported as fresh queries. New cursor continuations retain their original results. Limits and incomplete resolution must be visible. Unknown dynamic imports must never be reported as resolved. A newer schema may rebuild disposable caches; repository source files remain untouched.

## Progress — query evidence and cursors

Implemented query-result snapshots with five-minute expiration, 8 MiB retention and 128-entry retention limits. `nextCursor` binds the original query/filter set and result generation; continuations do not refresh or silently substitute new data. Existing `offset` requests remain fresh queries. Snapshot identifiers currently hash the in-memory database and resolved edges; they are not yet persistent disk generations.

Module resolution now uses TypeScript configuration (nearest config, extends, aliases, project references). `facts_dependents` supports `transitive` and labels each result with resolution evidence, depth and immediate predecessor. `facts_status` reports resolved and unresolved literal edge counts. This does not imply typechecking or complete discovery of dynamic imports. Resolver metadata IO remains synchronous and is a pending worker/budget integration concern.

Observed RED/GREEN: missing cursor module; mutation during paging; mismatched/expired/evicted cursor; aliases absent from service queries; transitive evidence absent from tool response; unresolved coverage absent from status. Tests are in facts-cursors, facts-module-resolver, facts-store and facts-extension.

Open: persistent generations and consistency validation; commit-pinned mode; file-granular storage; cancellable worker integration with metadata budgets; safe owner-death recovery; expanded performance and final package evidence. Prior remediation evidence in docs/evidence predates this evolution and must not be presented as final verification of these changes.

## Adoption expansion — Python, Go and transcript history (in progress)

User authorization extends the existing evolution to Python/Go symbols, reduced TypeScript runtime coupling, explicit no-tsconfig resolution, and transcript-linked long-term Facts memory.

Implemented and focused-tested:

- Language registry dispatches by extension; TS parser and resolver are loaded lazily. `.mts` and `.cts` are recognized.
- Python helper uses isolated `python3 -I` plus stdlib ast. It receives source text through stdin and never imports the inspected project. Functions, async signatures, classes/methods, annotations, imports, docs and static __all__ are covered.
- Go helper uses stdlib go/parser and go/ast. Only the packaged helper is compiled, in a private temporary directory with workspace/toolchain downloads disabled. Repository imports and init functions are never executed. Generic functions, receivers, interfaces, structs, variables, constants and documentation are covered.
- Service indexes mixed-language source. Python/Go module edges remain explicitly unresolved pending language-aware module resolution.
- History storage publishes immutable checksum-addressed snapshots beside a session transcript. Reads validate schema, digest, root and observation time. Shared writer locking, temporary publication, per-snapshot and aggregate limits prevent partial/concurrent publication. This storage is not yet connected to extension lifecycle or tools.

Observed RED/GREEN logs this iteration: /tmp/python-red.log, /tmp/go-red.log, /tmp/facts-languages-red.log, /tmp/facts-history-red.log, /tmp/facts-history-race-red.log. Full Facts suite before history integration: 109 passed. These are local worktree results, not released-package evidence.

Remaining work includes transcript lifecycle/branch-safe retrieval with explicit historical freshness; installed-package parser assets and runtime-absence coverage; dependency packaging decision for TypeScript (still runtime dependency today); no-tsconfig evidence; native-language resolution and receipts; safe parser subprocess validation and runtime portability; prior generation/storage/worker/recovery commitments. Do not claim the broader goal achieved from extractor tests alone.

## Transcript integration and packaging progress

Connected snapshot persistence to successful refreshes using Pi appendEntry; deduplication uses canonical content hashes. Added facts_history, which selects the latest receipt only from getBranch and loads verified historical data without Git or source refresh. Persistence failures are separated from current index availability and visible in facts_status. Tests reproduce canonicalization duplication and verify branch isolation, repository disappearance, and failed history storage.

TypeScript moved to optionalDependencies with lazy imports; an isolated-copy test confirms Python extraction without any TypeScript installation. No-tsconfig resolution is now explicitly labelled default-compiler-options. The packed SDK test now includes Python/Go helper assets and transcript receipts with a persistent SessionManager, pending its final result. Existing evidence artifacts predate these changes.

## Adoption verification result

- Installed package probe passed: Pi SDK 0.87.1 loaded all four tools, executed Python and Go queries, persisted a custom transcript receipt, and recovered historical Python symbols after removing Git. No model calls. Log: /tmp/facts-adoption-packed.log.
- Direct Node unit suite: 3,972 passed, 41 skipped, no failures (4,013 total). Log: /tmp/facts-adoption-unit.log. The pnpm test invocation in this environment produced installation output rather than test evidence and is not counted.
- Final focused suite after adding native parser diagnostics: 116 passed. Log: /tmp/facts-adoption-final.log.
- Typecheck: existing 188 diagnostics, no regressions. Provider contract, runtime harness, generated runtime modules and package resources passed. Diff whitespace check passed.
- Package probe precedes the final diagnostic-only change; it covers deployed parser assets, optional TypeScript installation and transcript runtime integration.

Still open under the broader objective: persistent source generations and commit mode, file-granular storage, cancellable TypeScript workers and module metadata budgets, proven owner-death recovery, expanded performance workloads and independent final review. Native-language dependency resolution is not claimed. The implemented history query intentionally does not resync or relabel historical evidence as fresh.

## Cancellable TypeScript parser worker

TypeScript extraction now uses a reusable worker with a 256 MiB old-generation heap bound, 15-second deadline and 8 MiB serialized output cap. Cancelling active work terminates that worker; subsequent work starts a new one. Queued requests reject on cancellation without waiting for the active job. Worker assets are generated from TypeScript and the package verifier now reconciles nested generated modules.

RED evidence: /tmp/facts-worker-red.log (dense parsing ignored cancellation); /tmp/facts-worker-queue-red.log (queued cancellation waited for active parse); /tmp/facts-nested-runtime-red.log (nested module omitted from artifact reconciliation).
GREEN evidence: 118 focused Facts tests; 10 package-verifier tests; installed-package real Pi session including native parsers and transcript history (/tmp/facts-worker-packed.log). Runtime modules now number nine. The installed-package probe ran before the worker entrypoint was moved under the generator; its executable logic is unchanged, and generated asset checks plus focused worker tests cover that move.

Outstanding: module resolution remains synchronous; source-generation consistency, commit mode, granular source storage, owner-death recovery and expanded benchmarks are not yet closed. The worker is not a security sandbox for the inspected syntax; it provides scheduling, cancellation and heap isolation.

## Module resolution worker and metadata budgets

Moved TypeScript module resolution onto the reusable parser worker. The protocol sends import inventories rather than duplicating all declarations. Active resolution is terminated on cancellation, subsequent jobs recover with a fresh worker, and output/deadline/heap limits also apply to resolution. Metadata IO uses bounded regular-file reads (1 MiB/file, 8 MiB total), memoizes read contents and limits filesystem probes (100,000). Reads of tsconfig and package metadata no longer allocate arbitrary file contents in the main process.

Tests observed RED for missing worker resolution, oversized tsconfig accepted, and resolution failure incorrectly labelled as manifest failure. GREEN covers cancellation/recovery, native-language lazy loading, alias compatibility, preserved cache on resolver failure and corrected module_resolution diagnostics. Runtime generation and package manifests now include the resolver (ten generated modules).

Still pending: persistent source generations/consistency revalidation, commit mode, file-granular storage, safe orphan-lock recovery and expanded workload benchmarks. This entry supersedes the earlier statement that module resolution remains synchronous on the main thread; synchronous IO is confined to the bounded worker.

Module-worker final gates: 131 focused tests (121 Facts + 10 verifier) passed; full direct Node suite 3,979 passed, 41 skipped, zero failures (4,020 total). Real installed-package Pi session passed with all four tools, Python, Go, transcript history and no model calls. Typecheck has no regressions against the existing 188 diagnostics; provider contract, runtime harness, ten generated modules, 157 required package files and diff checks passed. Logs: /tmp/facts-resolution-final.log, /tmp/facts-resolution-full.log, /tmp/facts-resolver-worker-packed.log.

## Optimistic publication validation and adoption gates

Added a second source inventory/hash scan and receipt comparison before publication. Source membership, hashes, HEAD and receipts must agree with the candidate; drift restarts analysis under the same writer lock, at most three attempts. Exhaustion reports snapshot_validation and preserves both prior disk data and the service publication. RED reproduced stale reuse of a cached source changed after the first scan and publication despite continuously added files (/tmp/facts-consistency-red.log). GREEN verifies fresh symbols after retry and unchanged cache bytes after exhaustion.

This does not establish a whole-tree atomic snapshot: resolver metadata is not in the validation read-set, Git-hidden modifications remain a limitation, and edits can occur after validation. Commit mode and persistent source generations remain open. No merge approval or mechanically isolated verification is claimed.

Verification of this worktree: 133 focused tests passed; full suite 3,981 passed, 41 skipped, zero failures (4,022 total). Real production-installed package and Pi 0.87.1 session passed all four tools, Python/Go, cancellation, external edits and transcript history without model calls. Typecheck retains 188 recorded diagnostics with no regressions. Ten generated runtime modules and 157 required package files (69 byte-pinned artifacts) passed verification. Logs: /tmp/facts-consistency-focused.log, /tmp/facts-consistency-full.log, /tmp/facts-consistency-packed.log, /tmp/facts-consistency-types.log.

Reran the existing three-size TypeScript benchmark against this implementation; results are preserved separately in docs/evidence/gentle-facts-adoption-benchmark.json. This is synthetic evidence for 25/250/2,500 files and cold/warm/single-edit behavior, not native-language or dense-monorepo performance evidence. Expanded workloads and the other previously listed evolution commitments remain open.

## Review corrections — Git normalization and independent Go cancellation

Independent read-only review reproduced two defects: clean CRLF files were rejected by optimistic validation because Git normalizes content; cancelling the first Go caller aborted the helper compilation shared by another caller. Both received failing regression tests before correction. Validation now confirms mismatching Git hashes against bounded raw source reads. Shared Go compilation retains its own 60-second deadline; each consumer independently cancels its wait, without cancelling compilation needed by another consumer. The helper may finish compiling after all consumers cancel.

Final focused evidence: 136 tests passed (/tmp/facts-adoption-reviewed.log), plus the six Go tests rerun after correcting TypeScript resolution in the test fixture. Typecheck retains the existing 188 diagnostics with no regressions. The installed-package Pi integration passed again (/tmp/facts-adoption-reviewed-packed.log). The reviewer independently reran all three regressions and reported no remaining findings in those fixes. This review shares the harness/filesystem and is not a physically isolated approval. Full-suite figures above precede these last fixes; focused tests and installed-package verification cover them. The adoption benchmark artifact was regenerated after the corrections.

## Verified-owner-death lock recovery

Moved writer coordination into facts-lock.ts. New locks carry unique owner-record filenames and Linux boot/host/PID-namespace identity. Automatic recovery requires exact context agreement and ESRCH from the recorded PID; a living/reused PID, EPERM or unknown identity never authorizes removal. The unique owner-file unlink is the exclusive recovery claim. Only its winner may rmdir the empty lock; normal cleanup uses the same ownership rule. Neither path recursively removes another owner's files. Owner reads reject symlinks/nonregular files and are capped at 4 KiB; directory enumeration stops after discovering an extra entry.

RED: a real Node writer killed with SIGKILL left both competing writers unable to publish (/tmp/facts-lock-red.log). GREEN: competing processes recover and serialize publication; safety tests preserve live, foreign-context, partial, legacy, empty, extra-entry and symlink locks and preserve a replacement owner during old-writer cleanup. This deliberately leaves crashes before owner registration or between claim and rmdir to manual recovery. Recovery is for cooperative local writers, not proof against malicious filesystem mutation. The Linux process probe follows kill(2): https://man7.org/linux/man-pages/man2/kill.2.html; the name claim relies on unlink(2): https://man7.org/linux/man-pages/man2/unlink.2.html.

The previous turn made verified progress (native adoption, history, optimistic validation and reviewed cancellation corrections). Remaining contract scope: immutable source generations and commit-pinned analysis; file-granular storage; full metadata consistency validation; expanded workload benchmarks. Current recovery does not claim these are complete. The established R2 shared-harness limitation and human review-before-merge requirement still apply.

Independent review executed all 13 lock/process tests successfully and found no blocking cooperative-protocol defect. It identified an availability limitation now documented: failure to create the owner inode can also leave an empty lock. Exact forced suspension between unlink and rmdir is not covered; the multiprocess test covers real competing recoverers. No physical-isolation approval is inferred from this review. Focused suite before the bounded-directory enumeration refactor: 148 passed; after it, the 13 lock/process tests passed again. Typecheck: existing 188 diagnostics, no regressions.

Recovery integration gates completed: full direct Node suite 3,996 passed, 41 skipped, zero failures (4,037 total; /tmp/facts-lock-full.log). Production-installed package passed the real Pi session with native extractors and transcript history (/tmp/facts-lock-packed.log). Those jobs started before the bounded opendir refactor; final lock/process tests verify that refactor. Generated runtime and package resource checks passed; git diff --check is clean. Source-generation/storage/commit-mode deliverables remain active.

## Persistent generations and granular source objects

The previous goal turn made verified progress through safe owner-death lock recovery. This turn replaces monolithic cache writes with immutable SHA-256 file objects and delta manifests, followed by atomic pointer replacement. Complete reference checkpoints cap chains at 32 manifests and also trigger before the 64 MiB chain budget is exceeded. The schema validator moved into facts-schema.ts; FactsStore retains its existing API and adds loadGeneration/getGeneration. Legacy caches remain readable. Module edges now belong to the persisted database, so configuration-only resolution changes create a generation and old edges remain recoverable. Query cursors report the persisted ID instead of hashing a transient in-memory representation.

RED/GREEN evidence includes granular object reuse and old-generation reconstruction (/tmp/facts-generations-red.log), checkpoint no-op regression (/tmp/facts-checkpoint-red.log), module edge persistence and generation identity (/tmp/facts-generation-edges-red.log, /tmp/facts-generation-id-red.log), excessive metadata chain size (/tmp/facts-generation-budget-red.log), and a no-op save incorrectly accepting corrupt objects (/tmp/facts-generations-noop-red.log). The existing history test caught an additional regression: canonical loading changed property order and omitted undefined optional values, causing duplicate observations. JSON-canonical comparison now handles both cases; structural equality alone was insufficient. Its successful run is /tmp/facts-generation-canonical-green.log.

Additional tests exercise legacy migration/cancellation, deletion, __proto__/constructor keys as data, missing referenced manifests, checkpoint reconstruction across process-local store instances, and cancellation after object/manifest/pointer temporary writes. These leave the prior pointer and generation readable. Independent review found the corruption/no-op comparison defects and verified the generation tests; the physical-isolation limitation remains unchanged.

Retention is currently conservative and bounded: 256 MiB, 65,536 artifacts, 4,096 generation files including abandoned temporaries. No automatic GC yet; capacity errors preserve the previous pointer and require coordinated cache archival/reset. This is an operational limitation, not a completed retention UX. Granularity applies to writes; serialization and reusable-object reads remain O(index size). Rename atomicity does not imply fsync/power-loss durability. Commit-pinned mode, full resolver-metadata consistency, automatic retention and expanded workloads remain active work.

Generation integration gates: 160 focused tests passed; full direct Node suite 4,008 passed, 41 skipped, zero failures (4,049 total). Real production-installed package passed the Pi session, Python/Go and transcript-history checks without model calls. Typecheck retains 188 recorded diagnostics with no regressions. Ten generated modules, 157 required package files (69 byte-pinned artifacts), provider contract and whitespace checks passed. Logs: /tmp/facts-generation-final-focused.log, /tmp/facts-generation-full.log, /tmp/facts-generation-packed.log, /tmp/facts-generation-final-types.log.

Performance evidence: docs/evidence/gentle-facts-generations-benchmark.json records the current synthetic workloads. At 2,500 TypeScript files the median cold/warm/incremental times were 1,480.01 / 460.83 / 705.40 ms, versus 618.13 / 125.79 / 159.60 ms in the immediately preceding adoption artifact on this host. These are sequential local observations, not a controlled production SLA. Granular publication reduces bytes rewritten but adds many small-file reads/opens and hash checks; the measured latency regression is explicitly open. A bounded IO/caching strategy that preserves corruption detection, plus broader workloads, must be evaluated before calling the performance objective complete. Runtime harness also passed.

## Bounded IO and publication-comparison optimization

The previous goal turn produced persistent generations and concrete evidence of a latency regression; that was progress and determined this turn's optimization target. Added an eight-worker IO scheduler with ordered results, first-error cancellation and drain-before-rejection. Generation object loading uses a shared 64 MiB encoded-byte budget; active reads can overshoot physical IO by at most eight 64 KiB chunks before stopping, without accepting or publishing oversized data. Object verification/publication and retention-stat enumeration are also bounded. No hash-verification cache or timestamp-only integrity shortcut was introduced.

RED/GREEN covers scheduler overlap/order, draining after error, cancellation of queued work and shared read budgets (/tmp/facts-io-red.log, /tmp/facts-io-green.log). A targeted sparse-file test reproduced lost updates from a compound assignment whose RHS awaited stat; accounting now awaits into a local before synchronously incrementing usage (/tmp/facts-io-quota-red.log). Tiny regular-file reads previously allocated 128 KiB in buffers; size-aware chunks cap that test at 8 KiB while retaining growth/EOF checks (/tmp/facts-read-buffer-red.log). Unchanged publication comparison previously traversed loaded symbol payloads twice; it now skips shared, already-validated FileFacts identities and canonically compares metadata and changed entries (/tmp/facts-compare-red.log, /tmp/facts-compare-green.log). The no-mutation contract for those shared entries is explicit in code and documentation.

Independent review exercised the scheduler/generation and store/read suites and found no blocking defect; this is not physically isolated approval. Current performance evidence is docs/evidence/gentle-facts-io-benchmark.json: median cold/warm/single-edit times at 2,500 files were 847.68 / 228.16 / 364.40 ms. The preceding granular artifact measured 1,480.01 / 460.83 / 705.40 ms. The final run did not overlap this agent's test commands, but the desktop host had other workloads, so these are local observations rather than controlled production guarantees. Both artifact versions include source fingerprints. Latency is improved but remains above the older monolithic-cache measurements. Expanded workloads, retention GC, commit mode and full resolver-metadata consistency remain open.

IO optimization final gates: 167 focused tests passed; full direct Node suite 4,015 passed, 41 skipped, zero failures (4,056 total). Production-installed package passed the real Pi session with native parsers, external edits, cancellation and transcript history. Typecheck retains the existing 188 diagnostics without regressions. Generated runtime modules, package resources, provider contract, runtime harness and diff whitespace checks passed. Logs: /tmp/facts-io-final-focused.log, /tmp/facts-io-full.log, /tmp/facts-io-packed.log, /tmp/facts-io-final-types.log. No commit, merge, deployment or completion of the broader goal is claimed.

## Commit-pinned evidence with isolated publication

Added facts_commit, backed by direct local Git object reads and a separate .pi/facts-commit-cache. Revision resolution occurs once; commit/blob checksums are verified. Materialization includes supported sources, JSON metadata and lockfile presence markers, with explicit symlink/submodule omissions and portable path validation. TypeScript resolution is confined to the private materialization. Results carry the commit, scope, extractor version and commit timestamp. Current Facts and transcript receipts remain separate. Repeatability requires a fixed toolchain; external dependencies and configuration are excluded.

RED/GREEN tests cover dirty checkout/configuration independence, unchanged generation identity, replacement-object isolation, invalid revisions, pre/active cancellation, input quotas preserving prior publication, nested-package scope and submodule omissions. Independent review reproduced two defects: git show could invoke a repository-configured signature verifier, and execFile's abort callback could settle before child termination. Timestamp extraction now uses the raw checksummed commit object; cancellation waits for close with forced termination escalation. Active worker cancellation also waits for terminate(), while queued work cancels immediately. Another failing regression showed working-tree synchronization preserving committed provenance after cache reuse; the working-tree candidate now removes that provenance. Logs include /tmp/facts-worker-drain-red.log, /tmp/facts-commit-provenance-red.log and /tmp/facts-commit-focused-all.log.

The reviewer reran ten commit/worker tests and reported no further blocking findings in the reviewed scope. This is shared-filesystem review, not physically isolated merge approval. No merge or publication was performed. Automatic retention, complete working-tree resolver-metadata validation and diverse workload benchmarks remain open; commit mode does not silently claim to solve those constraints.

Commit-mode final gates: 178 focused tests passed (168 Facts plus 10 package-verifier tests). Full direct Node suite: 4,026 passed, 41 skipped, zero failures (4,067 total). The production-installed package passed a real Pi 0.87.1 session with all five tools, committed evidence, Python/Go extraction, transcript history, external edits and cancellation, with zero model calls. Typecheck retains 188 existing diagnostics without regressions. Ten generated modules, 157 package resources (69 byte-pinned artifacts), provider contract, runtime harness and whitespace checks passed. Logs: /tmp/facts-commit-focused-all.log, /tmp/facts-commit-verifier.log, /tmp/facts-commit-full.log, /tmp/facts-commit-packed.log and /tmp/facts-commit-types-final.log.

## Resolver input revalidation

The previous goal turn completed commit-pinned analysis and its integration evidence. This R2×M continuation addresses working-tree metadata consistency. Resolution now captures a transient read-set of the host operations consumed by TypeScript: metadata content hashes, file/directory existence including negative probes, realpath and directory listings. A second bounded worker job revalidates the observations before publication. Changes cause the existing maximum-three-attempt refresh loop to retry; exhausted retries preserve the previous generation and pointer. No snapshot metadata is added to persistent Facts.

RED/GREEN evidence: /tmp/facts-readset-red.log for absent read-set support, /tmp/facts-readset-service-red.log for a configuration changed deterministically after the first resolution, and /tmp/facts-readset-drift-red.log for repeated probes changing during resolution. Tests also cover external extends, node_modules package metadata, absent configuration appearing, and continuously changing metadata exhausting retries without publication. Independent review found that intra-resolution changes initially threw a generic error instead of using retries; snapshots now carry a consistency flag consumed by validation. Direct edges-only callers reject an inconsistent snapshot.

This is optimistic read-set revalidation, not an atomic filesystem snapshot. ABA changes and edits after validation remain possible; observations cover consulted inputs rather than every repository file. ReadDirectory is deliberately constant because resolution does not enumerate source inventories. Bounds/cancellation remain in the worker, including the 8 MiB snapshot-output limit. Additional validation IO has not yet received workload-specific performance measurements. Automatic retention and expanded workload benchmarks remain open. Shared-filesystem review is not mechanically isolated merge approval.

Read-set final gates: 183 focused tests passed. Full direct Node suite: 4,031 passed, 41 skipped, zero failures (4,072 total). Real production-installed Pi 0.87.1 session passed all five tools, native extractors, commit mode, external edits, cancellation and transcript history without model calls. Typecheck retains the existing 188 diagnostics with no regressions. Runtime generation (ten modules), package resources, provider contract and whitespace checks passed. Reviewer independently ran 48 resolver/store tests after the retry correction, with no further blocking findings. Logs: /tmp/facts-readset-focused.log, /tmp/facts-readset-full.log, /tmp/facts-readset-packed.log, /tmp/facts-readset-types-final.log. The broader goal remains active.

## Automatic generation retention and coordinated reads

The prior goal turn verified resolver input revalidation. This R2 continuation implements automatic collection at 75% of any generation quota. A mark phase retains the current pointer's chain, the 32 newest manifests by artifact mtime, and every manifest younger than 24 hours; all transitive upsert objects remain. Only recognized expired immutable/temporary filenames are swept. Unknown entries remain charged to quota. Invalid retained manifests, excessive inventories or cancellation before sweeping cause no deletions. Partial sweep cancellation preserves retained generations. Transcript snapshots are outside this collector.

RED/GREEN: /tmp/facts-gc-red.log reproduces missing retention, /tmp/facts-gc-reader-red.log reproduces the independent review's reader/GC race. Public FactsStore load/loadGeneration/save now share the cache lock; per-instance AsyncLocalStorage permits awaited nested operations within a writer scope and marks the scope inactive on completion. Callbacks must await all operations before returning. Low-level FactsGenerations callers still have an explicit lock precondition. Artifact age is not a reader lease, and historical IDs can expire after retention. Tests verify reclamation at the storage watermark using a sparse abandoned artifact, all retained generations reconstructing, unknown/recent artifacts preserved, corrupt marking producing no deletion, and cancellation mid-sweep preserving the current generation.

Independent review reran 56 generation/store/history tests and reported no further blocking finding. This is shared-filesystem verification, not mechanically isolated approval. The cache lock now serializes public readers with writers, which may add contention and creates the cache directory on a missing-cache read. Typecheck retains 188 existing diagnostics with no regressions. No merge, deployment or broader-goal completion is claimed. Diverse workload benchmarks remain outstanding.

Retention final gates: 188 focused tests passed. Full direct Node suite: 4,036 passed, 41 skipped, zero failures (4,077 total). Production-installed Pi 0.87.1 session passed all five tools, native extraction, transcript history, commit mode, external edits and cancellation with no model calls. Typecheck has no regressions against 188 existing diagnostics. Ten generated modules, 157 package resources, provider contract, runtime harness and diff checks passed. Logs: /tmp/facts-gc-focused-final.log, /tmp/facts-gc-full.log, /tmp/facts-gc-packed.log, /tmp/facts-gc-types-verified.log. Expanded performance workloads remain required before the full goal is complete.
