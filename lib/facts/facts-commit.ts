import { extractFactsTreeInput } from "./facts-tree.ts";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { readFactsCommit } from "./facts-git-objects.ts";
import { FactsStore } from "./facts-store.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";

export async function indexFactsCommit(cwd: string, revision: string, signal?: AbortSignal) {
  const input = await readFactsCommit(cwd, revision, signal);
  const scope = relative(await realpath(input.root), await realpath(cwd));
  if (isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`)) throw new Error("Facts commit scope is outside the repository");
  const store = new FactsStore(input.root, ".pi/facts-commit-cache");
  return store.withWriterLock(async () => {
    const { files, edges, receipts } = await extractFactsTreeInput(input, scope, signal);
    const database: FactsDatabase = {
      version: FACTS_DATABASE_VERSION,
      root: input.root,
      lastHeadCommit: input.commit,
      updatedAt: input.committedAt,
      files,
      moduleEdges: edges,
      receipts,
      source: {
        kind: "commit",
        commit: input.commit,
        scope: scope.split(sep).join("/") || ".",
        extractorVersion: `facts-commit-v1/${FACTS_DATABASE_VERSION}`,
        materialization: "supported-sources-json-metadata-lock-markers",
        omitted: input.omitted,
      },
    };
    signal?.throwIfAborted();
    await store.save(database, signal);
    return { commit: input.commit, generation: store.getGeneration()!, database, omitted: input.omitted };
  }, signal);
}
