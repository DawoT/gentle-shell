import { watch, type FSWatcher } from "node:fs";

export type WorkspaceDirtyReason = "fs" | "watcher-unavailable" | "manual" | "mid-flight";

export interface WorkspaceEpochOptions {
  watch?: boolean;
}

// Process-local change detector for the Facts fast path: the epoch is clean
// only while no workspace change has been observed since the last successful
// full sync. Writes inside the Facts cache directory and Git metadata are not
// workspace changes. The watcher is best-effort: once it fails, the epoch
// refuses to ever become clean again (external edits would go unobserved),
// so every auto sync takes the conservative full path. An explicitly
// watchless epoch (watch: false) keeps the fast path under the pointer and
// reconcile guards instead. The revision increments on every observed change
// AND on every clean transition, so an in-flight refresh can only be joined
// by callers that observed exactly the flight's starting state — a settled
// flight is never joinable.
export class WorkspaceEpoch {
  private dirty = true;
  private closed = false;
  private watcherFailed = false;
  private watcher: FSWatcher | null = null;
  private readonly reasons = new Set<WorkspaceDirtyReason>();
  private readonly root: string;
  private readonly options: WorkspaceEpochOptions;
  revision = 1;

  constructor(root: string, options: WorkspaceEpochOptions = {}) {
    this.root = root;
    this.options = options;
  }

  start(): void {
    if (this.closed || this.watcher || this.options.watch === false) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string") {
          const top = filename.split(/[\\/]/)[0];
          if (top === ".pi" || top === ".git") return;
        }
        this.markDirty("fs");
      });
      this.watcher.on("error", () => this.handleWatcherError());
    } catch {
      this.handleWatcherError();
    }
  }

  private handleWatcherError(): void {
    this.watcher?.close();
    this.watcher = null;
    this.watcherFailed = true;
    this.markDirty("watcher-unavailable");
  }

  markDirty(reason: WorkspaceDirtyReason): void {
    this.reasons.add(reason);
    this.revision++;
    this.dirty = true;
  }

  /** Clean only if no change was observed since the refresh's validation started. */
  markClean(expectedRevision?: number): void {
    if (this.watcherFailed) return;
    if (expectedRevision !== undefined && this.revision !== expectedRevision) return;
    this.dirty = false;
    this.revision++;
  }

  isClean(): boolean {
    return !this.dirty && !this.watcherFailed;
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
  }
}
