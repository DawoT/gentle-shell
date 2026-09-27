import { createHash } from "node:crypto";
import { mkdir, open, readdir, stat, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FactsStore, isFactsDatabase } from "./facts-store.ts";
import { MAX_CACHE_BYTES, readFactsFile } from "./facts-limits.ts";
import type { FactsDatabase } from "./facts-types.ts";
import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export interface FactsHistoryReceipt {
  version: 1;
  digest: string;
  root: string;
  observedAt: number;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Snapshot paths are derived locally; transcript entries never supply a pathname. */
export class FactsHistory {
  private readonly directory: string;
  private readonly lock: FactsStore;

  constructor(sessionFile: string) {
    this.directory = join(dirname(sessionFile), "facts-snapshots");
    this.lock = new FactsStore(dirname(sessionFile), "facts-snapshots");
  }

  async save(database: FactsDatabase, edges: FactsModuleEdge[], signal?: AbortSignal): Promise<FactsHistoryReceipt> {
    return this.lock.withWriterLock(() => this.publish(database, edges, signal), signal);
  }

  private async publish(database: FactsDatabase, edges: FactsModuleEdge[], signal?: AbortSignal): Promise<FactsHistoryReceipt> {
    signal?.throwIfAborted();
    const text = JSON.stringify(canonical({ version: 1, database, edges }));
    if (Buffer.byteLength(text) > MAX_CACHE_BYTES) throw new Error("Facts history snapshot byte limit exceeded");
    const hash = digest(text);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${hash}.json`);
    try {
      const existing = await readFactsFile(path, MAX_CACHE_BYTES, signal);
      if (digest(existing.toString("utf8")) !== hash) throw new Error("Facts history digest mismatch");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      let bytes = 0;
      const entries = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
      if (entries.length >= 128) throw new Error("Facts history snapshot count limit reached");
      for (const name of entries) bytes += (await stat(join(this.directory, name))).size;
      if (bytes + Buffer.byteLength(text) > 256 * 1024 * 1024) throw new Error("Facts history retention byte limit reached");
      signal?.throwIfAborted();
      const temporary = join(this.directory, `${hash}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(text, { encoding: "utf8", signal });
        } finally {
          await handle.close();
        }
        signal?.throwIfAborted();
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { version: 1, digest: hash, root: database.root, observedAt: database.updatedAt };
  }

  async load(receipt: FactsHistoryReceipt, root: string, signal?: AbortSignal): Promise<{ database: FactsDatabase; edges: FactsModuleEdge[] }> {
    if (receipt?.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error("Invalid Facts history receipt");
    if (receipt.root !== root) throw new Error("Facts history root mismatch");
    const text = (await readFactsFile(join(this.directory, `${receipt.digest}.json`), MAX_CACHE_BYTES, signal)).toString("utf8");
    if (digest(text) !== receipt.digest) throw new Error("Facts history digest mismatch");
    const snapshot = JSON.parse(text);
    if (snapshot.version !== 1 || !isFactsDatabase(snapshot.database) || snapshot.database.root !== root ||
      snapshot.database.updatedAt !== receipt.observedAt || !Array.isArray(snapshot.edges) ||
      !snapshot.edges.every((edge: FactsModuleEdge) => edge && typeof edge.importer === "string" && typeof edge.specifier === "string" &&
        ["typescript", "unresolved"].includes(edge.evidence) && (edge.target === undefined || typeof edge.target === "string"))) {
      throw new Error("Invalid Facts history snapshot");
    }
    return snapshot;
  }
}
