import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { readFactsCommit } from "./facts-git-objects.ts";
import { extractSourceFacts, factsLanguage } from "./facts-languages.ts";
import { computeGitBlobSha } from "./facts-git-indexer.ts";
import { mapFactsIO } from "./facts-io.ts";
import { extractExecutionReceipts } from "./facts-receipts-extractor.ts";
import { FactsStore } from "./facts-store.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type FileFacts } from "./facts-types.ts";
import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export async function indexFactsCommit(cwd: string, revision: string, signal?: AbortSignal) {
  const input = await readFactsCommit(cwd, revision, signal);
  const scope = relative(await realpath(input.root), await realpath(cwd));
  if (isAbsolute(scope) || scope === ".." || scope.startsWith(`..${sep}`)) throw new Error("Facts commit scope is outside the repository");
  const store = new FactsStore(input.root, ".pi/facts-commit-cache");
  return store.withWriterLock(async () => {
    const temporary = await mkdtemp(join(tmpdir(), "gentle-facts-commit-"));
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
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, signal);
}
