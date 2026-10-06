import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { withFactsWriterLock } from "./facts-lock.ts";
export { FactsBusyError } from "./facts-lock.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";
import { FactsLimitError, MAX_CACHE_BYTES, readFactsFile } from "./facts-limits.ts";

export { isFactsDatabase } from "./facts-schema.ts";
import { isFactsDatabase } from "./facts-schema.ts";
import { FactsGenerations, FactsIntegrityError } from "./facts-generations.ts";

export type FactsCacheLoadState = "unread" | "missing" | "hit" | "incompatible" | "invalid" | "oversized" | "unreadable";

export class FactsStore {
  private readonly storageDir: string;
  private readonly filePath: string;
  private readonly generations: FactsGenerations;
  private loadState: FactsCacheLoadState = "unread";
  private generation?: string;
  private readonly lockScope = new AsyncLocalStorage<{ active: boolean }>();

  constructor(workspaceRoot: string, customDirName: string = ".pi") {
    this.storageDir = join(workspaceRoot, customDirName);
    this.filePath = join(this.storageDir, "facts.json");
    this.generations = new FactsGenerations(this.storageDir);
  }

  /** Hold across scan, extraction and publication, including across Node processes. */
  async withWriterLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.lockScope.getStore()?.active) {
      signal?.throwIfAborted();
      return operation();
    }
    return withFactsWriterLock(this.storageDir, () => {
      const scope = { active: true };
      return this.lockScope.run(scope, async () => {
        try {
          return await operation();
        } finally {
          scope.active = false;
        }
      });
    }, signal);
  }

  async load(signal?: AbortSignal): Promise<FactsDatabase | null> {
    return this.withWriterLock(() => this.loadLocked(signal), signal);
  }

  private async loadLocked(signal?: AbortSignal): Promise<FactsDatabase | null> {
    this.generation = undefined;
    try {
      const content = await readFactsFile(this.filePath, MAX_CACHE_BYTES, signal);
      let parsed: unknown = JSON.parse(content.toString("utf8"));
      let generation: string | undefined;
      if (parsed && typeof parsed === "object" && "format" in parsed) {
        if ("generation" in parsed && typeof parsed.generation === "string") generation = parsed.generation;
        parsed = await this.generations.loadPointer(parsed, signal);
      }
      if (isFactsDatabase(parsed)) {
        this.loadState = "hit";
        this.generation = generation;
        return parsed;
      }
      this.loadState = parsed && typeof parsed === "object" && "version" in parsed && parsed.version !== FACTS_DATABASE_VERSION ? "incompatible" : "invalid";
      return null;
    } catch (error) {
      signal?.throwIfAborted();
      this.loadState = error instanceof FactsLimitError
        ? "oversized"
        : error instanceof SyntaxError || error instanceof FactsIntegrityError
          ? "invalid"
          : (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "unreadable";
      return null;
    }
  }

  getLoadState(): FactsCacheLoadState {
    return this.loadState;
  }

  getGeneration(): string | undefined {
    return this.generation;
  }

  async loadGeneration(generation: string, signal?: AbortSignal): Promise<FactsDatabase> {
    return this.withWriterLock(() => this.generations.load(generation, signal), signal);
  }

  async save(database: FactsDatabase, signal?: AbortSignal): Promise<void> {
    await this.withWriterLock(async () => {
      this.generation = await this.generations.publish(database, signal);
    }, signal);
  }
}
