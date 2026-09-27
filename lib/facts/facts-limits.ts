import { open } from "node:fs/promises";
import { constants } from "node:fs";

export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
export const MAX_INDEX_FILES = 10_000;
export const MAX_CACHE_BYTES = 64 * 1024 * 1024;

export class FactsLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FactsLimitError";
  }
}

/** Shared across parallel reads; accounting is synchronous between IO awaits. */
export class FactsReadBudget {
  private remaining: number;

  constructor(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid Facts read budget");
    this.remaining = bytes;
  }

  consume(bytes: number): void {
    this.remaining -= bytes;
    if (this.remaining < 0) throw new FactsLimitError("Facts aggregate cache byte limit exceeded");
  }
}

/** Read at most the budget plus one byte, including files that grow during reading. */
export async function readFactsFile(path: string, maxBytes: number, signal?: AbortSignal, budget?: FactsReadBudget): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error(`Facts requires a regular file: ${path}`);
    const chunkSize = Math.min(64 * 1024, Math.max(4096, metadata.size + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(chunkSize, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk);
      budget?.consume(bytesRead);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes) throw new FactsLimitError(`Facts byte limit (${maxBytes}) exceeded: ${path}`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    throw new FactsLimitError(`Facts byte limit (${maxBytes}) exceeded: ${path}`);
  } finally {
    await file.close();
  }
}
