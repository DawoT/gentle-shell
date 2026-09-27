import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readFactsTree, type TreeInput, type FactsObjectStore } from "./facts-git-objects.ts";
import { extractSourceFacts, factsLanguage } from "./facts-languages.ts";
import { computeGitBlobSha } from "./facts-git-indexer.ts";
import { mapFactsIO } from "./facts-io.ts";
import { extractExecutionReceipts } from "./facts-receipts-extractor.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type FileFacts } from "./facts-types.ts";
import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export async function extractFactsTreeInput(input: TreeInput, scope: string, signal?: AbortSignal) {
  const temporary = await mkdtemp(join(tmpdir(), "gentle-facts-tree-"));
  try {
    await mapFactsIO([...input.files], async ([path, content], activeSignal) => {
      activeSignal.throwIfAborted();
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx", mode: 0o600, signal: activeSignal });
    }, signal);
    const files: Record<string, FileFacts> = Object.create(null);
    for (const [path, content] of input.files) {
      if (!factsLanguage(path)) continue;
      signal?.throwIfAborted();
      files[path] = await extractSourceFacts(path, content.toString("utf8"), computeGitBlobSha(content), signal);
    }
    const typedFiles = Object.fromEntries(Object.entries(files).filter(([path]) => factsLanguage(path) === "typescript"));
    const edges: FactsModuleEdge[] = Object.keys(typedFiles).length
      ? await (await import("./facts-worker.ts")).resolveModulesInWorker(temporary, typedFiles, signal, true)
      : [];
    for (const [path, facts] of Object.entries(files)) {
      if (factsLanguage(path) === "typescript") continue;
      for (const specifier of facts.imports) edges.push({ importer: path, specifier, evidence: "unresolved", reason: "language-resolution-not-supported" });
    }
    const receipts = await extractExecutionReceipts(temporary, join(temporary, scope), { signal });
    return { files, edges, receipts };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function indexFactsTree(cwd: string, tree: string, signal?: AbortSignal, objectStore?: FactsObjectStore) {
  const input = await readFactsTree(cwd, tree, signal, objectStore);
  const { files, edges, receipts } = await extractFactsTreeInput(input, ".", signal);
  const database: FactsDatabase = {
    version: FACTS_DATABASE_VERSION,
    root: input.root,
    updatedAt: 0,
    files,
    moduleEdges: edges,
    receipts,
  };
  return { tree: input.tree, database, omitted: input.omitted };
}
