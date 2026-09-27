import { extname } from "node:path";
import type { FileFacts } from "./facts-types.ts";

export type FactsLanguage = "typescript" | "python" | "go";

export function factsLanguage(path: string): FactsLanguage | undefined {
  const extension = extname(path);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(extension)) return "typescript";
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  return undefined;
}

async function extract(path: string, source: string, sha: string, signal?: AbortSignal): Promise<FileFacts> {
  signal?.throwIfAborted();
  const language = factsLanguage(path);
  let facts: FileFacts;
  if (language === "typescript") {
    const { extractTypeScriptInWorker } = await import("./facts-worker.ts");
    signal?.throwIfAborted();
    facts = await extractTypeScriptInWorker(path, source, sha, signal);
  } else if (language === "python") {
    const { extractPythonFacts } = await import("./facts-python-extractor.ts");
    facts = await extractPythonFacts(path, source, sha, signal);
  } else if (language === "go") {
    const { extractGoFacts } = await import("./facts-go-extractor.ts");
    facts = await extractGoFacts(path, source, sha, signal);
  } else {
    throw new Error(`Unsupported Facts source: ${path}`);
  }
  return { ...facts, language };
}

export async function extractSourceFacts(path: string, source: string, sha: string, signal?: AbortSignal): Promise<FileFacts> {
  try {
    return await extract(path, source, sha, signal);
  } catch (cause) {
    signal?.throwIfAborted();
    const language = factsLanguage(path);
    if (!language) throw cause;
    const error = new Error(`Facts ${language} parser failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    error.name = "FactsParserError";
    throw error;
  }
}
