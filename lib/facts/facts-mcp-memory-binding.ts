import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { ProjectMemory } from "../codex-web/project-memory.ts";

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
type BranchSnapshot = { sessionId: string; branch: ReadonlySet<string>; fingerprint: string };

function fingerprint(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

/** Operator-selected, immutable branch authority for one standalone MCP process. */
export class FactsMcpMemoryBinding {
  readonly workspaceRoot: string;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly leafId: string;
  private cached?: BranchSnapshot;

  private constructor(
    workspaceRoot: string,
    sessionFile: string,
    sessionId: string,
    leafId: string,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.sessionFile = sessionFile;
    this.sessionId = sessionId;
    this.leafId = leafId;
  }

  static async open(workspaceRoot: string, sessionFile: string, leafId: string): Promise<FactsMcpMemoryBinding> {
    if (!leafId || leafId.length > 1024) throw new Error("Memory binding requires a valid selected leaf ID");
    const workspace = await realpath(workspaceRoot);
    const binding = new FactsMcpMemoryBinding(workspace, sessionFile, "", leafId);
    const snapshot = await binding.snapshot();
    const bound = new FactsMcpMemoryBinding(workspace, sessionFile, snapshot.sessionId, leafId);
    bound.cached = snapshot;
    return bound;
  }

  private async snapshot(signal?: AbortSignal): Promise<BranchSnapshot> {
    signal?.throwIfAborted();
    if (this.cached) {
      const current = await lstat(this.sessionFile);
      if (!current.isFile() || current.size > MAX_TRANSCRIPT_BYTES) throw new Error("Bound Pi transcript is invalid or oversized");
      if (fingerprint(current) === this.cached.fingerprint) return this.cached;
    }
    const handle = await open(this.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text: string;
    let fileFingerprint: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) throw new Error("Bound Pi transcript is invalid or oversized");
      text = await handle.readFile({ encoding: "utf8", signal });
      const after = await handle.stat();
      if (Buffer.byteLength(text, "utf8") > MAX_TRANSCRIPT_BYTES || fingerprint(info) !== fingerprint(after)) {
        throw new Error("Bound Pi transcript changed while reading or exceeded its limit");
      }
      fileFingerprint = fingerprint(after);
    } finally {
      await handle.close();
    }
    if (!text.endsWith("\n")) throw new Error("Bound Pi transcript has an incomplete tail");
    const lines = text.trimEnd().split("\n");
    if (lines.length < 2 || lines.length > MAX_ENTRIES + 1) throw new Error("Bound Pi transcript entry count is invalid");
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string" || !header.id || header.id.length > 1024
      || typeof header.cwd !== "string" || await realpath(header.cwd) !== this.workspaceRoot) {
      throw new Error("Bound Pi transcript does not belong to this workspace");
    }
    if (this.sessionId && header.id !== this.sessionId) throw new Error("Bound Pi session identity changed");
    const parents = new Map<string, string | null>();
    for (const line of lines.slice(1)) {
      signal?.throwIfAborted();
      const entry = JSON.parse(line) as Record<string, unknown>;
      const parentId = entry.parentId;
      if (typeof entry.id !== "string" || !entry.id || entry.id.length > 1024 || parents.has(entry.id)) {
        throw new Error("Bound Pi transcript contains an invalid or duplicate entry");
      }
      if (parentId !== null && typeof parentId !== "string") {
        throw new Error("Bound Pi transcript contains an invalid parent entry");
      }
      parents.set(entry.id, parentId as string | null);
    }
    const branch = new Set<string>();
    let current: string | null = this.leafId;
    while (current !== null) {
      if (branch.has(current) || !parents.has(current)) throw new Error("Selected Pi branch is invalid or unavailable");
      branch.add(current);
      current = parents.get(current)!;
    }
    const snapshot = { sessionId: header.id, branch, fingerprint: fileFingerprint };
    this.cached = snapshot;
    return snapshot;
  }

  async memory(signal?: AbortSignal): Promise<{ store: ProjectMemory; branch: ReadonlySet<string> }> {
    const snapshot = await this.snapshot(signal);
    return {
      store: await ProjectMemory.open(this.workspaceRoot, snapshot.sessionId),
      branch: snapshot.branch,
    };
  }
}
