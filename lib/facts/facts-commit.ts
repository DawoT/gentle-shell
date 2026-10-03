import { extractFactsTreeInput } from "./facts-tree.ts";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { readFactsCommit } from "./facts-git-objects.ts";
import { FactsStore } from "./facts-store.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";
import { execFile } from "node:child_process";
import { devNull } from "node:os";

const GIT_COMMAND_DEADLINE_MS = 15_000;
const GIT_MAX_BUFFER = 1024 * 1024;

class GitProbeFailure extends Error {
  readonly kind: "caller" | "deadline" | "buffer";
  constructor(kind: "caller" | "deadline" | "buffer") {
    super(`Facts Git probe: ${kind}`);
    this.kind = kind;
  }
}

function runGitCommand(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(new GitProbeFailure("caller"));
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
    const active = new AbortController();
    let failure: GitProbeFailure | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let outcome: { data: string } | { error: unknown } | undefined;
    const abort = (kind: "caller" | "deadline") => {
      if (failure) return;
      failure = new GitProbeFailure(kind);
      active.abort();
    };
    const onCallerAbort = () => abort("caller");
    const timer = setTimeout(() => abort("deadline"), GIT_COMMAND_DEADLINE_MS);
    const escalate = () => {
      escalation ??= setTimeout(() => child.kill("SIGKILL"), 250);
    };
    const child = execFile("git", args, { cwd, env: environment, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, signal: active.signal }, (error, stdout) => {
      outcome = error ? { error } : { data: stdout };
      if (error) escalate();
    });
    // maxBuffer's callback can wait for close; escalate at capture exhaustion.
    const removeCaptureListeners: (() => void)[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      let bytes = 0;
      const onData = (chunk: string | Buffer) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > GIT_MAX_BUFFER) {
          failure ??= new GitProbeFailure("buffer");
          escalate();
        }
      };
      stream?.on("data", onData);
      removeCaptureListeners.push(() => { stream?.removeListener("data", onData); });
    }
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal?.removeEventListener("abort", onCallerAbort);
      for (const remove of removeCaptureListeners) remove();
      if (failure) reject(failure);
      else if (!outcome) reject(new Error("Facts Git closed without a result"));
      else if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.data);
    });
  });
}

/**
 * Maps a thrown Git probe failure to one stable, non-empty reason string (never throws):
 * - "git output exceeded the capture buffer": ENOBUFS error code or a message mentioning "maxBuffer".
 * - "git is not available": ENOENT-style spawn failure (error code or message).
 * - "git cancelled": typed caller cancellation, independent of caller reason.
 * - "git deadline exceeded": typed internal deadline (legacy deadline/AbortError errors also map here).
 * - "git failed": anything else, including non-Error values.
 */
export function describeGitFailure(error: unknown): string {
  try {
    if (error instanceof GitProbeFailure) {
      if (error.kind === "caller") return "git cancelled";
      if (error.kind === "deadline") return "git deadline exceeded";
      return "git output exceeded the capture buffer";
    }
    if (error && typeof error === "object") {
      const failure = error as NodeJS.ErrnoException;
      const message = typeof failure.message === "string" ? failure.message : "";
      const name = typeof failure.name === "string" ? failure.name : "";
      if (failure.code === "ENOBUFS" || message.includes("maxBuffer")) return "git output exceeded the capture buffer";
      if (failure.code === "ENOENT" || message.includes("ENOENT")) return "git is not available";
      if (name === "AbortError" || /deadline|abort/i.test(message)) return "git deadline exceeded";
    }
  } catch {
    return "git failed";
  }
  return "git failed";
}

export type CommitWorkingTreeComparison =
  | { outcome: "match"; elapsedMs: number }
  | { outcome: "differs"; elapsedMs: number }
  | { outcome: "unavailable"; reason: string; elapsedMs: number };

/**
 * Compares `commitId` to the current working tree:
 * - "match": HEAD is exactly `commitId` and `git status --porcelain` reports no changes.
 * - "differs": HEAD differs or the status is non-empty; untracked files count as differs because the working tree genuinely differs from the commit.
 * - "unavailable": Git is missing, failed, was cancelled, exceeded the probe deadline, or its output exceeded the capture buffer; `reason` comes from describeGitFailure.
 * Never throws.
 */
export async function compareCommitToWorkingTree(cwd: string, commitId: string, signal?: AbortSignal): Promise<CommitWorkingTreeComparison> {
  const started = performance.now();
  try {
    const head = (await runGitCommand(cwd, ["rev-parse", "HEAD"], signal)).trim();
    if (head !== commitId) return { outcome: "differs", elapsedMs: performance.now() - started };
    const status = await runGitCommand(cwd, ["status", "--porcelain"], signal);
    return { outcome: status.length === 0 ? "match" : "differs", elapsedMs: performance.now() - started };
  } catch (error) {
    return { outcome: "unavailable", reason: describeGitFailure(error), elapsedMs: performance.now() - started };
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
