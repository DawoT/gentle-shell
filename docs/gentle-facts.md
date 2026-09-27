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
│ 3. Execution Receipts          │ 4. Atomic Fact Store (.pi/facts.json)          │
│    • Package manager detection │    • Address: filePath + gitSha                │
│    • Declared test command     │    • Atomic temp-write + rename                │
│    • Direct & dev dependencies │    • Unchanged source files are not re-parsed  │
└────────────────────────────────┴────────────────────────────────────────────────┘
```

### 1. Git-Content-Addressed Invalidation
* File entries are keyed by their relative path and Git blob SHA (`git ls-files -s`).
* At session start, a Git index and working-tree scan checks for changes. Duration depends on repository size and disk speed.
* **Cache Hit**: If a file's Git SHA matches the cache, its parsed facts are reused without re-reading that source file. Each refresh still checks Git and package metadata. An unchanged database is not rewritten.
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

Source reads are limited to 1 MiB per file, 32 MiB per scan/indexing phase, and 10,000 indexed paths. Unsupported extensions are filtered before content reads. Exceeding a limit makes the refresh unavailable and preserves the last saved cache; tools do not return that old snapshot. Git commands have a 15-second timeout. Tool cancellation propagates to the refresh, Git commands, and source reads. Synchronous AST extraction finishes its current bounded file before cancellation can be observed.

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
Finds files that directly import an indexed module or a module exporting a given symbol. It includes re-exports and literal dynamic imports. This is a syntactic, file-level dependency query: computed import paths, configured aliases, and transitive consumers are outside its scope. A `require` call is recognized by its spelling; the extractor does not determine whether that identifier is locally shadowed.
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
* **Facts tool calls**: All three tools refresh before answering, so external edits and changes made through a shell command become visible without restarting the session. A failed refresh, including a changed source file that cannot be read, returns an unavailable result instead of answering from the previous snapshot. The prompt block is omitted while refresh is unavailable; the card shows the failure and a recovery hint. A refresh takes time proportional to the repository scan; there is no fixed latency guarantee.

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

A writer holds `.pi/facts.lock` throughout scanning, extraction, and publication. This coordinates independent services and Node processes that share the same cache directory. Waiting is cancellable and stops after 15 seconds with a `busy` diagnostic. The lock contains `owner.json` with the process ID and acquisition time. A cancelled or failed writer releases its lock and does not replace the saved cache before publication.

After a hard process termination, the lock may remain. It is deliberately not stolen based on elapsed time. Confirm that no process uses that cache, inspect `owner.json`, then remove the orphaned `.pi/facts.lock` directory and retry. Do not remove an active writer's lock.

The index is a snapshot assembled while files are read, not an atomic snapshot of the entire working tree. Each parsed source carries the hash of those same bytes. External edits are picked up by the next refresh.

## Package commands in monorepos

Receipts use the nearest package.json at or above the session working directory, up to the Git root. The package manager can be inherited from an ancestor manifest or lockfile; scripts belong to the selected package. `commandCwd` and `packagePath` are relative to the Git root. Run reported commands from `commandCwd`. They are declarations, not evidence that a test/build/lint command has succeeded.

## Reproducible checks

- `pnpm run test:facts`: source extraction, refresh, limits, diagnostics, monorepos, tools, cards and competing Node processes.
- `pnpm run test:facts:packed`: packs the current worktree, installs it with production dependencies in an isolated temporary directory, and loads Facts in a real Pi SDK session. Checks registered tools, dependency queries, external edits and cancellation; no model provider is invoked. Requires npm registry access. Install scripts are disabled, so it does not test the package postinstall installer.
- `pnpm run benchmark:facts > facts-benchmark.json`: three cold, unchanged and single-file incremental measurements for each of 25, 250 and 2,500 generated TypeScript sources. Asserts the number of reindexed files and records timing, heap, RSS, source hash and host details. Memory samples are taken after phases; process peak RSS includes preceding phases. These synthetic workloads do not establish a production latency guarantee.

Recorded remediation results and limitations: [verification evidence](evidence/gentle-facts-verification.md).
