# Feature: facts-gap-fixes

Dogfooding audit of the Facts tools against gentle-shell itself surfaced four gaps.
All fixes are display/reporting-layer accuracy improvements; no extractor semantics change.

## Context (evidence from live dogfooding)

- `facts_status` reports "1919 unresolved" lumping `node:` builtins (1765), external
  packages (~150), and genuinely broken relative imports into one alarming number.
  Reporter: `lib/facts/facts-mcp-server.ts:252-255`; edges marked unresolved at
  `lib/facts/facts-module-resolver.ts:247` and `lib/facts/facts-service.ts:176`.
- `facts_commit`/`facts_history` always print "Not synchronized with the current working
  tree." even on a clean tree whose digest matches the live snapshot. Hardcoded at
  `lib/facts/facts-commit-extension.ts:36` and `lib/facts/facts-history-extension.ts:54`.
- `.mjs` files are labeled "(typescript)" in listings via `facts.language ?? "typescript"`
  fallback (`facts-commit-extension.ts:31`, `facts-history-extension.ts:51`).
- `facts_history`/`facts_commit` name lookups render `file:startLine` while the schema
  stores `endLine` (`lib/facts/facts-types.ts:43`) and the MCP server already renders
  ranges (`facts-mcp-server.ts:273`).

## Tasks

### T1: Classify unresolved module edges
- Add classification for unresolved edges: `builtin` (specifier starts `node:`),
  `external` (bare package specifier), `relative` (starts with `.` or `/` — the only
  truly broken category).
- `facts_status` module-resolution line reports the breakdown, e.g.
  `Module resolution: 1091 resolved, 1919 unresolved (builtins 1765, external 141, relative 13)`
  plus up to 3 example `importer -> specifier` rows for the relative category.
- Resolved counts and edge schema stay backward compatible.
- Test-first (RED -> GREEN) in `tests/facts-*.test.ts` (suite: `pnpm test:facts`).
- Evidence: commit `6cd75ef9` (8 new tests; full suite 215/215)

### T2: Accurate synchronization disclaimer for facts_commit
- When the indexed revision is HEAD and the working tree is clean, print a
  "matches the current working tree" line instead of the unsynchronized caveat.
- Otherwise replace "Not synchronized with the current working tree." with precise
  wording (snapshot as of commit X; working-tree edits after indexing are not included).
- Gate helper lives in `lib/facts/facts-commit.ts` (testable); extension only renders.
- `facts_history` keeps the caveat but with precise, always-true wording (no service
  access at tool registration; plumbing a digest getter was rejected as out of scope).
- Test-first in `tests/facts-commit.test.ts`.
- Evidence: commit `f408acd4` (+3 tests; suite 218/218)

### T3: Language label derived from file extension
- Listings derive a display language from the file extension when `facts.language` is
  absent: `.mjs/.js/.cjs` -> javascript, `.ts/.tsx/.mts/.cts` -> typescript,
  `.py` -> python, `.go` -> go; unknown extensions keep "unknown" (not "typescript").
- Shared helper (candidate: `lib/facts/facts-languages.ts` or `facts-response.ts`),
  used by both extensions.
- Test-first.
- Evidence: commit `42636147` (+9 tests incl. routing-vs-display separation). Amendment
  during review: `factsLanguage` stores "typescript" for the whole JS family (extraction
  routing), so the stored-wins rule would have kept the bug — display now derives purely
  from the extension; stored routing label is intentionally ignored for display.

### T4: Full line ranges in name-lookup rows
- `facts_history` and `facts_commit` name lookups render `file:startLine-endLine`,
  aligned with the MCP server rendering.
- Test-first.
- Evidence: commit `42636147` (shared `symbolRow` helper in `lib/facts/facts-response.ts`)

## Verification plan

- Per task: focused RED -> GREEN via `pnpm test:facts` (filtered).
- Final: full `pnpm test:facts` suite via verifier agent.
- Work-unit commits on feature branch `odd/facts-gap-fixes` (branched from main).

## Outcome (2026-10-03)

- Status: COMPLETE + REVIEWED. Commits: `6cd75ef9` (T1), `f408acd4` (T2), `42636147` (T3+T4), `56ab575c` (docs).
- Independent verification (gentle-ai-verify): suite 227/227 pass (15.3s); typecheck no
  regressions (baseline 186 recorded, 12 pairs improved); tree hygiene clean (only this
  doc untracked at check time); diff scope exact — no undeclared files in any commit.
- Native review (lineage `review-709362d61e78e7ea`, tier high, 4 lenses on
  `zai/glm-5.3-flash`): **approved**, authority burned (`gentle-ai.review-acknowledged/v1`,
  consumed revision `d1cc70af…`). 13 non-blocking advisory findings (12 SUGGESTION,
  1 WARNING `R4-sync-observability` in `lib/facts/facts-commit.ts:36-51`) recorded as
  separate later work; no correction opened.
- Next (user-owned): delivery (push/PR/merge) under ordinary repository policy.

## Non-goals

- No change to resolver semantics, edge storage schema (only additive fields), or
  extractor behavior.
- No plumbing of live digest getters into `facts_history` registration.
- No delivery (push/PR/merge) — user decision.
