# Feature: facts-json-module-resolution

Third dogfooding round. The classification shipped in facts-gap-fixes surfaced its first
real signal — and the signal exposed a resolver gap: JSON module imports count as
"broken relative" even when the target file exists.

## Context (live evidence, post-restart audit)

- `facts_status` now reports: `Module resolution: 1098 resolved, 1925 unresolved
  (builtins 1688, external 228, relative 9)` with capped examples — the classification
  works and separates expected noise from actionable signal.
- The 9 "relative" edges are false positives: `lib/runtime-metrics-native.ts:7` and
  `tests/runtime-metrics-native.test.ts:10-11` import existing JSON files with import
  attributes (`import schema from "../contracts/telemetry/runtime-aggregate-v1.schema.json"
  with { type: "json" }`). Both targets exist on disk. The TS resolver does not resolve
  JSON modules (no `resolveJsonModule`), so they land in the actionable "relative"
  category — eroding exactly the trust the classification was built to create.

## Tasks

### T1: Filesystem fallback resolution for relative specifiers
- Extend `FactsModuleEdge.evidence` with `"filesystem"` (additive; check whether any
  schema/validator enumerates evidence values — `lib/facts/facts-schema.ts` — and extend
  it consistently).
- In the module resolver (`lib/facts/facts-module-resolver.ts`, unresolved push sites
  ~:236-247): when TS resolution fails for a RELATIVE specifier (starts with `.`), probe
  the filesystem: `existsSync(resolve(dirname(importerPath), specifier))`. On hit, push
  `{ importer, specifier, target: resolvedPath, evidence: "filesystem" }`. On miss,
  keep the current `unresolved` edge. Import-attributes clauses (`with { type: "json" }`)
  never appear in recorded specifiers (extractor records the module specifier only) —
  verify and document. Absolute specifiers are out of scope for the probe.
- `formatResolutionSummary` (same file): count `evidence === "typescript" ||
  evidence === "filesystem"` as resolved; the builtins/external/relative breakdown keeps
  counting only unresolved edges, so "relative" becomes trustworthy again.
- Audit other `evidence === "typescript"` consumers for consistency: `lib/facts/facts-impact.ts`
  coverage line (update to include filesystem as resolved) and anything else found by
  grep; list each decision in the handoff.
- Test-first (RED -> GREEN) in `tests/facts-*.test.ts`: fixture with a relative JSON
  import whose file exists -> edge `evidence: "filesystem"` with target; relative import
  whose file is missing -> stays `unresolved` with category `relative`; summary counts
  filesystem as resolved; non-relative (bare) miss still `external`. Reuse the existing
  module-resolution test fixtures style (tests/facts-resolution-classification.test.ts /
  tests/facts-module-resolution tests if present).
- Evidence: commit `767239fa` (+5 tests; facts suite 232/232; typecheck no regressions).
  Implementation notes: probe via the resolution host (`host.fileExists`, keeps confined
  trees confined and replays in the snapshot read-set); fires on `module-not-found` AND
  `outside-index` pushes (the live false positives were `outside-index`: TS bundler mode
  resolves `.json`, the files just are not indexed as source facts); `facts-schema.ts`
  validator DID enumerate evidence values and was extended; `facts-history.ts` load
  enumeration extended by the orchestrator (writer-surface gap flagged in handoff —
  without it, facts_history would throw on post-fix snapshots).

### T2: Live acceptance check + doc
- After T1 lands: restart-independent acceptance via tests only (the running MCP server
  picks this up on next session start). Record the expected post-fix line shape in this
  doc; the orchestrator validates on the next natural restart.
- Evidence: commit `767239fa` (doc outcome below; live acceptance deferred to next
  session start) (this doc)

## Verification plan

- Focused: `node --experimental-strip-types --test tests/facts-resolution-classification.test.ts`
  plus any new/existing module-resolution test files (RED -> GREEN per task).
- Final: `pnpm test:facts` via verifier agent; typecheck regression verdict.
- Work-unit commits on feature branch `odd/facts-json-module-resolution` (stacked on
  `odd/dogfooding-review-ux`).

## Outcome (2026-10-03)

- Status: COMPLETE (code). Commit `767239fa`: evidence `filesystem`, probe via resolution
  host, summary/impact/schema/history accounting consistent, 232/232 facts suite,
  typecheck no regressions.
- T2 live acceptance: the running MCP server picks this up on the next session start;
  expected `facts_status` line then: `relative 0` for this repo (the 9 JSON false
  positives move to resolved).
- Native review (lineage `review-6f3bdfd1de76eb60`, tier high, 4 lenses on
  `zai/glm-5.3-flash`): **approved**, authority burned (`gentle-ai.review-acknowledged/v1`,
  consumed `f867dda4…`). 9 non-blocking advisory findings (7 SUGGESTION, 2 WARNING:
  `R3-git-status-failure-conflation` and `R4-maxbuffer-silent-false` in
  `lib/facts/facts-commit.ts`) — separate later work.
- Dogfooding milestone: the grouped capture (`gentle_review_capture_group`) ran
  end-to-end for the first time — 4/4 concurrent relays admitted — using the wrapper
  shape that T1 of dogfooding-review-ux enabled. Before that fix the group path always
  rejected the facade's own STATUS projection.
- Next (user-owned): delivery (push/PR/merge) under ordinary repository policy.

## Follow-up (2026-10-03, post-restart audit)

- Live acceptance FAILED on first restart: warm cache. `.pi/facts.json` (mtime pre-fix)
  kept old edges because invalidation keyed only on source inputs — resolver changes were
  invisible to it.
- Fix commit `9b8fb7f9`: FACTS_DATABASE_VERSION "1.2.0" -> "1.3.0" (the designed
  invalidation lever; store marks mismatches incompatible -> full resync). 12 current-
  version test fixtures migrated to the imported constant; "1.2.0" kept deliberately as
  the previous-release literal in the new integration test (old version -> incompatible
  -> recompute -> republish; RED observed pre-bump).
- Root cause of the whole live failure, deeper: `runtime/facts/facts-module-resolver.mjs`
  (the worker bundle sync actually resolves edges through) was stale since before the
  classification feature. Fix commit `6e776b02`: regenerated via
  `build:runtime-modules`; `check:runtime-modules` matches. Process lesson adopted:
  lib changes to bundled modules require `build:runtime-modules` in the same feature —
  `prepack` enforces it via `check:runtime-modules`.
- Suite 233/233 after both commits. Live acceptance (`relative 0`) expected on next
  restart: warm cache now invalidates AND the worker bundle computes new semantics.

## Non-goals

- No change to tsconfig (resolveJsonModule is a project compile decision, not Facts').
- No resolution of bare specifiers via node_modules probing (external stays external).
- No change to the builtins/external classification rules.
- No delivery (push/PR/merge) — user decision.
