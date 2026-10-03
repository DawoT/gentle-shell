import { extractFactsTreeInput } from "./facts-tree.ts";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { readFactsCommit } from "./facts-git-objects.ts";
import { FactsStore } from "./facts-store.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";
import { execFile } from "node:child_process";
import { devNull } from "node:os";

function gitStatusCommand(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  return new Promise((resolve, reject) => {
    const deadline = new AbortController();
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new Error("Facts Git deadline exceeded")), 15_000);
    execFile("git", args, { cwd, env: environment, encoding: "utf8", maxBuffer: 1024 * 1024, signal: active }, (error, stdout) => {
      clearTimeout(timer);
      if (active.aborted) reject(active.reason);
      else if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * True only when HEAD is exactly `commitId` and `git status --porcelain` reports no changes.
 * Never throws: returns false when Git is unavailable, fails, times out, or the signal aborts.
 */
export async function commitMatchesWorkingTree(cwd: string, commitId: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const head = (await gitStatusCommand(cwd, ["rev-parse", "HEAD"], signal)).trim();
    if (head !== commitId) return false;
    const status = await gitStatusCommand(cwd, ["status", "--porcelain"], signal);
    return status.length === 0;
  } catch {
    return false;
  }
}

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
