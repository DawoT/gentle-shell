import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { withFactsWriterLock } from "../facts/facts-lock.ts";
import { join } from "node:path";

const MAX_SUMMARY_BYTES = 1024 * 1024;
const MAX_SESSION_MEMORY_BYTES = 16 * 1024 * 1024;

interface ProjectMemoryRecord {
  version: 1;
  id: string;
  project_id: string;
  session_id: string;
  kind: "compaction";
  observed_at: number;
  source_entry_id: string;
  parent_entry_id: string | null;
  first_kept_entry_id: string;
  tokens_before: number;
  reason: "manual" | "threshold" | "overflow";
  will_retry: boolean;
  summary: string;
  facts_receipt?: {
    digest: string;
    root: string;
    observed_at: number;
  };
}

export interface ProjectMemoryReference {
  id: string;
  kind: "compaction";
  observed_at: number;
  source_entry_id: string;
  facts_digest?: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validRecord(value: unknown, projectId: string): value is ProjectMemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || record.project_id !== projectId || record.kind !== "compaction"
    || typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)
    || typeof record.session_id !== "string" || record.session_id.length > 1024
    || typeof record.summary !== "string" || Buffer.byteLength(record.summary, "utf8") > MAX_SUMMARY_BYTES
    || typeof record.observed_at !== "number" || !Number.isSafeInteger(record.observed_at)
    || typeof record.source_entry_id !== "string" || record.source_entry_id.length > 1024
    || !(record.parent_entry_id === null || (typeof record.parent_entry_id === "string" && record.parent_entry_id.length <= 1024))
    || typeof record.first_kept_entry_id !== "string" || record.first_kept_entry_id.length > 1024
    || typeof record.tokens_before !== "number" || !Number.isSafeInteger(record.tokens_before) || record.tokens_before < 0
    || !["manual", "threshold", "overflow"].includes(String(record.reason))
    || typeof record.will_retry !== "boolean") return false;
  if (record.facts_receipt !== undefined) {
    if (!record.facts_receipt || typeof record.facts_receipt !== "object" || Array.isArray(record.facts_receipt)) return false;
    const facts = record.facts_receipt as Record<string, unknown>;
    if (typeof facts.digest !== "string" || !/^[a-f0-9]{64}$/.test(facts.digest)
      || typeof facts.root !== "string" || facts.root.length > 16_384
      || typeof facts.observed_at !== "number" || !Number.isSafeInteger(facts.observed_at)) return false;
  }
  const { id, ...payload } = record;
  return digest(payload) === id;
}

export interface ProjectMemoryOptions {
  writableRoots?: string[];
}

export class ProjectMemory {
  private readonly workspaceRoot: string;
  private readonly directory: string;
  private readonly file: string;
  private readonly projectId: string;
  private readonly sessionId: string;

  private constructor(
    workspaceRoot: string,
    directory: string,
    file: string,
    projectId: string,
    sessionId: string,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.directory = directory;
    this.file = file;
    this.projectId = projectId;
    this.sessionId = sessionId;
  }

  static async open(
    workspaceOrConfig: string,
    sessionOrWorkspace: string,
    optionsOrSession?: ProjectMemoryOptions | string,
  ): Promise<ProjectMemory> {
    let workspaceRoot: string;
    let sessionId: string;
    let options: ProjectMemoryOptions | undefined;

    if (typeof optionsOrSession === "string") {
      workspaceRoot = sessionOrWorkspace;
      sessionId = optionsOrSession;
      options = undefined;
    } else {
      workspaceRoot = workspaceOrConfig;
      sessionId = sessionOrWorkspace;
      options = optionsOrSession;
    }

    if (!sessionId || sessionId.length > 1024) {
      throw new Error("Project memory session ID must contain 1 to 1024 characters");
    }

    const canonicalWorkspace = await realpath(workspaceRoot).catch(() => workspaceRoot);

    if (options?.writableRoots && options.writableRoots.length > 0) {
      const canonicalRoots = await Promise.all(
        options.writableRoots.map(async (r) => await realpath(r).catch(() => r))
      );
      const isAllowed = canonicalRoots.some((root) => {
        const prefix = root.endsWith("/") ? root : root + "/";
        return canonicalWorkspace === root || canonicalWorkspace.startsWith(prefix);
      });
      if (!isAllowed) {
        throw new Error(`Project memory workspace is outside authorized writable roots: ${workspaceRoot}`);
      }
    }

    const projectId = digest(canonicalWorkspace);
    const directory = join(canonicalWorkspace, ".agents", "memory");
    const file = join(directory, `${digest(sessionId)}.jsonl`);
    return new ProjectMemory(canonicalWorkspace, directory, file, projectId, sessionId);
  }

  private async ensureContainedDirectory(): Promise<void> {
    const agentsDir = join(this.workspaceRoot, ".agents");
    try {
      const agentsLstat = await lstat(agentsDir);
      if (agentsLstat.isSymbolicLink()) {
        throw new Error("Project memory refuses symlink directories that could escape its workspace");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }

    try {
      const memLstat = await lstat(this.directory);
      if (memLstat.isSymbolicLink()) {
        throw new Error("Project memory refuses symlink directories that could escape its workspace");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async saveCompaction(input: {
    id: string;
    parentId: string | null;
    timestamp: string;
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    reason: "manual" | "threshold" | "overflow";
    willRetry: boolean;
    factsReceipt?: {
      digest: string;
      root: string;
      observedAt: number;
    };
  }): Promise<ProjectMemoryReference> {
    if (!input.id || input.id.length > 1024) throw new Error("Project memory entry ID must contain 1 to 1024 characters");
    if (!(input.parentId === null || (typeof input.parentId === "string" && input.parentId.length <= 1024))) {
      throw new Error("Project memory parent entry ID is invalid");
    }
    if (!input.firstKeptEntryId || input.firstKeptEntryId.length > 1024) throw new Error("Project memory kept entry ID must contain 1 to 1024 characters");
    if (!Number.isSafeInteger(input.tokensBefore) || input.tokensBefore < 0) throw new Error("Project memory token count must be a nonnegative safe integer");
    if (!["manual", "threshold", "overflow"].includes(input.reason) || typeof input.willRetry !== "boolean") {
      throw new Error("Project memory compaction metadata is invalid");
    }
    if (input.factsReceipt && (!/^[a-f0-9]{64}$/.test(input.factsReceipt.digest)
      || !input.factsReceipt.root || input.factsReceipt.root.length > 16_384
      || !Number.isSafeInteger(input.factsReceipt.observedAt))) {
      throw new Error("Project memory Facts receipt is invalid");
    }
    if (!input.summary.trim()) throw new Error("Project memory refuses an empty compaction summary");
    if (Buffer.byteLength(input.summary, "utf8") > MAX_SUMMARY_BYTES) throw new Error("Project memory summary exceeds 1 MiB");
    const observedAt = Date.parse(input.timestamp);
    if (!Number.isSafeInteger(observedAt)) throw new Error("Project memory requires a valid compaction timestamp");
    const payload = {
      version: 1 as const,
      project_id: this.projectId,
      session_id: this.sessionId,
      kind: "compaction" as const,
      observed_at: observedAt,
      source_entry_id: input.id,
      parent_entry_id: input.parentId,
      first_kept_entry_id: input.firstKeptEntryId,
      tokens_before: input.tokensBefore,
      reason: input.reason,
      will_retry: input.willRetry,
      summary: input.summary,
      ...(input.factsReceipt ? { facts_receipt: {
        digest: input.factsReceipt.digest,
        root: input.factsReceipt.root,
        observed_at: input.factsReceipt.observedAt,
      } } : {}),
    };
    const record: ProjectMemoryRecord = { id: digest(payload), ...payload };
    const line = `${JSON.stringify(record)}\n`;
    await this.ensureContainedDirectory();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.ensureContainedDirectory();
    await withFactsWriterLock(this.directory, async () => {
      const handle = await open(
        this.file,
        constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new Error("Project memory requires a regular session file");
        if (info.size + Buffer.byteLength(line, "utf8") > MAX_SESSION_MEMORY_BYTES) {
          throw new Error("Project memory session retention budget exceeded");
        }
        if (info.size > 0) {
          const tail = Buffer.alloc(1);
          await handle.read(tail, 0, 1, info.size - 1);
          if (tail[0] !== 10) throw new Error("Project memory has an incomplete tail; restore it from the session transcript");
        }
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    return {
      id: record.id,
      kind: record.kind,
      observed_at: record.observed_at,
      source_entry_id: record.source_entry_id,
      ...(record.facts_receipt ? { facts_digest: record.facts_receipt.digest } : {}),
    };
  }

  private async records(branchEntryIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<ProjectMemoryRecord[]> {
    signal?.throwIfAborted();
    await this.ensureContainedDirectory();
    const handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) return [];
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SESSION_MEMORY_BYTES) {
        throw new Error("Project memory session file is invalid or exceeds its retention budget");
      }
      const text = await handle.readFile({ encoding: "utf8", signal });
      const records = new Map<string, ProjectMemoryRecord>();
      for (const line of text.split("\n")) {
        signal?.throwIfAborted();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (validRecord(parsed, this.projectId) && parsed.session_id === this.sessionId
          && (!branchEntryIds || branchEntryIds.has(parsed.source_entry_id))) {
          records.set(parsed.id, parsed);
        }
      }
      return [...records.values()].sort((a, b) => b.observed_at - a.observed_at || a.id.localeCompare(b.id));
    } finally {
      await handle.close();
    }
  }

  async search(query: string, offset: number, limit: number, branchEntryIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<{
    results: ProjectMemoryReference[];
    total: number;
    next_offset: number | null;
  }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Memory offset must be a nonnegative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError("Memory limit must be between 1 and 20");
    const needle = query.trim().toLocaleLowerCase("en");
    const matches = (await this.records(branchEntryIds, signal)).filter(record => !needle || record.summary.toLocaleLowerCase("en").includes(needle));
    const results = matches.slice(offset, offset + limit).map(record => ({
      id: record.id,
      kind: record.kind,
      observed_at: record.observed_at,
      source_entry_id: record.source_entry_id,
      ...(record.facts_receipt ? { facts_digest: record.facts_receipt.digest } : {}),
    }));
    const nextOffset = offset + results.length;
    return { results, total: matches.length, next_offset: nextOffset < matches.length ? nextOffset : null };
  }

  async read(id: string, offsetChars: number, limitChars: number, branchEntryIds?: ReadonlySet<string>, signal?: AbortSignal): Promise<{
    reference: ProjectMemoryReference;
    text: string;
    offset_chars: number;
    next_offset_chars: number | null;
    digest_verified: true;
    facts_receipt?: ProjectMemoryRecord["facts_receipt"];
  } | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid project memory ID");
    if (!Number.isSafeInteger(offsetChars) || offsetChars < 0) throw new RangeError("Memory character offset must be nonnegative");
    if (!Number.isSafeInteger(limitChars) || limitChars < 1 || limitChars > 12_000) throw new RangeError("Memory character limit must be between 1 and 12000");
    const record = (await this.records(branchEntryIds, signal)).find(candidate => candidate.id === id);
    if (!record) return undefined;
    const characters = Array.from(record.summary);
    const end = Math.min(characters.length, offsetChars + limitChars);
    return {
      reference: {
        id: record.id,
        kind: record.kind,
        observed_at: record.observed_at,
        source_entry_id: record.source_entry_id,
        ...(record.facts_receipt ? { facts_digest: record.facts_receipt.digest } : {}),
      },
      text: characters.slice(offsetChars, end).join(""),
      offset_chars: offsetChars,
      next_offset_chars: end < characters.length ? end : null,
      digest_verified: true,
      ...(record.facts_receipt ? { facts_receipt: record.facts_receipt } : {}),
    };
  }
}
