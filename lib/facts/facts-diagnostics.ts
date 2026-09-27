export type FactsPhase = "cache_lock" | "git_scan" | "cache_load" | "source_index" | "manifest" | "cache_save";

export interface FactsDiagnostics {
  status: "idle" | "refreshing" | "ready" | "unavailable";
  lastSuccessfulSyncAt?: number;
  lastDurationMs?: number;
  diskCacheLoad?: FactsCacheLoadState;
  failure?: { code: string; message: string };
}

const PHASE_HINTS: Record<FactsPhase, string> = {
  cache_lock: "Check access to the .pi directory and whether another Facts writer holds facts.lock.",
  git_scan: "Check Git availability and access to this workspace.",
  cache_load: "Check access to .pi/facts.json.",
  source_index: "Check that indexed source files exist and are readable.",
  manifest: "Check package.json syntax, fields, size, and access permissions.",
  cache_save: "Check available disk space and write access to .pi/facts.json.",
};

export function describeFactsFailure(error: unknown, phase: FactsPhase): { code: string; message: string } {
  if (error instanceof Error) {
    if (error.name === "AbortError") return { code: "cancelled", message: "Refresh cancelled; retry when needed." };
    if (error.name === "FactsLimitError") return { code: "limit", message: error.message };
    if (error.name === "FactsBusyError") return { code: "busy", message: error.message };
    if (error.name === "NotAGitRepositoryError") {
      const cause = error.cause as NodeJS.ErrnoException | undefined;
      if (cause?.code === "ENOENT") return { code: "git_unavailable", message: "Git or the working directory is unavailable." };
      return { code: "not_git", message: "Open a directory inside an accessible Git repository." };
    }
  }
  return { code: phase, message: PHASE_HINTS[phase] };
}
import type { FactsCacheLoadState } from "./facts-store.ts";
