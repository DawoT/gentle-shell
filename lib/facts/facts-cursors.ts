import { randomUUID } from "node:crypto";
import { pageFacts } from "./facts-response.ts";

interface CursorOptions {
  ttlMs?: number;
  maxBytes?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Snapshot {
  query: string;
  generation: string;
  rows: string[];
  expiresAt: number;
  bytes: number;
}

interface PageOptions {
  limit?: number;
  offset?: number;
}

export class FactsCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsCursorError";
  }
}

/** Session-local immutable query results, bounded by TTL, count and UTF-8 bytes. */
export class FactsCursors {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private bytes = 0;

  constructor(options: CursorOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    this.maxEntries = options.maxEntries ?? 128;
    this.now = options.now ?? Date.now;
    for (const value of [this.ttlMs, this.maxBytes, this.maxEntries]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Cursor budgets must be positive integers");
    }
  }

  start(query: string, generation: string, rows: string[], options: PageOptions) {
    this.prune();
    const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row), 0);
    if (bytes > this.maxBytes) throw new FactsCursorError("Query exceeds cursor retention budget; narrow the query");
    const id = randomUUID();
    const snapshot = { query, generation, rows: [...rows], bytes, expiresAt: this.now() + this.ttlMs };
    // Validate pagination before admitting a snapshot to the retention pool.
    const page = this.page(id, snapshot, options);
    while (this.snapshots.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      this.remove(this.snapshots.keys().next().value!);
    }
    this.snapshots.set(id, snapshot);
    this.bytes += bytes;
    return page;
  }

  resume(cursor: string, query: string, options: Pick<PageOptions, "limit">) {
    this.prune();
    const separator = cursor.lastIndexOf(":");
    const id = cursor.slice(0, separator);
    const position = cursor.slice(separator + 1);
    const snapshot = this.snapshots.get(id);
    if (!snapshot || !/^\d+$/.test(position)) {
      throw new FactsCursorError("Cursor expired or unknown; restart the query");
    }
    if (snapshot.query !== query) throw new FactsCursorError("Cursor belongs to a different query");
    const offset = Number(position);
    if (!Number.isSafeInteger(offset) || offset >= snapshot.rows.length) {
      throw new FactsCursorError("Cursor position is invalid; restart the query");
    }
    return this.page(id, snapshot, { ...options, offset });
  }

  private page(id: string, snapshot: Snapshot, options: PageOptions) {
    const page = pageFacts(snapshot.rows, options, (row) => row);
    const next = page.details.nextOffset;
    const rows = next === null ? page.text : page.text.replace(/\n\nMore results: repeat with offset=\d+\.$/, "");
    return {
      text: next === null ? rows : `${rows}\n\nSnapshot ${snapshot.generation}. More results: repeat the same query with cursor="${id}:${next}"; omit offset.`,
      details: {
        ...page.details,
        generation: snapshot.generation,
        total: snapshot.rows.length,
        expiresAt: snapshot.expiresAt,
        nextCursor: next === null ? null : `${id}:${next}`,
      },
    };
  }

  private prune() {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.remove(id);
    }
  }

  private remove(id: string) {
    const snapshot = this.snapshots.get(id);
    if (snapshot) this.bytes -= snapshot.bytes;
    this.snapshots.delete(id);
  }
}
