import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, opendir, readFile, readlink, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ProcessContext {
  boot: string;
  host: string;
  namespace: string;
}

export class FactsBusyError extends Error {
  constructor() {
    super("Facts cache is locked by another writer. Retry; unknown or legacy lock owners require manual verification before recovery.");
    this.name = "FactsBusyError";
  }
}

// Exported read-only for the facts lock doctor; behavior unchanged.
export async function readProcessContext(): Promise<ProcessContext | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const namespace = await readlink("/proc/self/ns/pid");
    if (!/^[a-f0-9-]{36}$/.test(boot) || !/^pid:\[\d+\]$/.test(namespace)) return undefined;
    return { boot, namespace, host: hostname() };
  } catch {
    return undefined;
  }
}

async function removeOwnedLock(path: string, owner: string): Promise<boolean> {
  try {
    // Only the winner of this unique-name unlink may remove the directory.
    // Never remove an empty lock without first claiming its owner record.
    await unlink(join(path, owner));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    await rmdir(path);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

async function recoverDeadOwner(path: string, context: ProcessContext | undefined): Promise<boolean> {
  if (!context) return false;
  try {
    const entries: string[] = [];
    for await (const entry of await opendir(path)) {
      entries.push(entry.name);
      if (entries.length > 1) return false;
    }
    if (entries.length !== 1 || !/^owner-[a-f0-9-]{36}\.json$/.test(entries[0])) return false;
    const handle = await open(join(path, entries[0]), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    let owner;
    try {
      if (!(await handle.stat()).isFile()) return false;
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer);
      if (bytesRead > 4096) return false;
      owner = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
    if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      owner.context?.boot !== context.boot || owner.context?.host !== context.host ||
      owner.context?.namespace !== context.namespace) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
    return await removeOwnedLock(path, entries[0]);
  } catch {
    // Unknown identity, partial records, permissions and competing reapers
    // never justify stealing a lock. The caller keeps waiting or cancels.
    return false;
  }
}

export async function withFactsWriterLock<T>(storageDir: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await mkdir(storageDir, { recursive: true });
  const path = join(storageDir, "facts.lock");
  const context = await readProcessContext();
  const owner = `owner-${randomUUID()}.json`;
  const deadline = performance.now() + 15_000;
  while (true) {
    signal?.throwIfAborted();
    try {
      await mkdir(path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new FactsBusyError();
      if (await recoverDeadOwner(path, context)) continue;
      await delay(25, undefined, { signal });
    }
  }
  try {
    await writeFile(join(path, owner), JSON.stringify({ version: 1, pid: process.pid, context, startedAt: Date.now() }), { flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await removeOwnedLock(path, owner);
  }
}
