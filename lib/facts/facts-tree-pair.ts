/**
 * Tree-pair subject digest (facts-informed-review S2a).
 *
 * Pure function over two immutable git trees: it classifies what changed
 * (added/modified/deleted) within a caller-supplied set of changed paths and
 * summarizes the Facts delta (exported symbols) plus module-graph boundary
 * effects (cross-boundary edges, unchanged dependents).
 *
 * Trees are immutable, so recomputation is always correct and no caching or
 * staleness gating is performed here. Reuse of pinned generations
 * (see facts-store.ts) is the future optimization; deliberately not implemented.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { indexFactsTree } from "./facts-tree.ts";

const runGit = promisify(execFile);

export type TreePairDigestErrorCode = "unknown-tree";

export class TreePairDigestError extends Error {
  readonly code: TreePairDigestErrorCode;
  constructor(code: TreePairDigestErrorCode, message: string) {
    super(message);
    this.name = "TreePairDigestError";
    this.code = code;
  }
}

export interface ExportedSymbolRef {
  name: string;
  kind: string;
}

export interface TreePairDigestFile {
  path: string;
  classification: "added" | "modified" | "deleted";
  exportedSymbols: {
    base: ExportedSymbolRef[];
    candidate: ExportedSymbolRef[];
  };
}

export interface TreePairDigestBoundaryEdge {
  importer: string;
  specifier: string;
  target?: string;
  importerChanged: boolean;
  targetChanged: boolean;
}

export interface TreePairDigest {
  baseTree: string;
  candidateTree: string;
  changedPaths: string[];
  files: TreePairDigestFile[];
  boundaryEdges: TreePairDigestBoundaryEdge[];
  unchangedDependents: number;
  extractedAt: number;
}

async function treeExists(cwd: string, tree: string): Promise<boolean> {
  try {
    await runGit("git", ["-C", cwd, "cat-file", "-e", `${tree}^{tree}`]);
    return true;
  } catch {
    return false;
  }
}

function exportedSymbols(file: { symbols: { name: string; kind: string; isExported: boolean }[] } | undefined): ExportedSymbolRef[] {
  if (!file) return [];
  return file.symbols
    .filter((symbol) => symbol.isExported)
    .map((symbol) => ({ name: symbol.name, kind: symbol.kind }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function computeTreePairDigest(
  cwd: string,
  baseTree: string,
  candidateTree: string,
  changedPaths: string[],
): Promise<TreePairDigest> {
  for (const tree of [baseTree, candidateTree]) {
    if (!(await treeExists(cwd, tree))) {
      throw new TreePairDigestError("unknown-tree", `unknown git tree: ${tree}`);
    }
  }
  const changed = new Set(changedPaths);
  const [base, candidate] = await Promise.all([
    indexFactsTree(cwd, baseTree),
    indexFactsTree(cwd, candidateTree),
  ]);
  const paths = new Set(changedPaths);
  for (const key of [...Object.keys(base.database.files), ...Object.keys(candidate.database.files)]) {
    if (changed.has(key)) paths.add(key);
  }
  const files: TreePairDigestFile[] = [];
  for (const path of [...paths].sort()) {
    const before = base.database.files[path];
    const after = candidate.database.files[path];
    if (!before && !after) continue;
    const classification = !after ? "deleted" : !before ? "added" : before.sha === after.sha ? "modified" : "modified";
    if (classification === "modified" && before && after && before.sha === after.sha) continue;
    files.push({
      path,
      classification,
      exportedSymbols: { base: exportedSymbols(before), candidate: exportedSymbols(after) },
    });
  }
  const boundaryEdges: TreePairDigestBoundaryEdge[] = [];
  let unchangedDependents = 0;
  for (const edge of candidate.database.moduleEdges ?? []) {
    if (!edge.target) continue;
    const importerChanged = changed.has(edge.importer);
    const targetChanged = changed.has(edge.target);
    if (importerChanged === targetChanged) continue;
    boundaryEdges.push({
      importer: edge.importer,
      specifier: edge.specifier,
      target: edge.target,
      importerChanged,
      targetChanged,
    });
    if (!importerChanged && targetChanged) unchangedDependents += 1;
  }
  boundaryEdges.sort((a, b) => a.importer.localeCompare(b.importer) || (a.target ?? "").localeCompare(b.target ?? ""));
  return {
    baseTree,
    candidateTree,
    changedPaths: [...changedPaths].sort(),
    files,
    boundaryEdges,
    unchangedDependents,
    extractedAt: Date.now(),
  };
}
