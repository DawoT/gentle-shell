import { encodeFacts as encode } from "./facts-codec.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { FactsLimitError, FactsReadBudget, MAX_CACHE_BYTES, MAX_INDEX_FILES, readFactsFile } from "./facts-limits.ts";
import { mapFactsIO } from "./facts-io.ts";
import { isFactsDatabase } from "./facts-schema.ts";
import type { FactsDatabase, FileFacts } from "./facts-types.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const CHECKPOINT_INTERVAL = 32;
const MAX_GENERATIONS = 4096;
const MAX_ARTIFACTS = 65536;
const MAX_STORAGE_BYTES = 256 * 1024 * 1024;

type Metadata = Omit<FactsDatabase, "files">;
interface Manifest {
  format: "facts-generation-v1";
  metadata: Metadata;
  parent?: string;
  depth: number;
  upserts: Record<string, string>;
  deleted: string[];
}
interface Inventory {
  metadata: Metadata;
  refs: Map<string, string>;
  depth: number;
  bytes: number;
}

export class FactsIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FactsIntegrityError";
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

function manifest(value: any): value is Manifest {
  return value?.format === "facts-generation-v1" && Number.isInteger(value.depth) &&
    value.depth >= 0 && value.depth < CHECKPOINT_INTERVAL &&
    (value.depth === 0 ? value.parent === undefined : validDigest(value.parent)) &&
    value.upserts !== null && typeof value.upserts === "object" && !Array.isArray(value.upserts) &&
    Object.values(value.upserts).every(validDigest) &&
    Array.isArray(value.deleted) && value.deleted.every((path: unknown) => typeof path === "string") &&
    isFactsDatabase({ ...value.metadata, files: {} });
}

/** Immutable objects/manifests are published before the replaceable pointer. */
export class FactsGenerations {
  private readonly storage: string;
  private readonly pointer: string;

  constructor(directory: string) {
    this.storage = join(directory, "facts-data");
    this.pointer = join(directory, "facts.json");
  }

  async loadPointer(value: any, signal?: AbortSignal): Promise<FactsDatabase> {
    if (value?.format !== "facts-pointer-v1" || !validDigest(value.generation)) {
      throw new FactsIntegrityError("Invalid Facts generation pointer");
    }
    return this.load(value.generation, signal);
  }

  private async read(kind: "objects" | "generations", id: string, signal?: AbortSignal, budget?: FactsReadBudget): Promise<{ value: any; bytes: number }> {
    if (!validDigest(id)) throw new FactsIntegrityError("Invalid Facts generation or object identifier");
    try {
      const bytes = await readFactsFile(join(this.storage, kind, `${id}.json`), MAX_CACHE_BYTES, signal, budget);
      const text = bytes.toString("utf8");
      if (digest(text) !== id) throw new FactsIntegrityError("Facts immutable artifact checksum mismatch");
      return { value: JSON.parse(text), bytes: bytes.length };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof FactsLimitError || error instanceof FactsIntegrityError) throw error;
      throw new FactsIntegrityError("Facts generation artifact is missing or invalid", { cause: error });
    }
  }

  private async inventory(id: string, signal?: AbortSignal): Promise<Inventory> {
    if (!validDigest(id)) throw new FactsIntegrityError("Invalid Facts generation identifier");
    const chain: Manifest[] = [];
    let bytes = 0;
    let next: string | undefined = id;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next) || chain.length >= CHECKPOINT_INTERVAL) throw new FactsIntegrityError("Invalid Facts generation chain");
      seen.add(next);
      const read = await this.read("generations", next, signal);
      bytes += read.bytes;
      if (bytes > MAX_CACHE_BYTES) throw new FactsLimitError("Facts cache byte limit exceeded by generation chain");
      if (!manifest(read.value)) throw new FactsIntegrityError("Invalid Facts generation manifest");
      if (chain.length && chain[chain.length - 1].depth !== read.value.depth + 1) {
        throw new FactsIntegrityError("Invalid Facts generation depth");
      }
      chain.push(read.value);
      next = read.value.parent;
    }
    const refs = new Map<string, string>();
    for (const item of [...chain].reverse()) {
      for (const path of item.deleted) refs.delete(path);
      for (const [path, hash] of Object.entries(item.upserts)) refs.set(path, hash);
      if (refs.size > MAX_INDEX_FILES) throw new FactsLimitError("Facts generation file limit exceeded");
    }
    return { metadata: chain[0].metadata, refs, depth: chain[0].depth, bytes };
  }

  async load(id: string, signal?: AbortSignal): Promise<FactsDatabase> {
    const inventory = await this.inventory(id, signal);
    const budget = new FactsReadBudget(MAX_CACHE_BYTES);
    budget.consume(Buffer.byteLength(encode(inventory.metadata)));
    const entries = await mapFactsIO([...inventory.refs], async ([path, hash], activeSignal) => {
      budget.consume(Buffer.byteLength(JSON.stringify(path)) + 2);
      const read = await this.read("objects", hash, activeSignal, budget);
      return [path, read.value as FileFacts] as const;
    }, signal);
    const files = Object.fromEntries(entries);
    const database = { ...inventory.metadata, files };
    if (!isFactsDatabase(database)) throw new FactsIntegrityError("Invalid Facts generation database");
    // Return ordinary records, including own __proto__ keys, as legacy loads did.
    return { ...database, files: Object.fromEntries(Object.entries(files)) };
  }

  private async write(path: string, text: string, signal?: AbortSignal): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
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

  private async usage(signal?: AbortSignal): Promise<{ bytes: number; count: number; generations: number }> {
    const usage = { bytes: 0, count: 0, generations: 0 };
    const paths: string[] = [];
    for (const kind of ["objects", "generations"]) {
      for await (const entry of await opendir(join(this.storage, kind))) {
        signal?.throwIfAborted();
        usage.count++;
        if (usage.count > MAX_ARTIFACTS) throw new FactsLimitError("Facts generation artifact limit reached; clear the disposable Facts cache");
        if (!entry.isFile()) throw new FactsIntegrityError("Unexpected Facts storage entry");
        paths.push(join(this.storage, kind, entry.name));
        if (kind === "generations") usage.generations++;
      }
    }
    await mapFactsIO(paths, async (path, activeSignal) => {
      activeSignal.throwIfAborted();
      const metadata = await stat(path);
      usage.bytes += metadata.size;
    }, signal);
    return usage;
  }

  /** Caller must hold the cache lock, shared by readers and writers. Artifacts younger than 24 hours are retained. */
  async collect(signal?: AbortSignal): Promise<{ removed: number; bytes: number }> {
    signal?.throwIfAborted();
    const pointer = JSON.parse((await readFactsFile(this.pointer, MAX_CACHE_BYTES, signal)).toString("utf8"));
    if (pointer.format !== "facts-pointer-v1" || !validDigest(pointer.generation)) {
      throw new FactsIntegrityError("Cannot collect without a valid generation pointer");
    }
    const entries: Array<{ kind: "objects" | "generations"; name: string; mtime: number; size: number }> = [];
    for (const kind of ["objects", "generations"] as const) {
      for await (const entry of await opendir(join(this.storage, kind))) {
        signal?.throwIfAborted();
        if (entries.length >= MAX_ARTIFACTS) throw new FactsLimitError("Facts collection artifact limit exceeded");
        if (!entry.isFile()) throw new FactsIntegrityError("Unexpected Facts storage entry during collection");
        const info = await stat(join(this.storage, kind, entry.name));
        entries.push({ kind, name: entry.name, mtime: info.mtimeMs, size: info.size });
      }
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const generations = entries.filter((entry) => entry.kind === "generations" && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
    const roots = new Set([pointer.generation as string]);
    for (const [index, entry] of generations.entries()) {
      if (index < 32 || entry.mtime >= cutoff) roots.add(entry.name.slice(0, -5));
    }
    const retained = new Map<string, Manifest>();
    const objects = new Set<string>();
    let bytesRead = 0;
    const mark = async (id: string, expectedDepth?: number): Promise<Manifest> => {
      const cached = retained.get(id);
      if (cached) {
        if (expectedDepth !== undefined && cached.depth !== expectedDepth) throw new FactsIntegrityError("Invalid retained Facts chain");
        return cached;
      }
      if (retained.size >= MAX_GENERATIONS) throw new FactsLimitError("Facts collection generation limit exceeded");
      const read = await this.read("generations", id, signal);
      bytesRead += read.bytes;
      if (bytesRead > MAX_STORAGE_BYTES) throw new FactsLimitError("Facts collection metadata byte limit exceeded");
      if (!manifest(read.value)) throw new FactsIntegrityError("Invalid retained Facts manifest");
      const value = read.value;
      if (expectedDepth !== undefined && value.depth !== expectedDepth) throw new FactsIntegrityError("Invalid retained Facts chain");
      // Depth must strictly decrease, preventing cyclic references before recursion.
      if (value.parent) {
        const parent = await mark(value.parent, value.depth - 1);
        if (parent.depth + 1 !== value.depth) throw new FactsIntegrityError("Invalid retained Facts chain");
      }
      retained.set(id, value);
      for (const hash of Object.values(value.upserts)) objects.add(hash);
      return value;
    };
    for (const root of roots) await mark(root);
    const result = { removed: 0, bytes: 0 };
    // No deletion happens until every retained root has been marked successfully.
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.mtime >= cutoff) continue;
      const id = entry.name.slice(0, -5);
      const immutable = /^[a-f0-9]{64}\.json$/.test(entry.name);
      const temporary = /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name);
      if (!immutable && !temporary) continue;
      if (immutable && (entry.kind === "objects" ? objects.has(id) : retained.has(id))) continue;
      await rm(join(this.storage, entry.kind, entry.name));
      result.removed++;
      result.bytes += entry.size;
    }
    return result;
  }

  async publish(database: FactsDatabase, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!isFactsDatabase(database)) throw new FactsIntegrityError("Invalid Facts database publication");
    if (Object.keys(database.files).length > MAX_INDEX_FILES) throw new FactsLimitError("Facts generation file limit exceeded");
    const { files, ...metadata } = database;
    let bytes = Buffer.byteLength(encode(metadata)) + 12;
    if (bytes > MAX_CACHE_BYTES) throw new FactsLimitError("Facts cache byte limit exceeded");
    const objects = new Map<string, string>();
    const refs = new Map<string, string>();
    for (const [path, facts] of Object.entries(files)) {
      signal?.throwIfAborted();
      const text = encode(facts);
      bytes += Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(path)) + 2;
      if (bytes > MAX_CACHE_BYTES) throw new FactsLimitError("Facts cache byte limit exceeded");
      const id = digest(text);
      objects.set(id, text);
      refs.set(path, id);
    }
    let parent: string | undefined;
    let previous: Inventory | undefined;
    try {
      const pointer = JSON.parse((await readFactsFile(this.pointer, MAX_CACHE_BYTES, signal)).toString("utf8"));
      if (pointer.format === "facts-pointer-v1" && validDigest(pointer.generation)) {
        parent = pointer.generation;
        previous = await this.inventory(parent, signal);
      }
    } catch (error) {
      signal?.throwIfAborted();
      // A corrupt disposable pointer may be replaced after a complete rebuild.
      if (!(error instanceof FactsIntegrityError) && !(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parent = undefined;
    }
    const unchanged = previous && previous.refs.size === refs.size && [...refs].every(([path, hash]) => previous!.refs.get(path) === hash) &&
      encode(previous.metadata) === encode(metadata);
    const checkpoint = !previous || previous.depth + 1 >= CHECKPOINT_INTERVAL;
    const upserts = Object.fromEntries([...refs].filter(([path, hash]) => checkpoint || previous!.refs.get(path) !== hash));
    const deleted = checkpoint ? [] : [...previous!.refs.keys()].filter((path) => !refs.has(path)).sort();
    const generation: Manifest = {
      format: "facts-generation-v1",
      metadata,
      depth: checkpoint ? 0 : previous!.depth + 1,
      ...(checkpoint ? {} : { parent }),
      upserts,
      deleted,
    };
    let manifestText = encode(generation);
    if (generation.parent && previous!.bytes + Buffer.byteLength(manifestText) > MAX_CACHE_BYTES) {
      delete generation.parent;
      generation.depth = 0;
      generation.upserts = Object.fromEntries(refs);
      generation.deleted = [];
      manifestText = encode(generation);
    }
    if (Buffer.byteLength(manifestText) > MAX_CACHE_BYTES) throw new FactsLimitError("Facts cache byte limit exceeded by manifest");
    const id = digest(manifestText);
    for (const kind of ["objects", "generations"]) await mkdir(join(this.storage, kind), { recursive: true, mode: 0o700 });
    let usage = await this.usage(signal);
    if (parent && (usage.bytes >= MAX_STORAGE_BYTES * 0.75 || usage.count >= MAX_ARTIFACTS * 0.75 || usage.generations >= MAX_GENERATIONS * 0.75)) {
      await this.collect(signal);
      usage = await this.usage(signal);
    }
    const publishArtifact = async (kind: "objects" | "generations", hash: string, text: string, activeSignal = signal) => {
      const path = join(this.storage, kind, `${hash}.json`);
      try {
        const existing = await readFactsFile(path, Buffer.byteLength(text), activeSignal);
        if (digest(existing.toString("utf8")) !== hash) throw new FactsIntegrityError("Facts immutable artifact checksum mismatch");
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      usage.bytes += Buffer.byteLength(text);
      usage.count++;
      if (kind === "generations") usage.generations++;
      if (usage.bytes > MAX_STORAGE_BYTES || usage.count > MAX_ARTIFACTS || usage.generations > MAX_GENERATIONS) {
        throw new FactsLimitError("Facts generation retention limit reached; clear the disposable Facts cache");
      }
      await this.write(path, text, activeSignal);
    };
    await mapFactsIO([...objects], ([hash, text], activeSignal) => publishArtifact("objects", hash, text, activeSignal), signal);
    if (unchanged) return parent!;
    await publishArtifact("generations", id, manifestText);
    await this.write(this.pointer, encode({ format: "facts-pointer-v1", generation: id }), signal);
    return id;
  }
}
