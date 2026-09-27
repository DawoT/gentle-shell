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

/** Read at most the budget plus one byte, including files that grow during reading. */
export async function readFactsFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error(`Facts requires a regular file: ${path}`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await file.read(chunk);
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
