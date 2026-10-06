import { parentPort } from "node:worker_threads";
import { resolveFactsModules, resolveFactsModuleSnapshotIncremental, validateFactsModuleSnapshot, type FactsResolutionCache } from "./facts/facts-module-resolver.ts";
import type { FactsModuleSnapshot } from "./facts/facts-module-resolver.ts";
import type { FileFacts } from "./facts/facts-types.ts";
import { extractTypeScriptFacts } from "./facts/facts-ts-extractor.ts";

// The worker is long-lived per process, so per-root resolution caches survive
// across requests. A restarted worker simply starts with an empty cache and
// resolves fresh; bounded to a handful of roots to cap memory.
const MAX_RESOLUTION_CACHES = 8;
const resolutionCaches = new Map<string, FactsResolutionCache>();

function resolutionCacheFor(root: string, confined: boolean): FactsResolutionCache {
  const key = `${confined ? "confined" : "workspace"}\u0000${root}`;
  let cache = resolutionCaches.get(key);
  if (!cache) {
    if (resolutionCaches.size >= MAX_RESOLUTION_CACHES) resolutionCaches.clear();
    cache = new Map();
    resolutionCaches.set(key, cache);
  }
  return cache;
}

parentPort!.on("message", (request: { operation: "parse"; path: string; source: string; sha: string } | { operation: "resolve" | "resolveSnapshot"; root: string; files: Record<string, FileFacts>; confined?: boolean } | { operation: "validateSnapshot"; snapshot: FactsModuleSnapshot }) => {
  try {
    const facts = request.operation === "parse"
      ? extractTypeScriptFacts(request.path, request.source, request.sha)
      : request.operation === "validateSnapshot"
        ? { valid: validateFactsModuleSnapshot(request.snapshot) }
        : request.operation === "resolveSnapshot"
          ? resolveFactsModuleSnapshotIncremental(request.root, request.files, resolutionCacheFor(request.root, Boolean(request.confined)), { confined: request.confined })
          : resolveFactsModules(request.root, request.files, { confined: request.confined });
    if (Buffer.byteLength(JSON.stringify(facts)) > 8 * 1024 * 1024) {
      throw new Error("Facts parser output byte limit exceeded");
    }
    parentPort!.postMessage({ facts });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
