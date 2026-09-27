import { readVerifiedTreeEntries } from "./facts-git-trees.ts";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { FactsLimitError, MAX_INDEX_BYTES, MAX_INDEX_FILES, MAX_SOURCE_BYTES } from "./facts-limits.ts";
import { factsLanguage } from "./facts-languages.ts";
import { basename, delimiter, extname, isAbsolute, posix } from "node:path";

interface CommitFile {
  path: string;
  oid: string;
  size: number;
  marker: boolean;
}

export interface FactsObjectStore {
  objectDirectory: string;
  alternateObjectDirectories?: readonly string[];
}

export interface TreeInput {
  root: string;
  tree: string;
  files: Map<string, Buffer>;
  omitted: Array<{ path: string; reason: "symlink" | "submodule" }>;
}

export interface CommitInput extends TreeInput {
  commit: string;
  committedAt: number;
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const LOCKFILES = new Set(["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "package-lock.json"]);

function gitEnvironment(store?: FactsObjectStore): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  if (store) {
    const paths = [store.objectDirectory, ...(store.alternateObjectDirectories ?? [])];
    if (paths.length > 9 || paths.some((path) => typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\x00-\x1f]/.test(path)) ||
      store.alternateObjectDirectories?.some((path) => path.includes(delimiter) || path.includes('"'))) {
      throw new Error("Invalid Facts object directory transport");
    }
  }
  return {
    ...environment,
    ...(store ? { GIT_OBJECT_DIRECTORY: store.objectDirectory, GIT_ALTERNATE_OBJECT_DIRECTORIES: store.alternateObjectDirectories?.join(delimiter) ?? "" } : {}),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function git(cwd: string, args: string[], maxBuffer: number, signal?: AbortSignal, input?: string, store?: FactsObjectStore): Promise<Buffer> {
  signal?.throwIfAborted();
  const environment = gitEnvironment(store);
  return new Promise((resolve, reject) => {
    const deadline = new AbortController();
    const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const timer = setTimeout(() => deadline.abort(new Error("Facts Git deadline exceeded")), 15_000);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let outcome: { data: Buffer } | { error: unknown };
    const child = execFile("git", ["--no-replace-objects", ...args], {
      cwd,
      env: environment,
      encoding: "buffer",
      maxBuffer,
      signal: active,
    }, (error, stdout, stderr) => {
      if (active.aborted) outcome = { error: active.reason };
      else if (error) outcome = { error: new Error(`Cannot read Facts commit: ${stderr.toString("utf8").slice(0, 1000) || error.message}`, { cause: error }) };
      else outcome = { data: stdout };
      if (error) escalation = setTimeout(() => child.kill("SIGKILL"), 250);
    });
    child.once("close", () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      if (!outcome) reject(new Error("Facts Git closed without a result"));
      else if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.data);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function checkPath(path: string): void {
  if (!path || posix.isAbsolute(path) || /[\\:\x00-\x1f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git" ||
      /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Commit contains a source/metadata path that cannot be safely materialized: ${JSON.stringify(path)}`);
  }
}

export async function readFactsCommit(cwd: string, revision: string, signal?: AbortSignal): Promise<CommitInput> {
  signal?.throwIfAborted();
  if (typeof revision !== "string" || !revision || revision.length > 1024 || /[\x00-\x1f]/.test(revision)) {
    throw new Error("Invalid Facts commit revision");
  }
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], 64 * 1024, signal)).toString("utf8").replace(/\n$/, "");
  const commit = (await git(root, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], 1024, signal)).toString("utf8").trim();
  if (!OBJECT_ID.test(commit)) throw new Error("Invalid resolved Facts commit");
  const rawCommit = await git(root, ["cat-file", "commit", commit], MAX_SOURCE_BYTES, signal);
  const commitHash = createHash(commit.length === 64 ? "sha256" : "sha1")
    .update(`commit ${rawCommit.length}\0`).update(rawCommit).digest("hex");
  if (commitHash !== commit) throw new Error("Git commit checksum mismatch");
  const headers = rawCommit.toString("utf8").split("\n\n", 1)[0];
  const timestamps = [...headers.matchAll(/^committer [^\n]* (-?\d+) [+-]\d{4}$/gm)];
  if (timestamps.length !== 1) throw new Error("Invalid Facts commit timestamp");
  const committedAt = Number(timestamps[0][1]) * 1000;
  if (!Number.isFinite(committedAt) || !Number.isFinite(new Date(committedAt).getTime())) throw new Error("Invalid Facts commit timestamp");
  const treeHeaders = [...headers.matchAll(/^tree ([a-f0-9]{40}|[a-f0-9]{64})$/gm)];
  if (treeHeaders.length !== 1) throw new Error("Invalid Facts commit tree");
  const input = await readFactsTree(root, treeHeaders[0][1], signal);
  return { ...input, commit, committedAt };
}

/** Internal transport: the caller supplies controller-validated object directories, never model input. */
export async function readFactsTree(cwd: string, treeId: string, signal?: AbortSignal, store?: FactsObjectStore): Promise<TreeInput> {
  signal?.throwIfAborted();
  if (typeof treeId !== "string" || !OBJECT_ID.test(treeId)) throw new Error("Invalid Facts tree identifier");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], 64 * 1024, signal)).toString("utf8").replace(/\n$/, "");
  const entries = await readVerifiedTreeEntries(treeId, (ids) => git(root, ["cat-file", "--batch"],
    16 * 1024 * 1024 + ids.length * 100, signal, ids.join("\n") + "\n", store), signal);
  const selected: CommitFile[] = [];
  const omitted: TreeInput["omitted"] = [];
  for (const { path, mode, oid } of entries) {
    if (mode === "120000" || mode === "160000") {
      omitted.push({ path, reason: mode === "120000" ? "symlink" : "submodule" });
      continue;
    }
    const marker = LOCKFILES.has(basename(path));
    if (!factsLanguage(path) && ![".json", ".jsonc"].includes(extname(path)) && !marker) continue;
    checkPath(path);
    if (selected.length >= MAX_INDEX_FILES) throw new FactsLimitError("Facts commit inventory limit exceeded");
    selected.push({ path, oid, size: 0, marker });
  }
  if (selected.length) {
    const output = await git(root, ["cat-file", "--batch-check"], MAX_INDEX_FILES * 100, signal,
      selected.map((entry) => entry.oid).join("\n") + "\n", store);
    const lines = output.toString("ascii").trimEnd().split("\n");
    if (lines.length !== selected.length) throw new Error("Invalid Git blob inventory");
    let bytes = 0;
    for (const [index, entry] of selected.entries()) {
      const header = lines[index].split(" ");
      const size = Number(header[2]);
      if (header.length !== 3 || header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new Error("Invalid Git source blob");
      if (!entry.marker && size > MAX_SOURCE_BYTES) throw new FactsLimitError(`Facts commit source byte limit exceeded: ${entry.path}`);
      bytes += entry.marker ? 0 : size;
      if (bytes > MAX_INDEX_BYTES) throw new FactsLimitError("Facts commit inventory limit exceeded");
      entry.size = size;
    }
  }
  const blobs = selected.filter((entry) => !entry.marker);
  const output = blobs.length ? await git(root, ["cat-file", "--batch"], MAX_INDEX_BYTES + MAX_INDEX_FILES * 100, signal,
    blobs.map((entry) => entry.oid).join("\n") + "\n", store) : Buffer.alloc(0);
  const files = new Map<string, Buffer>();
  let offset = 0;
  for (const entry of blobs) {
    signal?.throwIfAborted();
    const newline = output.indexOf(10, offset);
    if (newline < 0 || output.subarray(offset, newline).toString("ascii") !== `${entry.oid} blob ${entry.size}`) {
      throw new Error("Invalid Git batch object header");
    }
    const end = newline + 1 + entry.size;
    if (end >= output.length || output[end] !== 10) throw new Error("Truncated Git batch object");
    const content = output.subarray(newline + 1, end);
    const hash = createHash(entry.oid.length === 64 ? "sha256" : "sha1")
      .update(`blob ${content.length}\0`).update(content).digest("hex");
    if (hash !== entry.oid) throw new Error("Git commit blob checksum mismatch");
    files.set(entry.path, content);
    offset = end + 1;
  }
  if (offset !== output.length) throw new Error("Unexpected Git batch output");
  for (const entry of selected) if (entry.marker) files.set(entry.path, Buffer.alloc(0));
  return { root, tree: treeId, files, omitted };
}
