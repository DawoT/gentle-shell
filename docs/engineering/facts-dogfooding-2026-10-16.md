# Gentle Facts dogfooding session (2026-10-16)

An intensive, honest dogfooding pass: every Facts query below answered a
question that actually arose while working on this repository the same day
(roadmap gap closure, the `ProofLedger.list()` fix, MCP live probes). The
goal was to measure where Facts earns its keep for agents doing ODD work
here, and what is worth integrating into the ODD skills and orchestrator
docs — not to admire the tooling.

## What was run (real questions, real answers)

| # | Real question | Tool | Result quality |
| --- | --- | --- | --- |
| 1 | Repo baseline before work | `facts_status` | 851 files / 10222 symbols; usage meter present; 1722 resolved / 2833 unresolved imports |
| 2 | Who consumes `lib/proofs/proof-ledger.ts`? (I had just changed it) | `facts_dependents` transitive | Correct, with depth + via paths; paged at 10 + cursor |
| 3 | What breaks between two commits (the `list()` fix)? | `facts_impact 53d3a8ff2 -> 44868c064` | Changed sources + potential consumers per graph; honest "not function-level impact" disclaimer |
| 4 | Why does a *facts* test import the *proofs* ledger? (surprise) | `facts_query(file)` | Symbol surface without reading the file — but no imports shown, so the "why" still needed a read |
| 5 | Who consumes the query index (kill-switch module)? | `facts_dependents` | Exactly 2 files — identical to grep |
| 6 | Blast radius of the hub `facts-service.ts` | `facts_dependents` | Extensions, history extension, MCP server, 3 benchmarks, runner, tests — the map an ODD task wants before scoping |
| 7 | Exact signature of the method I changed today | `facts_query(name: "ProofLedger.list")` | `async list(limit: number): Promise<ProofRecord[]>` at lines 80-219, zero file reads — qualified member projection working |
| 8 | What can an integration actually call on the Facts MCP? | `facts_query(file: facts-mcp-server.ts)` | Full tool surface (FACTS_MCP_TOOLS, BOUND_MEMORY_TOOLS, server class) in one bounded call |

## Head-to-head against grep (same questions)

- "All importers of proof-ledger": grep returned the complete list (15
  files) in **one 86ms call**; `facts_dependents` needed page 1 (10) plus a
  cursor hop for the rest. For the flat question, **grep won**.
- Small module (query index): identical answers — tie.
- Where Facts is strictly better: resolved-import precision (no comment or
  string false positives), depth/via structure on transitive questions,
  committed-range impact (`facts_impact` has no grep equivalent), and exact
  signatures without opening files. Caveat learned the hard way: the tools
  accept `limit` up to 50; calling with defaults produced the paging
  friction — defaults matter and nearly cost Facts the comparison.

## Honest gaps observed (product feedback)

1. `facts_query(file)` lists declarations but not the file's imports —
   "understand this file" still requires a read.
2. Flat importer questions feel worse in Facts than grep because of the
   default page size, even though `limit` fixes it.
3. Live index (1722 resolved) vs committed-range impact coverage (1712)
   come from different universes — expected, but easy to misread.
4. Non-TS remains the weak layer (2532 builtin-resolution "unresolved" from
   scripts and dynamic imports), consistent with the original audit score.

## Integration proposals (ODD skills / orchestrator docs)

1. **Explore step (gentle-ai skill / orchestrator explore rule):** for
   "map this surface" questions, one `facts_query(file: ...)` before any
   read; reads then target only the declarations that matter. Do not use
   Facts for flat "who imports X" — keep grep there.
2. **Delegation briefs (orchestrator-delegation):** add one line per touched
   surface — `dependents: N (facts_dependents, transitive)` — so bounded
   writers receive blast radius, not just paths. Depth/via output is exactly
   what scoped `Allowed edit surfaces` need.
3. **Verification rule (orchestrator-verification):** for small inline
   tasks, run the focused tests that import the changed module
   (`facts_dependents(changedFile)` -> matching `tests/*.test.ts`) before
   any broader suite; complements GENTLE_PROOFS, which already does this
   with coverage for the big path.
4. **ODD task docs (odd/tasks template):** record surfaces with their
   dependents count in `## Specs`/`## Tasks`, making work-unit commit and
   review-slice sizing data-driven instead of vibes.
5. **Facts product backlog:** expose imports in file-query results; a
   coverage/tests reverse query (the per-file proofs inventory already
   stores it) would let agents ask "which tests exercise this file?" —
   today that knowledge is only reachable through the runner.

## Verdict

Facts did not replace grep or reading this session — and should not try to.
It earned its keep exactly where structure matters: signatures without
reads, hub blast radius, committed-range impact, and as the substrate that
makes GENTLE_PROOFS selective verification possible (seconds instead of
minutes per verification cycle). The ODD integration worth doing is narrow
and cheap: map-with-facts in Explore, blast radius in briefs, focused tests
in verification, dependents counts in task docs.

## Post-fix verification (same day, after the reload)

The two actionable gaps were fixed with TDD (commits `aed41ad91`,
`6e433631b`, `8bfb67cbe`) and re-measured live:

| Metric | Before | After | Verification |
| --- | --- | --- | --- |
| Flat importer list (session `facts_dependents`) | 10 rows + cursor = 2 calls for 15 files | **15 files in 1 call** (default 50 live) | live, session tool, post-reload |
| File understanding (MCP `facts_query {file}`) | query + read (219 lines) | **1 call**, 4187 bytes, ~1s spawn-inclusive | live MCP probe; section equals grep ground truth |
| File understanding (session `facts_query {file}`) | declarations only | declarations + imports section (shared renderer) | pinned by session-tool test (RED 36/37 -> 37/37); live in-session after the next reload |
| Consistency | same file query answered differently per transport | single shared renderer in `facts-response.ts`, both transports | suite 375/375, typecheck 0, consumers 14/14 |

Operational note: session tools run the extension loaded at the last
`/reload`; bin and test fixes are live immediately, session-tool behavior
changes land after the next reload. The live A/B loop caught both the
stale-session effect and the transport inconsistency — dogfooding with
metrics is what surfaced them, not the suites alone.

## Second live round: contract entities exposed

Adversarial probes against the reloaded session found the largest gap of
the day: `FactsService.queryEntities({ name, path, kind })` existed since
Sprint 6.3 and the live index carried the entities (openapi-schema:Pets,
graphql-type:User, review-integration json-schemas, 3 api-routes), but NO
tool surface exposed them — `facts_query` searches symbols only, so contract
data was invisible to agents by name and by file.

Fix: a new additive `facts_entities` tool on both transports (MCP bin and
session extension), delegating to `service.queryEntities` with exact
name/path/kind filters and the standard pagination bounds. RED observed on
both surfaces (unknown tool), GREEN with shared row format
`• [kind] name — path[:line]`.

| Metric | Before | After |
| --- | --- | --- |
| Entity lookup by name | impossible through tools | `facts_entities {name:"Pets"}` -> `[openapi-schema] Pets` |
| Entities by kind | impossible | `kind:"api-route"` -> 3 routes with paths, ~1.1s spawn-inclusive |
| Suite | 375/375 | 377/377 (+2), typecheck 0 |

## Third live round: contract relations on entity rows

The same probe pattern then found the last unexposed layer: relations.
`FactsService.queryEntityRelations({ from, to, kind })` exists and the live
index carried 19 relations (3 serves, 8 consumes, 8 validates), but no tool
showed them — an agent could list entities yet still not ask what a route
serves or what validates a schema.

Fix: `facts_entities` rows now carry a bounded relations line — outgoing as
`kind → other`, incoming as `kind ← other`, names resolved through the full
entity list, capped at 4 per row. The shared `entityRows` renderer lives in
`facts-response.ts` and both transports use it. RED observed on both
surfaces; suite 379/379 (+2), typecheck 0. Live: `facts_entities
{name:"Pets"}` shows `relations (1): serves ← GET /pets` in-session.

Verdict after three rounds: the Facts query surface now covers symbols,
files (with imports), dependents, impact between revisions, entities and
their relations — every layer verified live through the same tools agents
use, with transport consistency as an explicit test target.

## Fourth live round: quality gates verified, no corrections needed

After the final reload, the round verified what earlier fixes could only
pin with tests, plus two gates never exercised live before:

- Kill-switch equivalence (first live check):
  `GENTLE_FACTS_DISABLE_QUERY_INDEX=1` produced byte-identical dependents
  output to the indexed path (1473 = 1473 bytes) — the documented
  "indexed == linear" gate holds on the real repository.
- `facts_entities` pagination: `limit: 2` + `offset: 2` continuation
  returned the remaining rows with per-row relations intact (inline rows
  also resolved the earlier backlog note about sections missing on
  continuation pages).
- Catalog: 190 contract entities across contract mirrors and fixtures,
  default page 50 with continuation.

Named opportunity (product decision, deliberately not churned): the
json-schema parser promotes top-level properties to entities, so generic
names repeat across files ("sha256" appears once per schema). Exact name +
path filters disambiguate, but a cleaner extraction policy (skip untitled
primitive properties, or namespace them) would reduce catalog noise —
changing it alters the entity corpus and relation derivation, so it needs
an explicit product call.

CORRECTION (same day, after reading the parser): the diagnosis above was
wrong. `parseJsonSchemaFacts` promotes nothing — it extracts the root
schema (by title) plus `$defs`/`definitions` entries only. The 32 "sha256"
entities are legitimate `$defs` entries in the provider-mirrored schemas
themselves (`"sha256": {"type": "string", "pattern": "^sha256:..."}`),
and a fresh parse matches the live index exactly (no staleness, no bug).
The repetition is source-schema authoring style in provider-owned mirrored
assets, which must not be edited (provider-contract mirror check). A
characterization test now pins the invariant that makes the repetition
harmless: same-named defs in different files yield distinct,
path-qualified entities (suite 380/380).

## Final verdict (end of the dogfooding campaign)

Objective (gaps.yaml): repeated unchanged queries measurably cheaper
without weakening integrity, plus an Execution Proof Ledger — measured
against the 2026-10-05 baseline (repeated sync 1871/1035/867ms, repeated
MCP query 675/735ms, execution-reuse score 2.0).

| Layer | Baseline (2026-10-05) | Live today (1224-file corpus) |
| --- | --- | --- |
| Unchanged repeated query | 675-735ms | **39.68ms p50** (fast path; ~17x) |
| Repeated sync (full) | 867-1871ms | 195.82ms warm full sync (bigger corpus) |
| Exact-name lookup | grep/manual | ~0.14ms/query indexed, 5.49ms/40 batch |
| Full verification cycle | minutes (4128+ tests every run) | cold PASS + reuse REUSED in ~10-20s; ~368/370 files reused per-file |
| False-reuse rate | n/a (no reuse existed) | 0 incidents, kill switch byte-identical |

All eight gaps.yaml closure criteria verified live. Campaign totals: 6
TDD fixes (list() over-200 truncation, imports in file queries for both
transports, 50-row default pagination, facts_entities, relations on entity
rows), 2 test-only pins (stage-input shape, path-qualified entity ids),
4 quality gates verified live for the first time (kill-switch byte
equality, impact with resolution changes, cursor continuation, catalog
pagination).

Honest limits confirmed: a small repo with grep stays competitive for flat
questions; the non-TS resolution layer remains weak (builtin-heavy
"unresolved"); and the tooling does not save you from your own process
contention — running `pnpm test:facts` concurrently with a GENTLE_PROOFS
full pass produced 6 spurious failures (isolated rerun: 380/380 twice).
Relevance verdict: relevant, objective fulfilled with measured wall-clock
numbers, and dogfooding-grade — it caught real bugs, including in itself.
