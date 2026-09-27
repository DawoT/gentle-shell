import { parentPort } from "node:worker_threads";
import { resolveFactsModules, resolveFactsModuleSnapshot, validateFactsModuleSnapshot } from "./facts/facts-module-resolver.ts";
import type { FactsModuleSnapshot } from "./facts/facts-module-resolver.ts";
import type { FileFacts } from "./facts/facts-types.ts";
import { extractTypeScriptFacts } from "./facts/facts-ts-extractor.ts";

parentPort!.on("message", (request: { operation: "parse"; path: string; source: string; sha: string } | { operation: "resolve" | "resolveSnapshot"; root: string; files: Record<string, FileFacts>; confined?: boolean } | { operation: "validateSnapshot"; snapshot: FactsModuleSnapshot }) => {
  try {
    const facts = request.operation === "parse"
      ? extractTypeScriptFacts(request.path, request.source, request.sha)
      : request.operation === "validateSnapshot"
        ? { valid: validateFactsModuleSnapshot(request.snapshot) }
        : request.operation === "resolveSnapshot"
          ? resolveFactsModuleSnapshot(request.root, request.files, { confined: request.confined })
          : resolveFactsModules(request.root, request.files, { confined: request.confined });
    if (Buffer.byteLength(JSON.stringify(facts)) > 8 * 1024 * 1024) {
      throw new Error("Facts parser output byte limit exceeded");
    }
    parentPort!.postMessage({ facts });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
