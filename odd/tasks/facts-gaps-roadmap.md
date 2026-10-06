# Facts gaps roadmap execution

Parent tracker for executing `/home/deuz/projects/gentle-shell/gaps.yaml`
("gentle-facts-gaps-and-improvement-roadmap", generated 2026-10-04, currently
untracked). Cross-repository: gentle-ai consumes Facts via
internal/review/facts_risk_signals.go; this roadmap changes the producer side.
User approved the sprint/TDD plan on 2026-10-05.

## Objective and authority

Make repeated unchanged Facts queries measurably cheaper without weakening
snapshot integrity, writer safety or external-edit detection; then add an
Execution Proof Ledger for deterministic validation commands. The acceptance
bar is `closure_criteria_for_future_implementation` in gaps.yaml. R1xM per
unit: explorer -> one bounded writer -> independent verifier. TDD: observed
RED before implementation, hermetic fixtures only, no test relaxation. Local
commits authorized (Conventional Commits, work-unit sized); no push/PR/merge,
model switch or RDD-disable without explicit authorization. User dirty files
(bin/gentle-shell.mjs, lib/codex-native/provider.ts,
tests/codex-native-extension.test.ts, .agents/, gaps.yaml) are preserved
untouched. B1 native review-786a02b33e841875 resumes after quota reset
2026-10-08 23:38 from exact fresh STATUS; no old-binding replay; no
substitution of unbound component evidence for admission. Human /reload of the
primary Pi is pending before native closure.

## Target surfaces

lib/facts/facts-service.ts (orchestrator, 345 lines), facts-store,
facts-git-indexer, facts-module-resolver, facts-receipts-extractor,
facts-history, facts-worker, extensions/gentle-facts.ts (lifecycle hooks).
The 30 existing tests/facts-*.test.ts files are the regression shield; none
may be weakened or skipped.

## Sprints (1 week, benchmark-gated)

### Sprint 0 — Measure and unblock (Oct 5–9)

- [x] S0.1 Phase metrics: refresh_total, per-phase timers (git_scan_ms,
  cache_load_ms, source_index_ms, receipt_extract_ms, module_resolve_ms,
  snapshot_validate_ms, history_save_ms, query_lookup_ms),
  refresh_coalesced_waiters, dirty_epoch_age_ms. RED: counter/timer assertions
  under a fake clock; GREEN: minimal instrumentation, zero behavior change.
- [x] S0.2 Real-repo baseline harness: p50/p95/p99 for cold / unchanged /
  post-edit / burst on this repository, phase-level breakdown, filesystem type
  recorded. Baseline numbers written before any optimization commit. Prior
  evidence: repeated sync 1871/1035/867ms; repeated MCP query 675/735ms.
- [x] S0.3 Burst benchmark: >=3 concurrent same-epoch sync/query callers to
  demonstrate the OBS-003 stampede (multiple equivalent freshness checks).
  Delivered inside the S0.2 harness as the burst scenario.
- [ ] S0.4 External unblock: after 2026-10-08 23:38 quota reset, resume
  review-786a02b33e841875 from exact fresh STATUS (closes gentle-shell B1 and
  gentle-ai L2). Human /reload first. No fake approval/consumption claims.

Sprint gate: baseline recorded; zero optimization commits landed.

### Sprint 1 — Make Facts cheap I: epoch + single-flight (Oct 12–16)

- [x] S1.1 Workspace epoch + dirty set (GF-P0-001). RED first: unchanged
  repeat query still pays full Git scan (phase timers prove it); then watcher
  event marks epoch dirty; fast path returns the already-validated in-memory
  generation while clean; periodic reconciliation converges to the
  conservative path (equivalence test). Existing edit-between-scan, reversion,
  cancellation, concurrent-writer and external-writer-generation tests stay
  green. Dirty reasons tracked: source, manifest, lockfile, tsconfig,
  generated metadata, external-writer generation.
- [x] S1.2 Single-flight sync (GF-P0-002). RED: N concurrent callers produce N
  equivalent scans; GREEN: one in-flight refresh keyed by root+dirty epoch,
  promise shared, individual waiter cancellation does not kill the shared
  refresh; new refresh only after epoch change or irrecoverable failure.
- [x] S1.3 Lifecycle scheduling (GF-P0-006). Mark dirty on
  write/edit/apply_diff instead of forcing duplicate full refreshes; lazy
  refresh on first consumer needing fresh facts; expose refresh reason and
  path used (fast-path / incremental / full reconciliation). RED: duplicate
  refresh around one edit epoch across before_agent_start/query/post-write.

Gate: unchanged-query p95 improved vs S0 baseline; full suite green;
equivalence property (fast path result == conservative result on same tree).

### Sprint 2 — Make Facts cheap II: caches (Oct 19–23)

- [ ] S2.1 Receipt/config fingerprint cache (GF-P0-004): fingerprint
  package.json, lockfiles and nearest-package traversal inputs once per epoch;
  reuse parsed receipt during snapshot validation while inputs unchanged;
  explicit invalidation: package-manager, scripts, dependency changes.
- [ ] S2.2 History write fast path (GF-P0-005): bind last successful history
  receipt to the Facts generation ID; skip canonical serialize/hash when
  generation unchanged; content-address verification preserved on first
  write/load.
- [ ] S2.3 Incremental module-resolution cache (GF-P0-003, largest, do last):
  persist importer->resolved edges plus the exact justifying metadata probes,
  keyed by importer SHA, import list and effective tsconfig digest; reverse
  map tsconfig/project-reference -> importers for targeted invalidation; full
  resolution on reconciliation or when completeness cannot be proven.

Gate: warm sync dominated by in-memory lookup and cheap coherence checks;
resolver-cache equivalence test (cached == full resolution) passes;
corruption and invalidation-cause tests green.

### Sprint 3 — Execution Proof Ledger MVP (Oct 26–30)

- [ ] S3.1 Proof schema + content-addressed local store (GF-P1-001, GF-P1-006):
  lifecycle states running/passed/failed/stale/expired/invalidated/aborted;
  digests and bounded references only, never raw stdout as proof.
- [ ] S3.2 Canonical execution fingerprint (GF-P1-002): canonical argv, cwd,
  test selection, runner identity; repo tree + dirty-worktree digest + Facts
  generation; toolchain/package-manager versions; declared env dependency set
  with HMAC for value-sensitive variables (never plaintext secrets); runtime
  state fingerprints. RED: any missing input dimension must block reuse.
- [ ] S3.3 Single-flight execution lease (GF-P1-003): proof lease keyed by
  fingerprint, heartbeat/expiry, takeover after proven owner loss, provenance
  for owner/waiters/publication. RED: concurrent identical requests execute
  once.
- [ ] S3.4 Confidence classes hermetic_static + hermetic_unit (GF-P1-005
  subset); side-effect classification pure_validation / reproducible_build /
  local_mutation / external_side_effect (GF-P1-007); failure and flake policy
  (GF-P1-008): short failure retention, flaky classification, rerun/quorum.

Gate: same-inputs reuse without executing the runner; every reuse explainable
(fingerprint, age, class, inputs); unknown dependency forces execution;
force-run / no-cache / reconcile modes work.

### Sprint 4 — Invalidation + selective verification (Nov 2–6)

- [ ] S4.1 Safe invalidation engine (GF-P1-004): layers exact-input >
  static-reachability (Facts dependents/impact) > runtime-observation >
  policy-expiry; invariant: absence of a static path is not proof of runtime
  independence; Facts impact is an invalidation aid only.
- [ ] S4.2 Minimum test set (GF-P2-001): changed inputs -> affected tests via
  Facts edges; reuse valid proofs for unaffected tests; execute only
  invalidated ones; conservative fallback to broader suite when mapping
  confidence is incomplete; suite aggregate never reports green from stale
  constituents.
- [ ] S4.3 Proof-aware test runner integration (GF-P2-008): wrap existing
  run-test-suite stages; reused-vs-executed surfaced explicitly; stage
  independence preserved; release gates can require fresh execution.

### Sprint 5+ — Optional expansion (Nov 9+)

Each independently approved, never bundled: EntityFact/Contract Facts
(GF-P2-003), per-generation query indexes (GF-P2-005), lexical/conceptual
discovery (GF-P2-004), dynamic test-to-input learning (GF-P2-002),
explainable proof query tools (GF-P3-001), proof composition (GF-P3-002),
optional shared storage (GF-P3-003, only after local correctness metrics).

## Per-unit workflow (every unit, no exceptions)

1. Explorer agent (read-only): map exact surfaces, tests to extend, premise
   challenge. No implementation by the explorer.
2. RED: failing tests first with real failure output captured in this tracker.
   Hermetic fixtures only (owned dirs/config, absolute git boundaries); no
   ambient state; no synthetic RED invented when change is characterization.
3. One bounded writer: minimal GREEN, conventional commit, work-unit sized
   (work-unit-commits skill). Compilable units only; no package-by-package
   broken splits.
4. Independent verifier agent (fresh context): focused + package/full suites,
   type-baseline ratchet, runtime-module check, equivalence/property tests for
   any fast path. A timeout has no verdict; foreground rerun required (L1
   precedent). No verdict from stale or ambient-contaminated runs.
5. Native review per source unit when quota allows; receipts recorded with
   SHA256; no approval claims without admission. Reviewer quota blocks native
   closure only, never functional verification.
6. Tracker update per unit: evidence, diff SHA256, scope changes, incidents.

## Quality gates (elite bar)

- Baseline-first: no optimization commit before Sprint 0 numbers exist;
  improvements reported as measured deltas against that baseline.
- Equivalence invariant: every fast path converges to the conservative path;
  property/equivalence tests enforce it, not manual inspection.
- Conservative fallback always reachable: kill-switch flag/env per fast path;
  full reconciliation remains authoritative and testable.
- gaps.yaml quality_invariants and what_not_to_do are mandatory review
  checklists: no command-string reuse, unknown input blocks strong reuse,
  invalidate before regression is observed, secrets never persisted plaintext,
  immutable content-addressed publication, no silent side-effect skipping.
- No test weakening, no skipped coverage, no synthetic-only performance claims
  (real-repo p50/p95/p99, FS type, cold/warm assumptions recorded).
- Rollback: each unit independently revertible; sprint gates prevent stacking
  new units on a red gate.

## Risk register

- Watcher event loss -> periodic full Git reconciliation remains authoritative
  (covered by S1.1 tests).
- Cross-process writers -> immutable generation pointer remains the source of
  truth; fast-path state invalidates on foreign publication (S1.1/S2 tests).
- Quota still exhausted on 2026-10-08 -> B1/L2 stays blocked; roadmap
  continues; no fabricated closure.
- Optimization weakens snapshot integrity -> equivalence tests + existing 30
  facts suites + kill switches.
- Synthetic overstatement -> real-repository benchmarks with phase-level
  timings and percentiles only.

## Execution log

### 2026-10-05 — S0.1 phase metrics (committed 8c4c4d48)

- Explorer: full FactsService.sync phase map (8 phases inside withWriterLock
  + 3-attempt drift retry), existing patterns reused (FactsDiagnostics phase
  vocabulary, FactsUsage sink shape, runtime-metrics injectable-options
  precedent), risks catalogued (worker queue serialization, structuredClone,
  history outside sync, queue wait invisible inside syncWithDiagnostics).
- RED observed: `ERR_MODULE_NOT_FOUND: Cannot find module
  '.../lib/facts/facts-phase-metrics.ts'` (tests 1, fail 1) — real failure,
  not asserted.
- GREEN: lib/facts/facts-phase-metrics.ts (FactsPhaseMetrics,
  FactsMetricPhase incl. queue_wait/query_lookup/history_save), service
  wraps each phase with performance.now() timers via timePhase/timeSyncPhase,
  sync() records queue_wait + refreshTotal before the chain runs,
  recordFactsHistory records history_save in try/finally. New public surface:
  getPhaseMetrics(), recordPhaseMetric(), optional ctor options {metrics}.
- Tests: tests/facts-phase-metrics.test.ts 6/6 pass. Characterization held:
  unchanged second sync does not republish (cache_save count stays 1).
- Independent verifier: PASS. pnpm test:facts 305/305 (31 files), pnpm
  typecheck pass (types 188, 11 pairs improved, no regressions), pnpm
  check:runtime-modules pass (11 modules match), semantic diff audit
  confirmed zero behavior change (control flow, byte limits, abort checks,
  error propagation identical; all timing pure performance.now()).
- Committed as 8c4c4d48 "feat(facts): record per-phase refresh metrics".

### 2026-10-05 — S0.2/S0.3 real-repo baseline (recorded, commit pending)

- Harness: scripts/benchmark-facts-real.mjs + package.json
  benchmark:facts:real. Corpus = 910 tracked files at HEAD via git archive
  into a disposable tmpdir; the live .pi cache is never read or mutated.
  Self-check assertions per scenario; FS type recorded (tmpfs).
- Baseline (7 samples) recorded in docs/bench/facts-baseline-2026-10.md:
  warm unchanged query p50 182.51ms (module_resolution ~62ms, then
  snapshot_validation, git_scan, cache_load); cold p50 1287.67ms
  (source_index-dominated); burst 3 concurrent unchanged syncs p50 wall
  537.94ms = 2.95x warm (fully serialized, zero coalescing; 3749.26ms
  cumulative queue wait across 21 callers) — OBS-001/002/003 confirmed on
  the real repository shape.
- No optimization commits: Sprint 0 gate satisfied (baseline exists, zero
  optimization changes landed).

### Branch anomaly (resolved 2026-10-05)

The 17:42:57 branch switch to fix/web-terminal-cleanup was resolved after user
direction: Sprint 0 commits were fast-forwarded onto main (main at 84bf9d61),
all other local branches deleted (all were fully merged into main; zero
unmerged work), detached .pi worktrees untouched. Sprint 1 commits land
directly on main.

### Sprint 1 executed 2026-10-05 (ahead of the Oct 12 slot)

- Unit A commit 755cafaa "feat(facts): workspace epoch fast path and
  single-flight sync": auto/full sync modes (default unchanged = full),
  WorkspaceEpoch, single-flight join by epoch revision, reconcile budget
  (16 fast refreshes / 60s), kill switch options. RED observed
  (ERR_MODULE_NOT_FOUND), 11 tests, suite 316/316.
- Independent verifier verdict on Unit A: FAIL with 3 findings, all fixed
  before commit: (1) typecheck ratchet — invalid dirty-reason literal; (2)
  watcher failure did NOT keep the epoch permanently dirty (empirically
  disproven) — markClean now refuses while the watcher is failed, so no fast
  path without a live watcher; (3) microtask window could join a FAILED
  settled flight — joiners now fall back to their own conservative sync when
  the joined flight rejects.
- Unit B verifier verdict: FAIL with the decisive finding: with auto-mode
  reads, an external edit followed by an immediate query could be served
  stale (fs.watch delivery race) — the pre-existing guarantee test
  "facts_query refreshes external edits before returning signatures" went
  flaky. DESIGN CORRECTION: the fast path no longer trusts the watcher.
  serveFastPath now proves freshness deterministically by re-running the
  cheap workspace scan (~35ms) and serving in-memory only when the delta is
  empty and the HEAD commit matches; any change, boundary break or scan
  failure falls back to the full conservative sync. The watcher/epoch remain
  as belt-and-braces (dirty => full), single-flight keeps the epoch revision
  as its join key. The pointer-identity check was removed as redundant
  (the scan is strictly stronger). Also fixed: samePublication formatting
  corruption flagged by the verifier.
- Legacy test "session lifecycle mounts and refreshes the facts card" was
  updated to the new GF-P0-006 contract, strictly stronger: asserts the card
  still shows the pre-edit state right after a write hook (lazy) AND shows
  fresh state after the next consuming refresh.
- Final state: 321/321 facts tests across two consecutive runs (flake gone
  by construction), typecheck ratchet clean, runtime modules match.
- Sprint 1 gate (scripts/benchmark-facts-real.mjs autoRead scenario, 7
  samples, 915-file corpus): unchanged auto-read p50 50.66ms / p95 53.62ms
  versus full sync in the same run p50 249.22ms / p95 291.04ms = 4.9x faster;
  phase breakdown shows only the verifying git_scan, zero resolution,
  validation, cache load or publication. The 2026-10 baseline doc records
  the full-sync reference numbers for cold/postEdit/burst.
- B1/L2 external plan unchanged (see below).

### B1/L2 resume plan (external, 2026-10-08 23:38 quota reset)

1. Human /reload of the primary Pi (loads the M3 parser fix 435a01ad).
2. Verify quota recovered with one cheap native probe; no model switch.
3. Resume review-786a02b33e841875 from its exact fresh STATUS; do not replay
   old bindings or prepared verdicts (there are none).
4. On admission: record receipt + SHA256 in main-live-completion.md (B1) and
   facts-informed-review-go.md (L2, gentle-ai). If quota is still exhausted,
   B1 stays blocked and the roadmap continues; no fabricated closure.
