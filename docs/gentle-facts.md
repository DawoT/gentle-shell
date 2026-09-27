# gentle-facts: Deterministic Objective Knowledge Base (DOKB)

`gentle-facts` is the persistent, zero-hallucination project knowledge base built for Gentle Shell. It eliminates exploratory token waste and startup amnesia in agent sessions by extracting and caching deterministic facts (AST symbols, signatures, contracts, and execution receipts) indexed and invalidated through Git content hashes.

---

## The Problem Solved

Traditional AI coding agents suffer from amnesia between sessions:
* **Token burn**: Agents spend 30,000–80,000 tokens per session running `grep`, `find`, and reading raw source files merely to discover interfaces, types, and architecture.
* **Vector RAG limitations**: Semantic search is fuzzy and lossy. It retrieves snippets based on text similarity, which fails for binary programming truth (exact parameter types, export names, or return contracts).
* **LLM-authored memory drift**: Natural-language scratchpads (`MEMORY.md`) accumulate subtle hallucinations, drift immediately upon code edits, and degrade across turns.

`gentle-facts` guarantees **0% hallucination**: facts are extracted mechanically by compilers and Git without using LLM generation or probabilistic models.

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
│    • Verified test command     │    • Atomic temp-write + rename                │
│    • Direct & dev dependencies │    • Zero disk I/O on cache hits (< 1 ms)      │
└────────────────────────────────┴────────────────────────────────────────────────┘
```

### 1. Git-Content-Addressed Invalidation
* File entries are keyed by their relative path and Git blob SHA (`git ls-files -s`).
* At session start, an incremental delta scan executes in < 20 ms.
* **Cache Hit**: If a file's Git SHA matches the cache, its facts are reused directly from memory without reading disk.
* **Cache Miss**: If a file is modified or untracked, only that file is re-parsed. Deleted files are purged instantly.

### 2. TypeScript AST Extractor
* Parses `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files using the official TypeScript Compiler API (`ts.createSourceFile`).
* Extracts:
  * Exported functions, generators, and async methods with parameter types, optionality, and return types.
  * Interfaces, generic type parameters (`<T>`), and type aliases.
  * Classes with public constructors, methods, and static members (omitting private internals).
  * Enums with member definitions.
  * Canonical JSDoc/TSDoc comments (`/** ... */`).
  * Module import specifiers and export lists.
* **Fail-safe**: Syntax errors or incomplete code are handled gracefully without aborting the session.

### 3. Execution Receipts
* Inspects `package.json` and lockfiles (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`).
* Determines the active package manager and resolves canonical, verified execution commands (e.g. `pnpm test`, `npm run build`, `pnpm run lint`).
* Injects verified test runners into the agent prompt so the model never wastes turns guessing testing commands.

---

## Agent Tools

The extension exposes three deterministic tools to the agent:

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
Discovers which files in the repository import or depend on a given module or symbol before refactoring.
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
Reports the inventory summary, total indexed files, symbol counts, and verified execution receipts.

---

## Lifecycle Hooks

* **`session_start`**: Runs non-blocking background sync against the Git workspace in < 30 ms.
* **`before_agent_start`**: Injects a compact ground-truth block into `systemPrompt` (< 150 tokens) declaring verified test runners and available facts tools.
* **`tool_execution_end`**: Listens for code mutations (`write`, `edit`, `apply_diff`) and immediately re-indexes touched files, keeping facts synchronized in real time for subsequent turns and child subagents.

---

## TUI Facts Card

In Gentle Shell fullscreen mode, the Facts Card renders in the sidebar with the standard rose frame:
```text
╭─ ✿ Facts · 284 symbols · 42 files ─────────────────────────────────╮
│ Test runner: pnpm test (pnpm@11.1.1)                               │
│ Indexed files: 42 · Total symbols: 284                             │
│ Deterministic cache: 100% synchronized with Git                    │
╰────────────────────────────────────────────────────────────────────╯
```
