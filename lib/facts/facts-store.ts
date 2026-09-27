import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";
import { FactsLimitError, MAX_CACHE_BYTES, readFactsFile } from "./facts-limits.ts";

const SYMBOL_KINDS = new Set(["function", "class", "interface", "typeAlias", "enum", "variable", "constant"]);

export type FactsCacheLoadState = "unread" | "missing" | "hit" | "incompatible" | "invalid" | "oversized" | "unreadable";

export class FactsBusyError extends Error {
  constructor() {
    super("Facts cache is locked by another writer. Retry; if its process terminated, remove .pi/facts.lock after confirming no writer is running.");
    this.name = "FactsBusyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isDatabase(value: unknown): value is FactsDatabase {
  if (!isRecord(value) || value.version !== FACTS_DATABASE_VERSION ||
    typeof value.root !== "string" || !value.root ||
    typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
    (value.lastHeadCommit !== undefined && typeof value.lastHeadCommit !== "string") ||
    !isRecord(value.files)) {
    return false;
  }

  for (const [path, file] of Object.entries(value.files)) {
    if (!isRecord(file) || file.path !== path || typeof file.sha !== "string" ||
      !isStringArray(file.imports) || !isStringArray(file.exports) || !Array.isArray(file.symbols)) {
      return false;
    }
    for (const symbol of file.symbols) {
      if (!isRecord(symbol) || typeof symbol.name !== "string" ||
        typeof symbol.kind !== "string" || !SYMBOL_KINDS.has(symbol.kind) ||
        typeof symbol.signature !== "string" || typeof symbol.isExported !== "boolean" ||
        (symbol.declarationName !== undefined && typeof symbol.declarationName !== "string") ||
        typeof symbol.startLine !== "number" || !Number.isInteger(symbol.startLine) || symbol.startLine < 1 ||
        typeof symbol.endLine !== "number" || !Number.isInteger(symbol.endLine) || symbol.endLine < symbol.startLine ||
        (symbol.docstring !== undefined && typeof symbol.docstring !== "string")) {
        return false;
      }
    }
  }

  if (value.receipts !== undefined) {
    const receipts = value.receipts;
    if (!isRecord(receipts) || !isStringRecord(receipts.dependencies) || !isStringRecord(receipts.devDependencies)) {
      return false;
    }
    for (const key of ["packageManager", "testCommand", "buildCommand", "lintCommand", "commandCwd", "packagePath"]) {
      if (receipts[key] !== undefined && typeof receipts[key] !== "string") {
        return false;
      }
    }
  }
  return true;
}

export class FactsStore {
  private readonly storageDir: string;
  private readonly filePath: string;
  private loadState: FactsCacheLoadState = "unread";

  constructor(workspaceRoot: string, customDirName: string = ".pi") {
    this.storageDir = join(workspaceRoot, customDirName);
    this.filePath = join(this.storageDir, "facts.json");
  }

  /** Hold across scan, extraction and publication, including across Node processes. */
  async withWriterLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    await mkdir(this.storageDir, { recursive: true });
    const lockPath = join(this.storageDir, "facts.lock");
    const deadline = performance.now() + 15_000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (performance.now() >= deadline) throw new FactsBusyError();
        await delay(25, undefined, { signal });
      }
    }
    try {
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async load(signal?: AbortSignal): Promise<FactsDatabase | null> {
    try {
      const content = await readFactsFile(this.filePath, MAX_CACHE_BYTES, signal);
      const parsed: unknown = JSON.parse(content.toString("utf8"));
      if (isDatabase(parsed)) {
        this.loadState = "hit";
        return parsed;
      }
      this.loadState = isRecord(parsed) && parsed.version !== FACTS_DATABASE_VERSION ? "incompatible" : "invalid";
      return null;
    } catch (error) {
      signal?.throwIfAborted();
      this.loadState = error instanceof FactsLimitError
        ? "oversized"
        : error instanceof SyntaxError
          ? "invalid"
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unreadable";
      return null;
    }
  }

  getLoadState(): FactsCacheLoadState {
    return this.loadState;
  }

  async save(database: FactsDatabase, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await mkdir(this.storageDir, { recursive: true });

    const tmpFile = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      const handle = await open(tmpFile, "wx");
      try {
        let bytes = 0;
        const append = async (text: string) => {
          signal?.throwIfAborted();
          bytes += Buffer.byteLength(text);
          if (bytes > MAX_CACHE_BYTES) {
            throw new FactsLimitError(`Facts cache byte limit (${MAX_CACHE_BYTES}) exceeded`);
          }
          await handle.writeFile(text, "utf8");
        };
        const { files, ...metadata } = database;
        await append(`${JSON.stringify(metadata).slice(0, -1)},"files":{`);
        let separator = "";
        for (const [path, facts] of Object.entries(files)) {
          await append(`${separator}${JSON.stringify(path)}:${JSON.stringify(facts)}`);
          separator = ",";
        }
        await append("}}");
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      await rename(tmpFile, this.filePath);
    } finally {
      await rm(tmpFile, { force: true });
    }
  }
}
