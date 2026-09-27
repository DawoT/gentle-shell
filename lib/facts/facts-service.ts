import { FactsLimitError, MAX_SOURCE_BYTES, MAX_INDEX_BYTES, readFactsFile } from "./facts-limits.ts";
import { extname, join, posix } from "node:path";
import { calculateFactsDelta, computeGitBlobSha, scanGitWorkspace } from "./facts-git-indexer.ts";
import { extractExecutionReceipts } from "./facts-receipts-extractor.ts";
import { FactsStore } from "./facts-store.ts";
import { extractTypeScriptFacts } from "./facts-ts-extractor.ts";
import { FACTS_DATABASE_VERSION, type ExecutionReceipts, type FactsDatabase, type SymbolFact } from "./facts-types.ts";
import { describeFactsFailure, type FactsDiagnostics, type FactsPhase } from "./facts-diagnostics.ts";

import { resolveFactsModules, type FactsModuleEdge } from "./facts-module-resolver.ts";

export interface DependencyEvidence {
  file: string;
  depth: number;
  via: string;
  evidence: "typescript" | "syntactic";
}

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface SyncResult {
  indexedCount: number;
  cachedCount: number;
  deletedCount: number;
}

export interface SymbolQueryResult {
  file: string;
  symbol: SymbolFact;
}

export class FactsService {
  private readonly workspaceRoot: string;
  private readonly store: FactsStore;
  private db: FactsDatabase | null = null;
  private resolutionEdges: FactsModuleEdge[] = [];
  private pending: Promise<void> = Promise.resolve();
  private diagnostics: FactsDiagnostics = { status: "idle" };
  private phase: FactsPhase = "cache_lock";

  constructor(workspaceRoot: string, customDirName?: string) {
    this.workspaceRoot = workspaceRoot;
    this.store = new FactsStore(workspaceRoot, customDirName);
  }

  sync(signal?: AbortSignal): Promise<SyncResult> {
    const result = this.pending.then(() => this.syncWithDiagnostics(signal));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  getDiagnostics(): FactsDiagnostics {
    return { ...structuredClone(this.diagnostics), diskCacheLoad: this.store.getLoadState() };
  }

  private async syncWithDiagnostics(signal?: AbortSignal): Promise<SyncResult> {
    const started = performance.now();
    this.diagnostics = { ...this.diagnostics, status: "refreshing", failure: undefined };
    this.phase = "cache_lock";
    try {
      const result = await this.store.withWriterLock(() => this.syncSnapshot(signal), signal);
      this.diagnostics = { status: "ready", lastSuccessfulSyncAt: Date.now() };
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

  private async syncSnapshot(signal?: AbortSignal): Promise<SyncResult> {
    signal?.throwIfAborted();
    this.phase = "git_scan";
    const scan = await scanGitWorkspace(this.workspaceRoot, signal, (path) => SUPPORTED_EXTENSIONS.has(extname(path)));

    this.phase = "cache_load";
    // The lock serializes writers; reload their last publication before diffing.
    const loaded = await this.store.load(signal);
    const previous = loaded?.root === scan.root ? loaded : null;
    const db: FactsDatabase = previous
      ? { ...previous, files: { ...previous.files } }
      : {
        version: FACTS_DATABASE_VERSION,
        root: scan.root,
        updatedAt: Date.now(),
        files: {},
      };

    // Compute existing hashes
    const previousHashes = new Map<string, string>();
    for (const [path, file] of Object.entries(db.files)) {
      previousHashes.set(path, file.sha);
    }

    const delta = calculateFactsDelta(previousHashes, scan.files);

    // 1. Purge deleted files
    for (const delPath of delta.deleted) {
      delete db.files[delPath];
    }

    // 2. Index added and modified files
    const toIndex = [...delta.added, ...delta.modified];
    let indexedCount = 0;
    let indexedBytes = 0;
    this.phase = "source_index";

    for (const relPath of toIndex) {
      const ext = extname(relPath);
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const entry = scan.files.get(relPath);
      if (!entry || entry.status === "deleted") continue;

      try {
        const fullPath = join(scan.root, relPath);
        const content = await readFactsFile(fullPath, MAX_SOURCE_BYTES, signal);
        indexedBytes += content.length;
        if (indexedBytes > MAX_INDEX_BYTES) {
          throw new FactsLimitError(`Facts workspace byte limit (${MAX_INDEX_BYTES}) exceeded`);
        }
        const facts = extractTypeScriptFacts(relPath, content.toString("utf8"), computeGitBlobSha(content));
        db.files[relPath] = facts;
        indexedCount++;
      } catch (cause) {
        signal?.throwIfAborted();
        if (cause instanceof FactsLimitError) throw cause;
        throw new Error(`Cannot index source file: ${relPath}`, { cause });
      }
    }

    // 3. Extract execution receipts
    this.phase = "manifest";
    db.receipts = await extractExecutionReceipts(scan.root, this.workspaceRoot, { signal });
    db.lastHeadCommit = scan.headCommitSha;
    const resolutionEdges = resolveFactsModules(scan.root, db.files);
    signal?.throwIfAborted();
    if (!previous || JSON.stringify(previous) !== JSON.stringify(db)) {
      db.updatedAt = Date.now();
      this.phase = "cache_save";
      await this.store.save(db, signal);
    }
    this.db = db;
    this.resolutionEdges = resolutionEdges;

    return {
      indexedCount,
      cachedCount: delta.untouched.length,
      deletedCount: delta.deleted.length,
    };
  }

  querySymbol(name: string): SymbolQueryResult[] {
    if (!this.db) return [];
    const results: SymbolQueryResult[] = [];

    for (const [file, facts] of Object.entries(this.db.files)) {
      for (const symbol of facts.symbols) {
        if (symbol.name === name || symbol.name.toLowerCase() === name.toLowerCase()) {
          results.push({ file, symbol });
        }
      }
    }

    return results;
  }

  queryDependents(symbolOrFile: string, options: { transitive?: boolean } = {}): string[] {
    return this.queryDependencyEvidence(symbolOrFile, options).map((item) => item.file);
  }

  getResolutionEdges(): FactsModuleEdge[] {
    return this.resolutionEdges.map((edge) => ({ ...edge }));
  }

  queryDependencyEvidence(symbolOrFile: string, options: { transitive?: boolean } = {}): DependencyEvidence[] {
    if (!this.db) return [];
    const files = this.db.files;
    const targetPath = posix.normalize(symbolOrFile.replaceAll("\\", "/").replace(/^\.\//, ""));
    const targets = new Set<string>();
    if (Object.hasOwn(files, targetPath)) {
      targets.add(targetPath);
    } else {
      if (!targetPath.includes("/") && extname(targetPath)) {
        const basenameMatches = Object.keys(files).filter((path) => path.endsWith(`/${targetPath}`));
        if (basenameMatches.length === 1) targets.add(basenameMatches[0]);
      }
      for (const [path, facts] of Object.entries(files)) {
        if (facts.symbols.some((symbol) => symbol.isExported && symbol.name === symbolOrFile)) {
          targets.add(path);
        }
      }
    }

    const found = new Map<string, DependencyEvidence>();
    const visited = new Set(targets);
    let frontier = new Set(targets);
    let depth = 1;
    do {
      const next = new Set<string>();
      for (const edge of this.resolutionEdges) {
        const resolved = edge.target !== undefined && frontier.has(edge.target);
        const literal = depth === 1 && targets.size === 0 && !edge.specifier.startsWith(".") && edge.specifier === symbolOrFile;
        if ((!resolved && !literal) || visited.has(edge.importer)) continue;
        found.set(edge.importer, {
          file: edge.importer,
          depth,
          via: edge.target ?? edge.specifier,
          evidence: resolved ? "typescript" : "syntactic",
        });
        next.add(edge.importer);
      }
      for (const file of next) visited.add(file);
      frontier = next;
      depth++;
    } while (options.transitive && frontier.size > 0);
    return [...found.values()].sort((a, b) => a.file.localeCompare(b.file, "en"));
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
      "- Fact Tools: Use 'facts_query' to inspect signatures and types without opening files.",
    );

    return lines.map((line) => {
      if (line.length <= 2000) return line;
      const label = line.slice(0, line.indexOf(":") + 1);
      return `${label} [Display truncated; inspect package.json for the complete value.]`;
    }).join("\n");
  }
}
