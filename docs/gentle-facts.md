# gentle-facts: Git-addressed source index

`gentle-facts` is a persistent source index for Gentle Shell. It reduces repeated source exploration by extracting syntax-level symbols, signatures, imports, and package scripts. Git content hashes invalidate cached file facts when the working tree changes.

---

## The Problem Solved

Traditional AI coding agents suffer from amnesia between sessions:
* **Repeated exploration**: Agents may rerun searches and reread source files each session to discover interfaces, types, and architecture.
* **Vector RAG limitations**: Semantic search is fuzzy and lossy. It retrieves snippets based on text similarity, which fails for binary programming truth (exact parameter types, export names, or return contracts).
* **LLM-authored memory drift**: Natural-language scratchpads (`MEMORY.md`) accumulate subtle hallucinations, drift immediately upon code edits, and degrade across turns.

The index does not use an LLM to generate facts. It records syntax found in source files; it does not type-check code, resolve every import, or prove runtime behavior. Incomplete source may produce partial facts.

---

## Architectural Layers

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                GENTLE FACTS                                     │
├────────────────────────────────┬────────────────────────────────────────────────┤
│ 1. Git-Addressed Invalidation  │ 2. Deterministic AST Extractor (0 Tokens)      │
│    • git ls-files -s (blobs)   │    • TypeScript Compiler API (ts.SourceFile)   │
│    • git status -z (deltas)    │    • Functions, Classes, Interfaces, Types     │
│    • In-memory blob SHA-1      │    • Exact signatures, line ranges & JSDocs    │
├────────────────────────────────┼────────────────────────────────────────────────┤
│ 3. Execution Receipts          │ 4. Atomic Generation Pointer          │
│    • Package manager detection │    • Immutable SHA-256 file objects                │
│    • Declared test command     │    • Delta manifests + pointer rename                │
│    • Direct & dev dependencies │    • Reuse unchanged objects  │
└────────────────────────────────┴────────────────────────────────────────────────┘
```

### 1. Git-Content-Addressed Invalidation
* File entries are keyed by their relative path and Git blob SHA (`git ls-files -s`).
* At session start, a Git index and working-tree scan checks for changes. Duration depends on repository size and disk speed.
* **Cache Hit**: If a file's Git SHA matches the cache, its parsed facts are reused without re-reading that source file. Each refresh still checks Git and package metadata. An unchanged database is not rewritten; canonical comparison ignores object property order and absent optional fields.
* **Cache Miss**: If a file is modified or untracked, only that file is re-parsed. Deleted files are purged instantly.
* **Cache validation**: The store validates its format, symbol fields, and schema version before reuse. Incompatible or malformed caches are rebuilt from source; a cache from another repository root is not reused. Version `1.2.0` invalidates earlier extractor output and records local export aliases and package command directories.

### 2. TypeScript AST Extractor
* Parses `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files using the official TypeScript Compiler API (`ts.createSourceFile`).
* Extracts:
  * Exported functions, generators, and async methods with parameter types, optionality, and return types.
  * Interfaces, generic type parameters (`<T>`), and type aliases.
  * Classes with public constructors, methods, and static members (omitting private internals).
  * Enums with member definitions.
  * Canonical JSDoc/TSDoc comments (`/** ... */`).
  * Module import specifiers and export lists.
  * Named and namespace re-exports, literal `import("./module")`, and literal `require("./module")` calls.
  * Rest parameters, generator functions, and class/interface heritage. ECMAScript `#private` members are omitted.
* **Fail-safe**: Syntax errors or incomplete code are handled gracefully without aborting the session.

### 3. Execution Receipts
* Inspects `package.json` and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`).
* Detects the package manager from `packageManager` or a lockfile and reports commands declared in `package.json` (e.g. `pnpm test`, `npm run build`, `pnpm run lint`). The indexer does not execute those commands.
* Includes declared test and build commands in the agent prompt as a starting point for verification.

---

## Agent Tools

The extension exposes three deterministic tools to the agent:

`facts_query` and `facts_dependents` accept `offset` (default 0) and `limit` (default 10, maximum 50). Results use stable file ordering. The response includes `returned`, `nextOffset`, and `truncated`; follow `nextOffset` until it is null. A page can contain fewer results than requested to stay within the response budget. Oversized declarations are explicitly truncated; inspect the reported source location for the complete declaration. Pagination refreshes the workspace on each call, so edits between pages can change the result set.

Cache reads and publications are limited to 64 MiB. Writes stream file records into a temporary file and publish by rename only after successful completion. Source, manifest, and cache reads require regular files, avoiding waits on named pipes.

Source reads are limited to 1 MiB per file, 32 MiB per scan/indexing phase, and 10,000 indexed paths. Unsupported extensions are filtered before content reads. Exceeding a limit makes the refresh unavailable and preserves the last saved cache; tools do not return that old snapshot. Git commands have a 15-second timeout. Tool cancellation propagates to the refresh, Git commands, and source reads. TypeScript/JavaScript AST extraction runs in a reusable worker with a 15-second deadline and a 256 MiB old-generation heap limit. Cancellation terminates the active parser worker; subsequent requests create a new worker. Queued requests can cancel without waiting for the active parse. TypeScript module resolution uses the same worker and cancellation/deadline controls. Metadata reads are capped at 1 MiB per file, 8 MiB total and 100,000 filesystem probes per resolution. Directory discovery does not recursively enumerate source files.

Query pages reserve 14,500 characters for result rows, with individual rows limited to approximately 6,500 characters. Names and dependency targets are limited to 1,024 characters. Oversized summary metadata is omitted with a truncation notice.

### `facts_query`
Queries exact symbols, interfaces, and signatures without opening or reading source files.
```json
// Tool Call
{
  "name": "facts_query",
  "parameters": {
    "name": "calculateTotal",
    "kind": "function"
  }
}

// Result (< 50 tokens)
• calculateTotal (function)
  File: src/billing.ts (lines 14-28)
  Signature: function calculateTotal(items: CartItem[], discount?: number): Promise<Money>
  Doc: /** Computes order total applying any active discounts */
```

### `facts_dependents`
Finds files importing an indexed module or a module exporting a given symbol. TypeScript module resolution supports configured aliases and project references; `transitive: true` traverses the resolved file graph. Results expose evidence, depth and the immediate predecessor. Re-exports and literal dynamic imports are included; computed imports remain outside its scope. A `require` call is recognized by its spelling; the extractor does not determine whether that identifier is locally shadowed. Native-language imports remain unresolved. This graph does not prove runtime behavior.
```json
// Tool Call
{
  "name": "facts_dependents",
  "parameters": {
    "target": "./billing.ts"
  }
}

// Result
Files depending on './billing.ts':
• src/checkout.ts
• src/invoice.ts
• tests/billing.test.ts
```

### `facts_status`
Reports the inventory summary, total indexed files, symbol counts, and declared package commands. `details.diagnostics` includes the current state, last successful sync timestamp, duration of the latest attempt, last disk cache load outcome, and a failure code/recovery hint when unavailable. A no-change successful refresh updates the sync timestamp without rewriting the cache.

---

## Lifecycle Hooks

* **`session_start`**: Awaits an initial sync against the Git workspace before the extension's facts are ready.
* **`before_agent_start`**: Refreshes the index and injects an inventory and declared package commands into `systemPrompt`.
* **`tool_execution_end`**: After successful `write`, `edit`, or `apply_diff` tool calls, scans the workspace and re-indexes changed supported files.
* **Facts tool calls**: The three current-state tools refresh before answering (cursor continuations retain their original snapshot); `facts_history` reads saved evidence without refreshing. Current-state refreshes ensure external edits and changes made through a shell command become visible without restarting the session. A failed refresh, including a changed source file that cannot be read, returns an unavailable result instead of answering from the previous snapshot. The prompt block is omitted while refresh is unavailable; the card shows the failure and a recovery hint. A refresh takes time proportional to the repository scan; there is no fixed latency guarantee.

---

## TUI Facts Card

In Gentle Shell fullscreen mode, the Facts Card renders in the sidebar with the standard rose frame:
```text
╭─ ✿ Facts · 284 symbols · 42 files ─────────────────────────────────╮
│ Test runner: pnpm test (pnpm@11.1.1)                               │
│ Indexed files: 42 · Total symbols: 284                             │
│ Git-addressed symbol cache                                          │
╰────────────────────────────────────────────────────────────────────╯
```


## Concurrent writers and recovery

A writer holds `.pi/facts.lock` throughout scanning, extraction, and publication. This coordinates independent services and Node processes that share the same cache directory. Waiting is cancellable and stops after 15 seconds with a `busy` diagnostic. Each lock contains a uniquely named `owner-<uuid>.json` record with the process ID, acquisition time and, where available, Linux process context. A cancelled or failed writer releases its lock and does not replace the saved cache before publication.

After a hard process termination, Linux writers can recover a lock only when the recorded hostname, boot ID and PID namespace match and the owner PID no longer exists (`ESRCH`). Permission errors, living or reused PIDs, unknown process context and other platforms retain conservative waiting. Recovery uses the uniquely named owner record as an atomic claim before removing the empty lock directory; competing recoverers cannot remove a replacement writer's lock. Lock age never authorizes recovery.

Legacy `owner.json` records, malformed records, extra files and empty lock directories require manual recovery. Empty directories can remain if creating the owner record fails (for example, inode exhaustion), or if a process dies before writing its owner record or after claiming recovery. Confirm no writer or recovery process is using that cache, inspect its contents, then remove the orphaned `.pi/facts.lock` directory and retry. Do not manually remove an active lock. The same protocol protects history snapshot publication.

Before publication, a second Git scan checks indexed source hashes, file membership and HEAD; package receipts are extracted again and compared. TypeScript resolution also captures its consulted inputs: file/directory existence (including missing paths), parser-visible metadata hashes, real paths and directory listings. The worker revalidates those observations before publication, including inherited configuration and package metadata outside the repository when consulted. Differing repeated probes during resolution also invalidate the candidate. Detected drift retries the complete analysis up to three attempts under the writer lock. If edits do not settle, refresh reports `snapshot_validation` and preserves the previous disk and in-memory publication. Each parsed source carries the hash of those same bytes.

This is optimistic validation, not an atomic snapshot of the entire working tree. Sequential checks can miss changes that occur and revert between observations, edits after validation, and Git-hidden source changes (such as assume-unchanged). The read-set covers consulted resolver inputs, not every file in the repository. Use `facts_commit` for committed inputs. Subsequent refreshes observe ordinary external edits.

## Package commands in monorepos

Receipts use the nearest package.json at or above the session working directory, up to the Git root. The package manager can be inherited from an ancestor manifest or lockfile; scripts belong to the selected package. `commandCwd` and `packagePath` are relative to the Git root. Run reported commands from `commandCwd`. They are declarations, not evidence that a test/build/lint command has succeeded.

## Reproducible checks

- `pnpm run test:facts`: source extraction, refresh, limits, diagnostics, monorepos, tools, cards and competing Node processes.
- `pnpm run test:facts:packed`: packs the current worktree, installs it with production dependencies in an isolated temporary directory, and loads Facts in a real Pi SDK session. Checks registered tools, dependency queries, external edits and cancellation; no model provider is invoked. Requires npm registry access. Install scripts are disabled, so it does not test the package postinstall installer.
- `pnpm run benchmark:facts > facts-benchmark.json`: three cold, unchanged and single-file incremental measurements for each of 25, 250 and 2,500 generated TypeScript sources. Asserts the number of reindexed files and records timing, heap, RSS, source hash and host details. Memory samples are taken after phases; process peak RSS includes preceding phases. These synthetic workloads do not establish a production latency guarantee.

Recorded remediation results and limitations: [verification evidence](evidence/gentle-facts-verification.md).

## Multi-language extractors and optional TypeScript

The language registry supports `.py` with Python's standard `ast` module and `.go` with Go's standard `go/parser` and `go/ast`, in addition to JavaScript/TypeScript (including `.mts` and `.cts`). Python requires `python3` with `ast.unparse` (Python 3.9+); accepted syntax depends on the installed interpreter. Go requires a local toolchain that supports the inspected syntax. The extension compiles only its packaged Go helper in a private temporary directory, with module downloads and workspace configuration disabled. Neither helper imports, compiles or executes the inspected repository.

Inputs, subprocess output and execution time are bounded; caller cancellation is propagated. Go helper compilation is shared within the process and has a 60-second deadline. Cancelling one caller stops its wait without aborting compilation for other callers; compilation can finish after all callers cancel. A missing runtime or syntax failure currently makes a refresh unavailable rather than silently reporting an empty index. Python/Go imports are recorded, but their module targets remain explicitly unresolved; this is not yet a language-aware dependency graph.

TypeScript is an optional runtime dependency, loaded only when TypeScript/JavaScript extraction or module resolution is required. Default installations retain it for compatibility. Environments omitting optional dependencies can use native-language extractors without loading TypeScript; JavaScript/TypeScript features require installing it. Projects without tsconfig.json can resolve relative modules using default compiler options, explicitly labelled `default-compiler-options` in dependency results. This does not establish that those options match a bundler's runtime behavior.

## Transcript-linked historical memory

After a successful refresh in a persistent Pi session, Facts writes an immutable snapshot into `facts-snapshots/` beside the transcript and appends a `gentle-facts-snapshot-v1` custom entry containing its digest, repository root and observation timestamp. Canonical serialization prevents duplicate entries for unchanged content. The transcript contains a reference, not a large symbol inventory. Keep the snapshot directory when copying or backing up transcripts.

`facts_history` reads the latest receipt on the current transcript branch and verifies the snapshot schema and checksum. It does not invoke Git, inspect current source, or synchronize the working tree. Optional `name`, `offset` and `limit` arguments inspect symbols or paginate the file inventory. Its response is explicitly historical; never interpret it as current repository truth. Missing or corrupt snapshots are not silently replaced by fresh data. In-memory sessions have no durable history snapshot.

Snapshots contain extracted declarations, documentation and package metadata; they live alongside existing session data with restrictive file permissions. Limits are 64 MiB per snapshot, 128 snapshots and 256 MiB total per snapshot directory. At capacity, current Facts remain usable and `facts_status` reports the history persistence problem. Automatic deletion is intentionally absent because transcript references must not be silently broken. Historical memory is not automatically injected into the current-ground-truth prompt.


## Persistent generations and file storage

`.pi/facts.json` is now a small versioned pointer to a SHA-256 generation. File facts live in `.pi/facts-data/objects/<digest>.json`; manifests live in `.pi/facts-data/generations/<digest>.json`. Each manifest records metadata (including resolved module edges), changed file references and deletions. Every 32 generations, or earlier if the chain would exceed its byte budget, publication creates a complete reference checkpoint. Changing one source writes its new object and a delta manifest; unchanged objects retain their bytes and modification times.

Publication writes objects, then the immutable manifest, then atomically replaces the pointer. Cancellation before pointer replacement preserves the previous publication; completed artifacts from an interrupted attempt can remain unreferenced. Reads verify SHA-256 before parsing and validate the reconstructed database. A referenced missing/corrupt artifact is an invalid cache, not an absent cache. Existing monolithic caches remain readable and migrate on their next successful publication. Older binaries do not understand the new pointer format.

`FactsStore.loadGeneration(id)` can load an earlier retained generation after process restart. Current query cursors report this persistent generation ID while retaining their own bounded result snapshots. Historical transcript snapshots remain self-contained, with their existing independent retention policy. Generation identity describes the analyzed evidence; it does not claim a filesystem-wide atomic snapshot or reproducible commit analysis.

The current retention policy fails explicitly at 256 MiB, 65,536 artifacts or 4,096 generation files; temporary and unreferenced files count toward storage usage. Before publication, usage at or above 75% of any quota triggers collection under the cache lock. Collection retains the current generation and all its ancestors, the 32 manifests with the newest modification times, and all manifests younger than 24 hours. All objects referenced by those retained chains survive. Only older, unreachable artifacts with recognized cache filenames are removed; unknown files remain and still count toward quota. Marking must succeed for every retained root before deletion begins. If retained or unrecognized data still exhaust capacity, stop sessions using the cache, then archive or remove `.pi/facts.json` and `.pi/facts-data` together before restarting to rebuild. Do not remove an active cache or `facts.lock`. Removing cache data expires its generation IDs; keep the data if those IDs must remain readable. Transcript history is stored separately beside the transcript.

Granularity currently reduces writes. Loading and checking reusable objects still require work proportional to the index. Artifact IO uses at most eight active operations per batch, preserves result order and drains active operations before releasing a failed publication. A shared encoded-byte budget applies to concurrent object reads; already-started reads can consume up to eight 64 KiB chunks before cancellation takes effect. Small regular files use smaller buffers. Publication comparison reuses unchanged file identities from the current validated cache load, while comparing metadata and reindexed files canonically. File facts must remain unmodified between load and comparison. Atomic rename protects publication visibility; this implementation does not fsync files/directories and does not guarantee durability across power loss. These bounds and limitations apply to local cooperative writers.

## Commit-pinned analysis

`facts_commit` accepts a required `revision` (for example, a full commit SHA), optional exact case-insensitive symbol `name`, and `offset`/`limit` pagination. It resolves the revision once and reads local Git objects directly. Dirty and untracked working-tree files do not become inputs. The result identifies the commit, persistent generation, commit timestamp, and omitted paths. Use a full SHA when paginating across calls; branch names can move.

Sources and configuration are materialized in a private temporary directory. Git commit and blob checksums are verified. No checkout, project execution, Git filters or signature-verification helper is used. TypeScript resolution is confined to that directory. Supported source files, JSON/JSONC metadata and empty lockfile presence markers are included; symlinks and submodules are omitted explicitly. Dependencies/configuration outside the committed materialization are unavailable. Unsupported filename encodings or unsafe portable paths fail explicitly.

The separate `.pi/facts-commit-cache` uses the same generation storage limits and writer protocol. Commit analysis does not replace current Facts, alter the current-ground-truth prompt, or append a transcript history receipt. Identical evidence retains its generation ID. Repeatability assumes the same extractor and installed toolchains: this is not a hermetic compiler environment, dependency installer, or a claim that the project builds.

Bounds include 1 MiB per source/metadata blob and commit object, 32 MiB of selected blob data, 10,000 selected paths, 100,000 tree entries, 16 MiB of unique tree bodies, 16 MiB of aggregate path bytes, 4,096 bytes per path and 128 nested directory levels. Each Git command has a 15-second deadline. Cancellation waits for the Git child or active TypeScript worker to terminate before releasing its resources; an unresponsive Git child receives forced termination after 250 ms. Native extractor runtime requirements still apply. Failed analysis preserves the previously published commit cache. The same generation collection policy applies to this separate cache.

Resolver observations are transient and do not add host paths or metadata contents to persisted Facts. Metadata content is hashed after the same UTF-8/BOM normalization used by the parser. Revalidation runs in the cancellable worker with the existing 1 MiB per-file, 8 MiB aggregate metadata, 100,000 file/directory existence and metadata-read calls, and 15-second job limits. Snapshot transport shares the 8 MiB worker-output bound with its edges; excessive input inventories fail explicitly. Revalidation adds IO proportional to the consulted inputs and does not provide filesystem transactions or power-loss durability.

Public `FactsStore.load`, `loadGeneration` and `save` operations acquire the cache lock. Operations awaited inside the same store's `withWriterLock` reuse that scope, so service transactions do not deadlock. Low-level `FactsGenerations` callers must hold the same lock themselves. Historical generation IDs are not permanent pins: after retention expires, `loadGeneration` may report a missing artifact. An in-progress public read holds the lock and cannot be swept concurrently. The 24-hour policy is artifact age, not time since last access. Transcript snapshots are independent and are never collected by this cache policy. Cancelling a sweep can leave a partially cleaned cache, but retained generations remain intact. A read may create the cache directory for its lock even when no pointer exists.

## Facts-first context discovery

The ready-state prompt asks the agent to use `facts_query` for declarations/signatures and `facts_dependents` for import dependencies before reading source or searching for those facts. This is model guidance, not a tool-execution restriction or measured adoption guarantee. Unavailable or empty results, unresolved dependencies, and questions about implementation behavior explicitly allow source inspection. Debugging, review and editing still require relevant implementation context.

`facts_query` accepts `name`, `file`, or both. Names match exactly, case-insensitively; files match an exact repository-relative path. A leading `./` is accepted. Absolute paths, parent traversal, backslashes and empty paths are rejected. For example, `{"file":"src/auth.ts"}` lists declarations in that indexed file; `{"file":"src/auth.ts","name":"login"}` narrows the query. Existing `name` queries remain supported. This is declaration discovery, not a promise of runtime exports or behavior. Results retain existing bounded pagination; a cursor is bound to its normalized file/name/kind scope and original generation even after edits.

## Session usage and estimated context reduction

The sidebar and `facts_status.details.usage` expose completed `facts_query`/`facts_dependents` calls, answered/empty/unavailable/error counts, cursor pages and UTF-8 response-text bytes. Invalid or cancelled calls count as errors; text generated by the host for thrown errors is not measured. Status/history/commit tools, system prompts and provider messages are excluded. These counters measure tool use, not cache hits or billed model tokens. Counters reset on session start/replacement and shutdown. Pending refreshes are cancelled when their session is replaced or closed.

Newly extracted file facts include the UTF-8 byte length of their parser input. The comparison baseline credits each returned source file version (path plus content hash) once per session, up to 4,096 identities; reaching that cap is reported. Query pages carry their original sizes inside the bounded cursor snapshot, even after source edits. Dependency-only queries do not receive a full-source baseline, but their response bytes count. Legacy caches without sizes remain readable; those files have no baseline credit until re-extracted. No additional source reads are performed for this measurement.

Estimated context reduction is `(credited full-file-version bytes - response-text bytes) / 4`, truncated to whole tokens. It can be negative and is unavailable before any sized file is credited. The divisor is a rough heuristic, not a model tokenizer. The baseline assumes full-file reading; actual agents may read small ranges, later read the same sources anyway, or incur cached/repeated provider input. Therefore the value is not causal token savings or monetary ROI. No dollar estimate is displayed. A controlled comparison with provider usage remains necessary to establish actual savings.

## Potential impact between committed versions

`facts_impact` accepts required `base` and `candidate` Git revisions, optional `transitive` (default true), and `offset`/`limit`. Both versions are indexed from committed Git objects; dirty source/configuration is excluded. Use the returned full commit IDs for subsequent pages. Calls use the separate commit cache and do not replace current Facts or append history receipts.

The comparison identifies added/modified/deleted indexed sources by content hash, plus importers whose recorded resolution edges differ. A rename is represented as deletion plus addition. These paths seed a reverse traversal of both the old and new graphs, preserving evidence for removed dependencies. Results include side, shortest distance from any seed, predecessor and origin; seeds are listed separately. Direct-only mode stops after one edge. Consumer counts distinguish version-specific observations from unique file paths.

This is potential file-level impact from resolved literal imports, not proof that a particular function is called or broken. Configuration changes can change the graph without changing source; unrelated non-source changes are outside this comparison. Python/Go unresolved imports, dynamic runtime relationships, external configuration/dependencies, symlinks and submodules limit coverage. The response reports coverage/omissions and never interprets zero resolved consumers as zero risk. Inventories are bounded to 10,000 files and 100,000 edges per version; output uses the normal bounded paging format. Source analysis and native runtime limits still apply.

The ordinary/4R review controller now adds advisory impact evidence using its exact base/candidate trees. It does not widen authorized review scope or alter risk/approval decisions. It never substitutes the live checkout or HEAD for a frozen candidate. Impact calls are excluded from session usage/ROI counters.


## Internal frozen-tree analysis

The review integration foundation now supports exact tree object IDs, including trees that have never belonged to a commit. `readFactsTree` derives paths from the same raw tree bytes whose SHA-1/SHA-256 identities it verifies; it does not re-read paths through `ls-tree`. Root and nested trees are checked, and selected source blob contents are checked independently. UTF-8 filenames preserve a leading U+FEFF character. Unsupported encodings, malformed tree records and bounded-inventory violations fail explicitly.

`indexFactsTree` materializes and extracts into a temporary directory, then removes it. Its result carries the tree ID separately; it does not fabricate a commit, write a Facts cache or append session history. `analyzeFactsTrees` compares two such inputs using the existing impact engine. An internal, explicit object-store descriptor supports controller-owned isolated objects and alternates; callers must validate that authority themselves. These paths are not exposed as model-supplied tool arguments, and ambient Git environment overrides remain ignored.

### Review dispatch integration

The `subagent_run` hook enriches the four ordinary/4R `review-*` actors, including parallel dispatch. Judgment Day judges are not connected to this adapter. Before analysis, the controller validates the requested actors and candidate binding. After asynchronous analysis it validates the binding, candidate contents, request and session again. A changed candidate, lineage, actor list or closed/replaced session blocks dispatch, including when temporary-view cleanup fails.

Analysis receives a 30-second cancellation deadline; subprocess cleanup can add latency. Extraction failures or the analysis deadline produce an explicit unavailable advisory, without granting review authority. This path currently extracts both trees on each review dispatch; it has no review evidence cache or production latency guarantee.

The advisory includes exact tree identities, changed-source and resolution-seed counts, coverage omissions, and up to five potential consumer observations with dependency depth. Lists can be truncated. The entire controller context retains its existing 4,096-byte limit: authorized scope takes priority, then a compact advisory or an unavailable notice where space permits. Consumers outside the authorized changed-file scope do not become readable merely because they appear in the advisory. File dependencies do not establish function callers, exact risk, or the absence of impact.
