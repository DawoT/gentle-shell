import { constants } from "node:fs";
import { opendir, open, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readProcessContext, type ProcessContext } from "./facts-lock.ts";

export type FactsLockClassification =
  | "valid-live"
  | "recoverable-dead"
  | "valid-unknown-liveness"
  | "corrupt-unknown"
  | "empty-dir"
  | "absent";

export interface FactsLockReport {
  storageDir: string;
  lockPath: string;
  classification: FactsLockClassification;
  detail?: string;
}

export interface FactsLockRecoveryResult {
  storageDir: string;
  lockPath: string;
  classification: FactsLockClassification;
  removed: boolean;
}

const OWNER_NAME = /^owner-[a-f0-9-]{36}\.json$/;

// Mirrors the exact recoverDeadOwner validation rules; classifies instead of
// silently refusing so operators can see why a lock is stuck.
async function classifyOwnerRecord(lockPath: string, entry: string, context: ProcessContext | undefined): Promise<FactsLockClassification> {
  if (!OWNER_NAME.test(entry)) return "corrupt-unknown";
  try {
    const handle = await open(join(lockPath, entry), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let owner: any;
    try {
      if (!(await handle.stat()).isFile()) return "corrupt-unknown";
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead > 4096) return "corrupt-unknown";
      owner = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return "corrupt-unknown";
    if (!context) return "valid-unknown-liveness";
    if (owner.context?.boot !== context.boot || owner.context?.host !== context.host ||
      owner.context?.namespace !== context.namespace) return "corrupt-unknown";
    try {
      process.kill(owner.pid, 0);
      return "valid-live";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return "recoverable-dead";
      // EPERM means the process exists but is not ours: treat as live.
      return "valid-live";
    }
  } catch {
    return "corrupt-unknown";
  }
}

export async function classifyFactsLockDir(storageDir: string, context?: ProcessContext): Promise<FactsLockReport> {
  const effectiveContext = arguments.length >= 2 ? context : await readProcessContext();
  const lockPath = join(storageDir, "facts.lock");
  try {
    if (!(await stat(lockPath)).isDirectory()) {
      return { storageDir, lockPath, classification: "corrupt-unknown", detail: "facts.lock is not a directory" };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { storageDir, lockPath, classification: "absent" };
    }
    throw error;
  }
  const entries: string[] = [];
  for await (const entry of await opendir(lockPath)) {
    entries.push(entry.name);
    if (entries.length > 1) {
      return { storageDir, lockPath, classification: "corrupt-unknown", detail: "multiple entries in facts.lock" };
    }
  }
  if (entries.length === 0) {
    return { storageDir, lockPath, classification: "empty-dir" };
  }
  const classification = await classifyOwnerRecord(lockPath, entries[0], effectiveContext);
  return { storageDir, lockPath, classification };
}

const RECOVERABLE: ReadonlySet<FactsLockClassification> = new Set(["recoverable-dead", "corrupt-unknown", "empty-dir"]);

export async function recoverFactsLockDir(storageDir: string, context?: ProcessContext): Promise<FactsLockRecoveryResult> {
  const report = await (arguments.length >= 2
    ? classifyFactsLockDir(storageDir, context)
    : classifyFactsLockDir(storageDir));
  const lockPath = report.lockPath;
  if (!RECOVERABLE.has(report.classification)) {
    return { storageDir, lockPath, classification: report.classification, removed: false };
  }
  if (report.classification !== "empty-dir") {
    // Same unlink-then-rmdir sequence as removeOwnedLock in facts-lock.ts.
    const entries: string[] = [];
    for await (const entry of await opendir(lockPath)) entries.push(entry.name);
    for (const entry of entries) {
      try {
        await unlink(join(lockPath, entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return { storageDir, lockPath, classification: report.classification, removed: false };
    }
    throw error;
  }
  return { storageDir, lockPath, classification: report.classification, removed: true };
}
