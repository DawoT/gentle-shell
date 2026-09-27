import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MAX_SOURCE_BYTES } from "./facts-limits.ts";
import type { FileFacts } from "./facts-types.ts";

export async function extractPythonFacts(filePath: string, sourceText: string, sha: string, signal?: AbortSignal): Promise<FileFacts> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(sourceText) > MAX_SOURCE_BYTES) throw new Error("Python source byte limit exceeded");
  const helper = fileURLToPath(new URL("./parsers/python_facts.py", import.meta.url));
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile("python3", ["-I", helper], {
      signal,
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (error) {
        reject(new Error(`Python extraction failed: ${stderr.trim().slice(0, 1000) || error.message}`, { cause: error }));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ path: filePath, source: sourceText, sha }));
  });
  signal?.throwIfAborted();
  return JSON.parse(output) as FileFacts;
}
