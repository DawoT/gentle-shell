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
