import { createHash } from "node:crypto";
import { FactsLimitError } from "./facts-limits.ts";

export interface FactsTreeEntry {
  path: string;
  mode: string;
  oid: string;
}

/** Derive paths exclusively from the same tree bytes whose identities are verified. */
export async function readVerifiedTreeEntries(treeId: string, readBatch: (ids: string[]) => Promise<Buffer>, signal?: AbortSignal): Promise<FactsTreeEntry[]> {
  const trees = new Map<string, Buffer>();
  let metadataBytes = 0;
  let pathBytes = 0;
  let entries = 0;
  const leaves: FactsTreeEntry[] = [];
  let frontier = [{ id: treeId, prefix: "", depth: 0 }];
  const oidBytes = treeId.length / 2;
  while (frontier.length) {
    signal?.throwIfAborted();
    const missing = [...new Set(frontier.map((item) => item.id))].filter((id) => !trees.has(id));
    if (missing.length) {
      const batch = await readBatch(missing);
      let offset = 0;
      for (const id of missing) {
        signal?.throwIfAborted();
        const newline = batch.indexOf(10, offset);
        if (newline < 0 || newline - offset > 100) throw new Error("Invalid Git tree batch header");
        const header = batch.subarray(offset, newline).toString("ascii").split(" ");
        const size = Number(header[2]);
        if (header.length !== 3 || header[0] !== id || header[1] !== "tree" || !Number.isSafeInteger(size) || size < 0) {
          throw new Error("Invalid Git tree batch object");
        }
        metadataBytes += size;
        if (metadataBytes > 16 * 1024 * 1024) throw new FactsLimitError("Facts tree metadata byte limit exceeded");
        const end = newline + 1 + size;
        if (end >= batch.length || batch[end] !== 10) throw new Error("Truncated Git tree object");
        const raw = batch.subarray(newline + 1, end);
        const hash = createHash(id.length === 64 ? "sha256" : "sha1").update(`tree ${size}\0`).update(raw).digest("hex");
        if (hash !== id) throw new Error("Git tree checksum mismatch");
        // Copy to avoid retaining an entire batch through a tiny subtree view.
        trees.set(id, Buffer.from(raw));
        offset = end + 1;
      }
      if (offset !== batch.length) throw new Error("Unexpected Git tree batch output");
    }
    const next: typeof frontier = [];
    for (const item of frontier) {
      const raw = trees.get(item.id)!;
      const names = new Set<string>();
      let offset = 0;
      while (offset < raw.length) {
        signal?.throwIfAborted();
        if (++entries > 100_000) throw new FactsLimitError("Facts tree entry limit exceeded");
        const space = raw.indexOf(32, offset);
        const nul = raw.indexOf(0, space + 1);
        if (space < offset || space - offset > 6 || nul <= space + 1 || nul + 1 + oidBytes > raw.length) throw new Error("Invalid raw Git tree entry");
        const mode = raw.subarray(offset, space).toString("ascii");
        const name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw.subarray(space + 1, nul));
        if (name === "." || name === ".." || name.includes("/") || names.has(name)) throw new Error("Invalid Git tree filename");
        names.add(name);
        const path = item.prefix + name;
        pathBytes += Buffer.byteLength(path);
        if (pathBytes > 16 * 1024 * 1024 || Buffer.byteLength(path) > 4096) throw new FactsLimitError("Facts tree path byte limit exceeded");
        const oid = raw.subarray(nul + 1, nul + 1 + oidBytes).toString("hex");
        offset = nul + 1 + oidBytes;
        if (mode === "40000" || mode === "040000") {
          if (item.depth >= 128) throw new FactsLimitError("Facts tree depth limit exceeded");
          next.push({ id: oid, prefix: `${path}/`, depth: item.depth + 1 });
        } else {
          if (!["100644", "100755", "120000", "160000"].includes(mode)) throw new Error("Invalid Git tree mode");
          leaves.push({ path, mode, oid });
        }
      }
    }
    frontier = next;
  }
  return leaves;
}
