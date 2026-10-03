import type { FactsDatabase } from "./facts-types.ts";
import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export interface ImpactConsumer {
  file: string;
  side: "base" | "candidate";
  depth: number;
  via: string;
  origin: string;
}

function inventory(database: FactsDatabase) {
  const paths = Object.keys(database.files).sort();
  const edges = database.moduleEdges ?? [];
  if (paths.length > 10_000 || edges.length > 100_000) throw new Error("Facts impact inventory limit exceeded");
  const reverse = new Map<string, Set<string>>();
  const signatures = new Map<string, string[]>();
  let resolvedImports = 0;
  let unresolvedImports = 0;
  for (const edge of edges) {
    const signature = JSON.stringify([edge.specifier, edge.target ?? null, edge.evidence, edge.reason ?? null]);
    const list = signatures.get(edge.importer) ?? [];
    list.push(signature);
    signatures.set(edge.importer, list);
    if (isLocalEdge(database, edge)) {
      resolvedImports++;
      const importers = reverse.get(edge.target!) ?? new Set<string>();
      importers.add(edge.importer);
      reverse.set(edge.target!, importers);
    } else {
      unresolvedImports++;
    }
  }
  return {
    reverse,
    signatures: new Map([...signatures].map(([path, values]) => [path, JSON.stringify([...new Set(values)].sort())])),
    coverage: { indexedFiles: paths.length, resolvedImports, unresolvedImports, graphAvailable: database.moduleEdges !== undefined },
  };
}

function isLocalEdge(database: FactsDatabase, edge: FactsModuleEdge): boolean {
  return (edge.evidence === "typescript" || edge.evidence === "filesystem") && edge.target !== undefined &&
    Object.hasOwn(database.files, edge.importer) && Object.hasOwn(database.files, edge.target);
}

function consumers(reverse: Map<string, Set<string>>, seeds: readonly string[], side: ImpactConsumer["side"], transitive: boolean): ImpactConsumer[] {
  const seen = new Set(seeds);
  const queue = seeds.map((file) => ({ file, depth: 0, origin: file }));
  const result: ImpactConsumer[] = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    for (const file of [...(reverse.get(current.file) ?? [])].sort()) {
      if (seen.has(file)) continue;
      seen.add(file);
      const entry = { file, side, depth: current.depth + 1, via: current.file, origin: current.origin };
      result.push(entry);
      if (transitive) queue.push(entry);
    }
  }
  return result;
}

/** Potential file consumers from literal import edges; never function-level impact or risk approval. */
export function analyzeFactsImpact(base: FactsDatabase, candidate: FactsDatabase, options: { transitive?: boolean } = {}) {
  if (base.root !== candidate.root) throw new Error("Facts impact requires the same repository");
  const before = inventory(base);
  const after = inventory(candidate);
  const changedSources: Array<{ file: string; change: "added" | "modified" | "deleted" }> = [];
  for (const file of [...new Set([...Object.keys(base.files), ...Object.keys(candidate.files)])].sort()) {
    if (!Object.hasOwn(base.files, file)) changedSources.push({ file, change: "added" });
    else if (!Object.hasOwn(candidate.files, file)) changedSources.push({ file, change: "deleted" });
    else if (base.files[file].sha !== candidate.files[file].sha) changedSources.push({ file, change: "modified" });
  }
  const resolutionChangedImporters = [...new Set([...before.signatures.keys(), ...after.signatures.keys()])]
    .filter((path) => (before.signatures.get(path) ?? "[]") !== (after.signatures.get(path) ?? "[]")).sort();
  const seeds = [...new Set([...changedSources.map((entry) => entry.file), ...resolutionChangedImporters])].sort();
  const transitive = options.transitive ?? true;
  return {
    assessment: "potential-file-dependents-only" as const,
    changedSources,
    resolutionChangedImporters,
    consumers: [
      ...consumers(before.reverse, seeds, "base", transitive),
      ...consumers(after.reverse, seeds, "candidate", transitive),
    ].sort((a, b) => a.file.localeCompare(b.file, "en") || a.side.localeCompare(b.side, "en")),
    coverage: { base: before.coverage, candidate: after.coverage },
    transitive,
  };
}

/** Internal review input: exact controller-owned trees; no cache publication or ambient revision lookup. */
export async function analyzeFactsTrees(
  cwd: string,
  baseTree: string,
  candidateTree: string,
  options: { transitive?: boolean; signal?: AbortSignal; objectStore?: import("./facts-git-objects.ts").FactsObjectStore } = {},
) {
  const { indexFactsTree } = await import("./facts-tree.ts");
  const base = await indexFactsTree(cwd, baseTree, options.signal, options.objectStore);
  const candidate = await indexFactsTree(cwd, candidateTree, options.signal, options.objectStore);
  options.signal?.throwIfAborted();
  return {
    baseTree: base.tree,
    candidateTree: candidate.tree,
    impact: analyzeFactsImpact(base.database, candidate.database, options),
    omitted: { base: base.omitted, candidate: candidate.omitted },
  };
}
