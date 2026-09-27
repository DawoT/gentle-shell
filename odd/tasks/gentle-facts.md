# gentle-facts: Deterministic Objective Knowledge Base

## Objective

Implement a zero-hallucination, persistent project knowledge base (`gentle-facts`) for `gentle-shell` that eliminates exploratory token waste and startup amnesia in agent sessions by extracting and caching deterministic facts (AST symbols, signatures, contracts, and execution receipts) indexed and invalidated via Git content hashes.

## Problem

Coding agents currently spend 30,000–80,000 tokens and 1–3 minutes per session running `grep`, `find`, and reading raw source files merely to understand project architecture, type signatures, and build/test commands. Existing solutions fail:
- Vector RAG is fuzzy, lossy, and non-deterministic for exact programming types and exports.
- LLM-authored scratchpads (`MEMORY.md`) suffer from cumulative hallucinations and immediate drift upon code edits.
- Re-reading whole files exhausts context and induces attention degradation.

## Why

AST parsers and Git can build a source index without LLM generation. The implementation refreshes Git state before answering tools, so total latency includes repository scanning and depends on repository size. Cached facts avoid repeated source parsing; they do not guarantee semantic correctness or a fixed response time.

## Scope

- Phase 1: Git-content-addressed invalidation engine and domain types.
- Phase 2: Deterministic TypeScript AST extractor (`ts.createSourceFile`).
- Phase 3: Facts store persistence and execution receipts extractor (`package.json`, lockfiles).
- Phase 4: Pi extension integration (`extensions/gentle-facts.ts`), lifecycle hooks, and agent tools (`facts_query`, `facts_dependents`).
- Phase 5: TUI status card and documentation.

## Out of Scope

- Natural language summarization by LLMs (violates zero-hallucination constraint).
- Vector databases or semantic embedding models.
- Automatic code mutation or unsolicited refactoring.

## Constraints

- Pure TypeScript / Node.js using existing project dependencies (`typescript@^5.9.3`, Node 22 native test runner).
- No new external runtime or native binary dependencies.
- Strict TDD (RED -> GREEN -> REFACTOR) verified via `node --experimental-strip-types --test tests/facts-*.test.ts`.
- Bounded work units (~400 authored changed lines).
- Must survive non-git repositories gracefully.

## TDD & Verification

- Runner: `node --experimental-strip-types --test tests/facts-git-indexer.test.ts`
- TypeScript check: `node scripts/check-types.mjs`
- Harness parity check: `pnpm test`

## Tasks

- [x] **T1 — Phase 1: Git Invalidation Engine & Domain Types (completed)**
  - [x] Create feature document `odd/tasks/gentle-facts.md`.
  - [x] Write failing test suite `tests/facts-git-indexer.test.ts` (RED: module not found, exit 1).
  - [x] Implement `lib/facts/facts-types.ts`.
  - [x] Implement `lib/facts/facts-git-indexer.ts` (GREEN: 7/7 tests passed in 401ms).
  - [x] Handle untracked, deleted, modified, and space-containing paths (REFACTOR).
  - [x] Verify test suite passes (`node --experimental-strip-types --test tests/facts-git-indexer.test.ts`).
  - [x] Verify typecheck clean (`node scripts/check-types.mjs`: 0 regressions).
- [x] **T2 — Phase 2: Deterministic TypeScript AST Extractor (completed)**
  - [x] Write failing test suite `tests/facts-ts-extractor.test.ts` (RED: module not found, exit 1).
  - [x] Implement `lib/facts/facts-ts-extractor.ts` using `typescript.createSourceFile`.
  - [x] Extract functions, classes, interfaces, types, enums, arrow functions, docstrings, imports, and exports (GREEN: 7/7 tests passed).
  - [x] Fail-safe parser handling syntax errors gracefully without throwing (REFACTOR).
  - [x] Verify test suite passes (`node --experimental-strip-types --test tests/facts-*.test.ts`: 14/14 tests pass).
  - [x] Verify typecheck clean (`node scripts/check-types.mjs`: 0 regressions).
- [x] **T3 — Phase 3: Facts Store & Execution Receipts Extractor (completed)**
  - [x] Write failing test suite `tests/facts-store.test.ts` (RED: module not found, exit 1).
  - [x] Implement `lib/facts/facts-receipts-extractor.ts` to detect package managers (pnpm/npm/yarn/bun) and test/build/lint commands.
  - [x] Implement atomic `FactsStore` in `lib/facts/facts-store.ts` (.pi/facts.json with temp-rename safety).
  - [x] Implement `FactsService` in `lib/facts/facts-service.ts` coordinating Git indexer, AST extractor, receipts, and cache.
  - [x] Verify symbol queries, dependency queries, incremental delta updates, and prompt block generation (GREEN: 4/4 tests passed).
  - [x] Verify full facts test suite passes (`node --experimental-strip-types --test tests/facts-*.test.ts`: 18/18 tests pass).
  - [x] Verify typecheck clean (`node scripts/check-types.mjs`: 0 regressions).
- [x] **T4 — Phase 4: Pi Extension & Agent Tools (completed)**
  - [x] Write failing test suite `tests/facts-extension.test.ts` (RED: module not found, exit 1).
  - [x] Implement `extensions/gentle-facts.ts` adhering strictly to Pi `ExtensionAPI` and `ToolDefinition`.
  - [x] Register agent tools `facts_query`, `facts_dependents`, and `facts_status`.
  - [x] Wire lifecycle hooks: background sync on `session_start`, prompt injection on `before_agent_start`, incremental re-index on `tool_execution_end`.
  - [x] Verify tool registrations, query executions, prompt injection, and write invalidations (GREEN: 6/6 tests passed).
  - [x] Verify full facts test suite passes (`node --experimental-strip-types --test tests/facts-*.test.ts`: 24/24 tests pass).
  - [x] Verify typecheck clean (`node scripts/check-types.mjs`: 0 regressions).
  - [x] Verify runtime modules check (`node scripts/build-runtime-modules.mjs --check`: 0 regressions).
- [x] **T5 — Phase 5: TUI Card & Documentation (completed)**
  - [x] Write failing test suite `tests/facts-card.test.ts` (RED: module not found, exit 1).
  - [x] Implement `lib/facts/facts-card.ts` using standard Gentle Shell CARD_TONE.INFO and renderCard.
  - [x] Verify facts card rendering with symbols, files, and test receipts (GREEN: 2/2 tests passed).
  - [x] Author comprehensive reference documentation in `docs/gentle-facts.md`.
  - [x] Verify full facts test suite passes (`node --experimental-strip-types --test tests/facts-*.test.ts`: 26/26 tests pass).
  - [x] Verify typecheck clean (`node scripts/check-types.mjs`: 0 regressions).
  - [x] Verify runtime modules check (`node scripts/build-runtime-modules.mjs --check`: 0 regressions).

## Staff remediation — 2026-09-27

The earlier phase counts above are historical implementation checks. Current verification commands are documented in `docs/gentle-facts.md`.

- [x] Parse and hash the same bytes; serialize publication across service instances and Node processes; reload disk state under the writer lock.
- [x] Preserve generic/async arrow signatures and resolve local export aliases without inventing external declarations.
- [x] Bound source reads, file counts, cache reads/writes and tool responses; propagate cancellation and expose pagination.
- [x] Resolve the nearest monorepo package and report the command working directory.
- [x] Expose refresh state, last successful refresh, failure hints and cache load outcomes in tools and the Facts card.
- [x] Exercise the production-installed package in a real Pi SDK session without a provider call; supply reproducible performance measurements.

Evidence: `tests/facts-*.test.ts`, `tests/support/facts-packed-session.mjs`, `scripts/test-facts-packed.mjs`, and `docs/evidence/gentle-facts-benchmark.json`.
