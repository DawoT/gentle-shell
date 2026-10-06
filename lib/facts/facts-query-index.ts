import { extname, posix } from "node:path";
import type { FactsDatabase, FileFacts, SymbolFact } from "./facts-types.ts";
import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export interface SymbolQueryResult {
  file: string;
  symbol: SymbolFact;
}

export interface DependencyEvidence {
  resolutionNote?: string;
  file: string;
  depth: number;
  via: string;
  evidence: "typescript" | "syntactic";
}

interface IndexedEdge {
  index: number;
  edge: FactsModuleEdge;
}

export interface FactsQueryIndex {
  generation: string | undefined;
  dbRef: FactsDatabase;
  edgesRef: FactsModuleEdge[];
  byLowerName: Map<string, { file: string; symbol: SymbolFact }[]>;
  byPath: Map<string, FileFacts>;
  exportedOwners: Map<string, string[]>;
  edgesByTarget: Map<string, IndexedEdge[]>;
  edgesByBareSpecifier: Map<string, IndexedEdge[]>;
}

/**
 * Per-generation query indexes (gaps GF-P2-005). Built lazily by the service
 * once its (db, generation, edges) trio changes; every indexed lookup must be
 * behaviorally identical to the linear reference implementations below, which
 * stay exported as the differential-test oracle. Callers must not mutate the
 * database or the edges array while an index is alive.
 */
export function buildFactsQueryIndex(db: FactsDatabase, edges: FactsModuleEdge[], generation: string | undefined): FactsQueryIndex {
  const byLowerName = new Map<string, { file: string; symbol: SymbolFact }[]>();
  const byPath = new Map<string, FileFacts>();
  const exportedOwners = new Map<string, string[]>();
  for (const [file, facts] of Object.entries(db.files)) {
    byPath.set(file, facts);
    for (const symbol of facts.symbols) {
      const key = symbol.name.toLowerCase();
      const bucket = byLowerName.get(key);
      if (bucket) bucket.push({ file, symbol });
      else byLowerName.set(key, [{ file, symbol }]);
      if (symbol.isExported) {
        const owners = exportedOwners.get(symbol.name);
        if (owners) owners.push(file);
        else exportedOwners.set(symbol.name, [file]);
      }
    }
  }
  const edgesByTarget = new Map<string, IndexedEdge[]>();
  const edgesByBareSpecifier = new Map<string, IndexedEdge[]>();
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    if (edge.target !== undefined) {
      const bucket = edgesByTarget.get(edge.target);
      if (bucket) bucket.push({ index, edge });
      else edgesByTarget.set(edge.target, [{ index, edge }]);
    }
    if (!edge.specifier.startsWith(".")) {
      const bucket = edgesByBareSpecifier.get(edge.specifier);
      if (bucket) bucket.push({ index, edge });
      else edgesByBareSpecifier.set(edge.specifier, [{ index, edge }]);
    }
  }
  return { generation, dbRef: db, edgesRef: edges, byLowerName, byPath, exportedOwners, edgesByTarget, edgesByBareSpecifier };
}

// ---------------------------------------------------------------------------
// Linear reference implementations. These are the behavioral oracle for the
// indexed variants; the service used them before the indexes existed.
// ---------------------------------------------------------------------------

export function querySymbolsLinear(db: FactsDatabase, query: { name?: string; file?: string }): SymbolQueryResult[] {
  const results: SymbolQueryResult[] = [];
  for (const [file, facts] of Object.entries(db.files)) {
    if (query.file !== undefined && file !== query.file) continue;
    for (const symbol of facts.symbols) {
      if (query.name === undefined || symbol.name.toLowerCase() === query.name.toLowerCase()) {
        results.push({ file, symbol });
      }
    }
  }
  return results;
}

export function queryDependencyEvidenceLinear(db: FactsDatabase, edges: FactsModuleEdge[], symbolOrFile: string, options: { transitive?: boolean }): DependencyEvidence[] {
  return queryEvidence(db.files, edges, symbolOrFile, options);
}

function queryEvidence(
  files: Record<string, FileFacts>,
  edges: FactsModuleEdge[],
  symbolOrFile: string,
  options: { transitive?: boolean },
): DependencyEvidence[] {
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
  const visited = new Set<string>(targets);
  let frontier = new Set<string>(targets);
  let depth = 1;
  do {
    const next = new Set<string>();
    for (const edge of edges) {
      const resolved = edge.target !== undefined && frontier.has(edge.target);
      const literal = depth === 1 && targets.size === 0 && !edge.specifier.startsWith(".") && edge.specifier === symbolOrFile;
      if ((!resolved && !literal) || visited.has(edge.importer)) continue;
      found.set(edge.importer, {
        file: edge.importer,
        depth,
        via: edge.target ?? edge.specifier,
        evidence: resolved ? "typescript" : "syntactic",
        resolutionNote: edge.reason,
      });
      next.add(edge.importer);
    }
    for (const file of next) visited.add(file);
    frontier = next;
    depth++;
  } while (options.transitive && frontier.size > 0);
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file, "en"));
}

// ---------------------------------------------------------------------------
// Indexed variants.
// ---------------------------------------------------------------------------

export function querySymbolsWithIndex(index: FactsQueryIndex, query: { name?: string; file?: string }): SymbolQueryResult[] {
  if (query.file !== undefined) {
    const facts = index.byPath.get(query.file);
    if (!facts) return [];
    const results: SymbolQueryResult[] = [];
    for (const symbol of facts.symbols) {
      if (query.name === undefined || symbol.name.toLowerCase() === query.name.toLowerCase()) {
        results.push({ file: query.file, symbol });
      }
    }
    return results;
  }
  if (query.name !== undefined) {
    return [...(index.byLowerName.get(query.name.toLowerCase()) ?? [])];
  }
  const results: SymbolQueryResult[] = [];
  for (const [file, facts] of index.byPath) {
    for (const symbol of facts.symbols) results.push({ file, symbol });
  }
  return results;
}

export function queryDependencyEvidenceWithIndex(index: FactsQueryIndex, symbolOrFile: string, options: { transitive?: boolean }): DependencyEvidence[] {
  const targetPath = normalize(symbolOrFile);
  const targets = new Set<string>();
  if (index.byPath.has(targetPath)) {
    targets.add(targetPath);
  } else {
    if (!targetPath.includes("/") && extname(targetPath)) {
      const basenameMatches = [...index.byPath.keys()].filter((path) => path.endsWith(`/${targetPath}`));
      if (basenameMatches.length === 1) targets.add(basenameMatches[0]);
    }
    const owners = index.exportedOwners.get(symbolOrFile);
    if (owners) for (const path of owners) targets.add(path);
  }

  const found = new Map<string, DependencyEvidence>();
  const visited = new Set<string>(targets);
  let frontier = new Set<string>(targets);
  let depth = 1;
  do {
    // Union the frontier's per-target edge lists (original array order within
    // each list) and, exactly like the linear scan, let the LAST matching
    // edge in original array order win the per-importer record.
    const candidates: IndexedEdge[] = [];
    for (const target of frontier) {
      candidates.push(...(index.edgesByTarget.get(target) ?? []));
    }
    if (targets.size === 0 && depth === 1) {
      candidates.push(...(index.edgesByBareSpecifier.get(symbolOrFile) ?? []));
    }
    const next = new Set<string>();
    const winner = new Map<string, IndexedEdge>();
    for (const candidate of candidates) {
      const importer = candidate.edge.importer;
      if (visited.has(importer)) continue;
      const previous = winner.get(importer);
      if (!previous || candidate.index > previous.index) winner.set(importer, candidate);
    }
    for (const [importer, candidate] of winner) {
      const resolved = candidate.edge.target !== undefined && frontier.has(candidate.edge.target);
      found.set(importer, {
        file: importer,
        depth,
        via: candidate.edge.target ?? candidate.edge.specifier,
        evidence: resolved ? "typescript" : "syntactic",
        resolutionNote: candidate.edge.reason,
      });
      next.add(importer);
    }
    for (const file of next) visited.add(file);
    frontier = next;
    depth++;
  } while (options.transitive && frontier.size > 0);
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file, "en"));
}

function normalize(symbolOrFile: string): string {
  return posix.normalize(symbolOrFile.replaceAll("\\", "/").replace(/^\.\//, ""));
}
