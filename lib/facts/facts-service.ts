import { FactsLimitError, MAX_SOURCE_BYTES, MAX_INDEX_BYTES, readFactsFile } from "./facts-limits.ts";
import { extname, join, posix } from "node:path";
import { encodeFacts } from "./facts-codec.ts";
import { calculateFactsDelta, computeGitBlobSha, scanGitWorkspace } from "./facts-git-indexer.ts";
import { extractExecutionReceipts } from "./facts-receipts-extractor.ts";
import { FactsStore } from "./facts-store.ts";
import { extractSourceFacts, factsLanguage } from "./facts-languages.ts";
import { CONTRACT_PARSER_VERSION, isContractFile, parseContractFacts } from "./facts-contract-parser.ts";
import { FACTS_DATABASE_VERSION, type ExecutionReceipts, type FactsDatabase, type SymbolFact, type EntityFact, type EntityRelation, type EntityKind, type EntityRelationKind } from "./facts-types.ts";
import { describeFactsFailure, type FactsDiagnostics, type FactsPhase } from "./facts-diagnostics.ts";
import { FactsPhaseMetrics, type FactsMetricPhase, type FactsPhaseMetricsSnapshot } from "./facts-phase-metrics.ts";
import { WorkspaceEpoch, type WorkspaceDirtyReason } from "./facts-workspace-epoch.ts";
import {
  buildFactsQueryIndex,
  queryDependencyEvidenceLinear,
  queryDependencyEvidenceWithIndex,
  querySymbolsLinear,
  querySymbolsWithIndex,
  type DependencyEvidence,
  type FactsQueryIndex,
  type SymbolQueryResult,
} from "./facts-query-index.ts";
import { buildLexicalIndex, lexicalSearch, type LexicalIndex, type LexicalMatch } from "./facts-lexical-index.ts";

import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export interface SyncOptions {
  /** "auto" may serve the validated in-memory generation or join an equivalent in-flight refresh; "full" always rescans. */
  mode?: "auto" | "full";
}

export interface FactsServiceOptions {
  metrics?: FactsPhaseMetrics;
  /** Enables the fast path for auto-mode syncs. Off by default; callers opt in. */
  fastPath?: boolean;
  /** Starts a workspace watcher for the fast path; false models watcher-unavailable environments. */
  fastPathWatch?: boolean;
  /** Full reconciliation is forced after this many fast-path refreshes. */
  reconcileEvery?: number;
  /** Full reconciliation is forced after this long without a full sync. */
  reconcileIntervalMs?: number;
}





export interface SyncResult {
  indexedCount: number;
  cachedCount: number;
  deletedCount: number;
  path?: "fast" | "full";
}

export type { SymbolQueryResult, DependencyEvidence };

function samePublication(previous: FactsDatabase, candidate: FactsDatabase): boolean {
  const { files: previousFiles, ...previousMetadata } = previous;
  const { files: candidateFiles, ...candidateMetadata } = candidate;
  if (encodeFacts(previousMetadata) !== encodeFacts(candidateMetadata) ||
    Object.keys(previousFiles).length !== Object.keys(candidateFiles).length) return false;
  for (const [path, facts] of Object.entries(candidateFiles)) {
    if (!Object.hasOwn(previousFiles, path)) return false;
    const prior = previousFiles[path];
    // Unchanged entries share the object validated by this sync's cache load.
    if (prior === facts) continue;
    if (prior.sha !== facts.sha || encodeFacts(prior) !== encodeFacts(facts)) return false;
  }
  return true;
}

/**
 * The fast path and full syncs must agree on which files belong to the
 * indexed universe: source files plus bounded contract files. A narrower
 * freshness scan would report phantom deletions and permanently disable
 * the fast path on repositories containing contract files.
 */
function isIndexCandidate(path: string): boolean {
  return factsLanguage(path) !== undefined || isContractFile(path);
}

export class FactsService {
  private readonly workspaceRoot: string;
  private readonly store: FactsStore;
  private db: FactsDatabase | null = null;
  private generation?: string;
  private resolutionEdges: FactsModuleEdge[] = [];
  private pending: Promise<void> = Promise.resolve();
  private diagnostics: FactsDiagnostics = { status: "idle" };
  private phase: FactsPhase = "cache_lock";
  private readonly metrics: FactsPhaseMetrics;
  private readonly fastPathEnabled: boolean;
  private readonly reconcileEvery: number;
  private readonly reconcileIntervalMs: number;
  private readonly epoch?: WorkspaceEpoch;
  private inFlight?: { revision: number; promise: Promise<SyncResult> };
  private autoRefreshesSinceFullSync = 0;
  private lastFullSyncAt = 0;
  private validationRevision?: number;
  private queryIndex?: FactsQueryIndex;
  private readonly queryIndexDisabled = process.env.GENTLE_FACTS_DISABLE_QUERY_INDEX === "1";
  private lexicalIndex?: LexicalIndex;

  constructor(workspaceRoot: string, customDirName?: string, options?: FactsServiceOptions) {
    this.workspaceRoot = workspaceRoot;
    this.store = new FactsStore(workspaceRoot, customDirName);
    this.metrics = options?.metrics ?? new FactsPhaseMetrics();
    this.fastPathEnabled = options?.fastPath ?? false;
    this.reconcileEvery = options?.reconcileEvery ?? 16;
    this.reconcileIntervalMs = options?.reconcileIntervalMs ?? 60_000;
    if (this.fastPathEnabled) {
      this.epoch = new WorkspaceEpoch(workspaceRoot, { watch: options?.fastPathWatch ?? true });
      this.epoch.start();
    }
  }

  sync(signal?: AbortSignal, options?: SyncOptions): Promise<SyncResult> {
    const mode = options?.mode ?? "full";
    if (mode === "auto") {
      const flight = this.inFlight;
      // Join only with an epoch tracking changes, and only when nothing has
      // been observed since the flight started; otherwise the flight cannot
      // speak for this caller's state. A failed flight is never inherited:
      // the joiner falls back to its own conservative refresh.
      if (this.epoch && flight && this.epoch.revision === flight.revision) {
        return flight.promise.then((result) => result, () => this.enqueueSync(signal, mode));
      }
      if (this.fastPathEligible()) return this.serveFastPath(signal);
    }
    return this.enqueueSync(signal, mode);
  }

  getPhaseMetrics(): FactsPhaseMetricsSnapshot {
    return this.metrics.snapshot();
  }

  recordPhaseMetric(phase: FactsMetricPhase, durationMs: number): void {
    this.metrics.record(phase, durationMs);
  }

  markWorkspaceDirty(reason: WorkspaceDirtyReason = "manual"): void {
    this.epoch?.markDirty(reason);
  }

  /** Releases fast-path resources; the service stays usable via full syncs. */
  close(): void {
    this.epoch?.close();
  }

  private fastPathEligible(): boolean {
    return this.fastPathEnabled && this.db !== null && this.db.contractParserVersion === CONTRACT_PARSER_VERSION &&
      this.diagnostics.status === "ready" &&
      this.epoch !== undefined && this.epoch.isClean() &&
      this.autoRefreshesSinceFullSync < this.reconcileEvery &&
      Date.now() - this.lastFullSyncAt < this.reconcileIntervalMs;
  }

  private async serveFastPath(signal?: AbortSignal): Promise<SyncResult> {
    signal?.throwIfAborted();
    const started = performance.now();
    if (!await this.verifyUnchanged(signal)) {
      // The cheap scan observed a change (or the Git boundary broke): take
      // the conservative path.
      return this.enqueueSync(signal, "auto");
    }
    this.metrics.record("fast_path", performance.now() - started);
    this.metrics.recordRefresh();
    this.autoRefreshesSinceFullSync++;
    this.diagnostics = { ...this.diagnostics, lastSyncPath: "fast" };
    return {
      indexedCount: 0,
      cachedCount: Object.keys(this.db!.files).length,
      deletedCount: 0,
      path: "fast",
    };
  }

  /**
   * Deterministic freshness proof for the fast path: re-run the cheap
   * workspace scan and require the exact indexed state to still hold. This
   * closes the fs.watch delivery race — an external edit followed by an
   * immediate read can never be served stale, because the scan is
   * authoritative. Only resolution, validation and publication are skipped.
   */
  private async verifyUnchanged(signal?: AbortSignal): Promise<boolean> {
    try {
      const started = performance.now();
      const scan = await scanGitWorkspace(this.workspaceRoot, signal, isIndexCandidate);
      this.metrics.record("git_scan", performance.now() - started);
      if (scan.root !== this.db!.root || scan.headCommitSha !== this.db!.lastHeadCommit) return false;
      const hashes = new Map(Object.entries(this.db!.files).map(([path, facts]) => [path, facts.sha]));
      const delta = calculateFactsDelta(hashes, scan.files);
      return delta.added.length === 0 && delta.modified.length === 0 && delta.deleted.length === 0;
    } catch {
      // Not a repository, scan failure or abort: the conservative path
      // re-raises aborts and reports real failures with full diagnostics.
      return false;
    }
  }

  private enqueueSync(signal: AbortSignal | undefined, mode: "auto" | "full"): Promise<SyncResult> {
    const enqueuedAt = performance.now();
    const revision = this.epoch?.revision;
    const run = this.pending.then(() => {
      this.metrics.record("queue_wait", performance.now() - enqueuedAt);
      this.metrics.recordRefresh();
      return this.syncWithDiagnostics(signal, mode);
    });
    this.pending = run.then(() => undefined, () => undefined);
    const flight = { revision, promise: run };
    this.inFlight = flight;
    void run.then(() => undefined, () => undefined).then(() => {
      if (this.inFlight === flight) this.inFlight = undefined;
    });
    return run;
  }

  getDiagnostics(): FactsDiagnostics {
    return { ...structuredClone(this.diagnostics), diskCacheLoad: this.store.getLoadState() };
  }

  private timePhase<T>(phase: FactsMetricPhase, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    return work().finally(() => {
      this.metrics.record(phase, performance.now() - started);
    });
  }

  private timeSyncPhase<T>(phase: FactsMetricPhase, work: () => T): T {
    const started = performance.now();
    try {
      return work();
    } finally {
      this.metrics.record(phase, performance.now() - started);
    }
  }

  private async syncWithDiagnostics(signal: AbortSignal | undefined, mode: "auto" | "full"): Promise<SyncResult> {
    const started = performance.now();
    this.diagnostics = { ...this.diagnostics, status: "refreshing", failure: undefined };
    this.phase = "cache_lock";
    try {
      const result = await this.timePhase("cache_lock", () =>
        this.store.withWriterLock(async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const snapshot = await this.syncSnapshot(signal);
            if (snapshot) {
              // markClean only cleans when nothing was observed since
              // validation started; otherwise the epoch stays dirty.
              this.epoch?.markClean(this.validationRevision);
              this.autoRefreshesSinceFullSync = 0;
              this.lastFullSyncAt = Date.now();
              return snapshot;
            }
          }
          throw new Error("Facts workspace changed during analysis; retry when edits settle.");
        }, signal));
      this.diagnostics = { status: "ready", lastSuccessfulSyncAt: Date.now(), lastSyncPath: "full" };
      return result;
    } catch (error) {
      this.diagnostics = {
        ...this.diagnostics,
        status: "unavailable",
        failure: describeFactsFailure(error, this.phase),
      };
      throw error;
    } finally {
      this.diagnostics.lastDurationMs = performance.now() - started;
    }
  }

  private async syncSnapshot(signal: AbortSignal | undefined): Promise<SyncResult | null> {
    signal?.throwIfAborted();
    const isCandidate = isIndexCandidate;
    this.phase = "git_scan";
    const scan = await this.timePhase("git_scan", () =>
      scanGitWorkspace(this.workspaceRoot, signal, isCandidate));

    this.phase = "cache_load";
    // The lock serializes writers; reload their last publication before diffing.
    const loaded = await this.timePhase("cache_load", () => this.store.load(signal));
    const previous = loaded?.root === scan.root ? loaded : null;
    const db: FactsDatabase = previous
      ? { ...previous, files: { ...previous.files } }
      : {
        version: FACTS_DATABASE_VERSION,
        root: scan.root,
        updatedAt: Date.now(),
        files: {},
      };

    // A working-tree refresh cannot retain provenance from an imported commit cache.
    delete db.source;

    // Compute existing hashes
    const previousHashes = new Map<string, string>();
    for (const [path, file] of Object.entries(db.files)) {
      previousHashes.set(path, file.sha);
    }

    const delta = calculateFactsDelta(previousHashes, scan.files);
    // A contract parser change invalidates stored entities even for unchanged
    // files: re-parse every contract file when the parser version differs.
    const parserChanged = db.contractParserVersion !== CONTRACT_PARSER_VERSION;
    const toIndex = [...delta.added, ...delta.modified];
    if (parserChanged) {
      for (const relPath of scan.files.keys()) {
        if (isContractFile(relPath) && !toIndex.includes(relPath)) toIndex.push(relPath);
      }
    }

    // 1. Purge deleted files
    for (const delPath of delta.deleted) {
      delete db.files[delPath];
      if (db.entities) {
        db.entities = db.entities.filter((e) => e.path !== delPath);
      }
      if (db.entityRelations) {
        db.entityRelations = db.entityRelations.filter((r) => {
          const fromEntity = db.entities?.find((e) => e.id === r.from);
          const toEntity = db.entities?.find((e) => e.id === r.to);
          return fromEntity && toEntity;
        });
      }
    }

    // 2. Index added and modified files
    let indexedCount = 0;
    let indexedBytes = 0;
    this.phase = "source_index";

    await this.timePhase("source_index", async () => {
      for (const relPath of toIndex) {
        if (!isCandidate(relPath)) continue;

        const entry = scan.files.get(relPath);
        if (!entry || entry.status === "deleted") continue;

        try {
          const fullPath = join(scan.root, relPath);
          const content = await readFactsFile(fullPath, MAX_SOURCE_BYTES, signal);
          indexedBytes += content.length;
          if (indexedBytes > MAX_INDEX_BYTES) {
            throw new FactsLimitError(`Facts workspace byte limit (${MAX_INDEX_BYTES}) exceeded`);
          }
          if (factsLanguage(relPath)) {
            const facts = await extractSourceFacts(relPath, content.toString("utf8"), computeGitBlobSha(content), signal);
            db.files[relPath] = facts;
            indexedCount++;
          } else if (isContractFile(relPath)) {
            const contract = parseContractFacts(relPath, content);
            db.files[relPath] = {
              path: relPath,
              sha: computeGitBlobSha(content),
              symbols: [],
              imports: [],
              exports: [],
              sourceBytes: content.length,
            };
            db.entities = [...(db.entities ?? []).filter((e) => e.path !== relPath), ...contract.entities];
            const incomingIds = new Set(contract.entities.map((e) => e.id));
            db.entityRelations = [
              ...(db.entityRelations ?? []).filter((r) => !incomingIds.has(r.from)),
              ...contract.entityRelations,
            ];
            indexedCount++;
          }
        } catch (cause) {
          signal?.throwIfAborted();
          if (cause instanceof FactsLimitError || (cause instanceof Error && cause.name === "FactsParserError")) throw cause;
          throw new Error(`Cannot index source file: ${relPath}`, { cause });
        }
      }
    });

    db.contractParserVersion = CONTRACT_PARSER_VERSION;

    // Contract usage relations (S6.3): derive consumes/validates edges from
    // recorded imports of indexed source files into contract files. Test
    // files validate; other consumers consume. Endpoints use derived
    // consumer/test entities so impact traversal maps them to files.
    // Previous derivations are rebuilt from scratch on every sync.
    const contractPaths = new Set(Object.keys(db.files).filter((candidate) => isContractFile(candidate)));
    const entitiesByPath = new Map<string, EntityFact[]>();
    for (const entity of db.entities ?? []) {
      const list = entitiesByPath.get(entity.path) ?? [];
      list.push(entity);
      entitiesByPath.set(entity.path, list);
    }
    const derivedEntities: EntityFact[] = [];
    const derivedRelations: EntityRelation[] = [];
    const derivedEntityIds = new Set<string>();
    for (const [path, facts] of Object.entries(db.files)) {
      if (contractPaths.has(path) || facts.imports.length === 0) continue;
      const isTest = /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
      const targets = new Set<string>();
      for (const specifier of facts.imports) {
        if (!specifier.startsWith(".")) continue;
        const resolved = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (contractPaths.has(resolved)) targets.add(resolved);
      }
      for (const target of targets) {
        const kind: EntityKind = isTest ? "test" : "consumer";
        const id = `${kind}:${path}`;
        if (!derivedEntityIds.has(id)) {
          derivedEntityIds.add(id);
          derivedEntities.push({ id, kind, name: path.split("/").pop() ?? path, path });
        }
        for (const entity of entitiesByPath.get(target) ?? []) {
          derivedRelations.push({ from: id, to: entity.id, kind: isTest ? "validates" : "consumes" });
        }
      }
    }
    db.entities = [...(db.entities ?? []).filter((entity) => entity.kind !== "consumer" && entity.kind !== "test"), ...derivedEntities];
    db.entityRelations = [
      ...(db.entityRelations ?? []).filter((relation) => !relation.from.startsWith("consumer:") && !relation.from.startsWith("test:")),
      ...derivedRelations,
    ];

    // 3. Extract execution receipts
    this.phase = "manifest";
    db.receipts = await this.timePhase("manifest", () =>
      extractExecutionReceipts(scan.root, this.workspaceRoot, { signal }));
    db.lastHeadCommit = scan.headCommitSha;
    this.phase = "module_resolution";
    const typedFiles = Object.fromEntries(Object.entries(db.files).filter(([path]) => factsLanguage(path) === "typescript"));
    const moduleSnapshot = Object.keys(typedFiles).length
      ? await this.timePhase("module_resolution", async () =>
        await (await import("./facts-worker.ts")).resolveModuleSnapshotInWorker(scan.root, typedFiles, signal))
      : undefined;
    const resolutionEdges: FactsModuleEdge[] = moduleSnapshot?.edges ?? [];
    for (const [path, facts] of Object.entries(db.files)) {
      if (factsLanguage(path) === "typescript") continue;
      for (const specifier of facts.imports) {
        resolutionEdges.push({ importer: path, specifier, evidence: "unresolved", reason: "language-resolution-not-supported" });
      }
    }
    db.moduleEdges = resolutionEdges;
    this.phase = "snapshot_validation";
    this.validationRevision = this.epoch?.revision;
    const validated = await this.timePhase("snapshot_validation", async (): Promise<boolean> => {
      const observed = await scanGitWorkspace(this.workspaceRoot, signal, isCandidate);
      const candidateHashes = new Map(Object.entries(db.files).map(([path, facts]) => [path, facts.sha]));
      const drift = calculateFactsDelta(candidateHashes, observed.files);
      let validationBytes = 0;
      let sourceChanged = false;
      for (const path of drift.modified) {
        // Git's index can contain normalized bytes (CRLF or clean filters).
        // Facts hashes the raw bytes parsed, so confirm mismatches on disk.
        const content = await readFactsFile(join(observed.root, path), MAX_SOURCE_BYTES, signal);
        validationBytes += content.length;
        if (validationBytes > MAX_INDEX_BYTES) {
          throw new FactsLimitError(`Facts validation byte limit (${MAX_INDEX_BYTES}) exceeded`);
        }
        if (computeGitBlobSha(content) !== candidateHashes.get(path)) {
          sourceChanged = true;
          break;
        }
      }
      const receipts = await extractExecutionReceipts(observed.root, this.workspaceRoot, { signal });
      if (observed.root !== db.root || observed.headCommitSha !== db.lastHeadCommit ||
        drift.added.length || sourceChanged || drift.deleted.some((path) => candidateHashes.has(path)) ||
        encodeFacts(receipts) !== encodeFacts(db.receipts)) {
        return false;
      }
      if (moduleSnapshot && !await (await import("./facts-worker.ts")).validateModuleSnapshotInWorker(moduleSnapshot, signal)) {
        return false;
      }
      return true;
    });
    if (!validated) return null;
    signal?.throwIfAborted();
    if (!previous || !samePublication(previous, db)) {
      db.updatedAt = Date.now();
      this.phase = "cache_save";
      await this.timePhase("cache_save", () => this.store.save(db, signal));
    }
    this.db = db;
    this.generation = this.store.getGeneration();
    this.resolutionEdges = resolutionEdges;

    return {
      indexedCount,
      cachedCount: delta.untouched.length,
      deletedCount: delta.deleted.length,
      path: "full",
    };
  }

  querySymbol(name: string): SymbolQueryResult[] {
    return this.querySymbols({ name });
  }

  querySymbols(query: { name?: string; file?: string }): SymbolQueryResult[] {
    return this.timeSyncPhase("query_lookup", () => {
      if (!this.db) return [];
      if (this.queryIndexDisabled) return querySymbolsLinear(this.db, query);
      return querySymbolsWithIndex(this.queryIndexFor(), query);
    });
  }

  queryEntities(query: { name?: string; path?: string; kind?: EntityKind } = {}): EntityFact[] {
    return this.timeSyncPhase("query_lookup", () => {
      const entities = this.db?.entities ?? [];
      return entities.filter((entity) => {
        if (query.name !== undefined && entity.name.toLowerCase() !== query.name.toLowerCase()) return false;
        if (query.path !== undefined && entity.path !== query.path) return false;
        if (query.kind !== undefined && entity.kind !== query.kind) return false;
        return true;
      });
    });
  }

  queryEntityRelations(query: { from?: string; to?: string; kind?: EntityRelationKind } = {}): EntityRelation[] {
    return this.timeSyncPhase("query_lookup", () => {
      const relations = this.db?.entityRelations ?? [];
      return relations.filter((rel) => {
        if (query.from !== undefined && rel.from !== query.from) return false;
        if (query.to !== undefined && rel.to !== query.to) return false;
        if (query.kind !== undefined && rel.kind !== query.kind) return false;
        return true;
      });
    });
  }

  /** Lexical discovery over symbol names, paths and docstrings (gaps GF-P2-004). */
  searchSymbols(query: string, options: { limit?: number } = {}): LexicalMatch[] {
    return this.timeSyncPhase("lexical_search", () => {
      if (!this.db) return [];
      if (!this.lexicalIndex || this.lexicalIndex.dbRef !== this.db) {
        this.lexicalIndex = buildLexicalIndex(this.db);
      }
      return lexicalSearch(this.lexicalIndex, query, options);
    });
  }

  /** Rebuilds lazily whenever the (db, generation, edges) trio changes. */
  private queryIndexFor(): FactsQueryIndex {
    if (!this.queryIndex || this.queryIndex.generation !== this.generation ||
      this.queryIndex.dbRef !== this.db || this.queryIndex.edgesRef !== this.resolutionEdges) {
      this.queryIndex = buildFactsQueryIndex(this.db!, this.resolutionEdges, this.generation);
    }
    return this.queryIndex;
  }

  getGeneration(): string | undefined {
    return this.generation;
  }

  queryDependents(symbolOrFile: string, options: { transitive?: boolean } = {}): string[] {
    return this.queryDependencyEvidence(symbolOrFile, options).map((item) => item.file);
  }

  getResolutionEdges(): FactsModuleEdge[] {
    return this.resolutionEdges.map((edge) => ({ ...edge }));
  }

  queryDependencyEvidence(symbolOrFile: string, options: { transitive?: boolean } = {}): DependencyEvidence[] {
    return this.timeSyncPhase("query_lookup", () => {
      if (!this.db) return [];
      if (this.queryIndexDisabled) return queryDependencyEvidenceLinear(this.db, this.resolutionEdges, symbolOrFile, options);
      return queryDependencyEvidenceWithIndex(this.queryIndexFor(), symbolOrFile, options);
    });
  }


  /**
   * Usage sites of a symbol: files whose recorded references include the
   * exact name, excluding the declaring files. Files without recorded
   * references (legacy databases, non-TS sources) are not reported.
   */
  queryUsageSites(name: string): Array<{ file: string; importsDeclaration: boolean }> {
    return this.timeSyncPhase("query_lookup", () => {
      if (!this.db) return [];
      const declarations = this.querySymbols({ name });
      if (declarations.length === 0) return [];
      const declaringFiles = new Set(declarations.map((match) => match.file));
      const importersOfDeclaring = new Set<string>();
      for (const edge of this.resolutionEdges) {
        if (edge.target !== undefined && declaringFiles.has(edge.target)) importersOfDeclaring.add(edge.importer);
      }
      const sites: Array<{ file: string; importsDeclaration: boolean }> = [];
      for (const [path, file] of Object.entries(this.db.files)) {
        if (declaringFiles.has(path)) continue;
        if (file.references?.includes(name) !== true) continue;
        sites.push({ file: path, importsDeclaration: importersOfDeclaring.has(path) });
      }
      return sites;
    });
  }

  getReceipts(): ExecutionReceipts | undefined {
    return this.db?.receipts;
  }

  getDatabase(): FactsDatabase | null {
    return this.db;
  }

  getSummaryPromptBlock(): string {
    if (!this.db) return "";
    const receipts = this.db?.receipts;
    const fileCount = Object.keys(this.db?.files || {}).length;
    let totalSymbols = 0;
    for (const file of Object.values(this.db?.files || {})) {
      totalSymbols += file.symbols.length;
    }

    const lines: string[] = [
      "[PROJECT GROUND TRUTH]",
      `- Package Manager: ${receipts?.packageManager || "unknown"}`,
      `- Declared Test Command: ${receipts?.testCommand || "none declared"}`,
      `- Command Directory: ${receipts?.commandCwd ?? "."} (relative to repository root)`,
    ];

    if (receipts?.buildCommand) {
      lines.push(`- Build Command: ${receipts.buildCommand}`);
    }
    if (receipts?.lintCommand) {
      lines.push(`- Lint Command: ${receipts.lintCommand}`);
    }

    lines.push(
      `- Indexed Files: ${fileCount} | Total Symbols: ${totalSymbols}`,
      "- CONTEXT RULE: For signatures, declarations, types and import dependencies, use facts_query or facts_dependents before reading source or searching with grep. Discover symbols with facts_query(file: repository-relative path); narrow by name when known.",
      "- Inspect relevant source when Facts is unavailable, returns no matches, has unresolved dependencies, or you need implementation behavior for debugging, review or edits. Read the relevant implementation before changing it; Facts does not prove runtime behavior or complete impact.",
    );

    return lines.map((line) => {
      if (line.length <= 2000) return line;
      const label = line.slice(0, line.indexOf(":") + 1);
      return `${label} [Display truncated; inspect package.json for the complete value.]`;
    }).join("\n");
  }
}
