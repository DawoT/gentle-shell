import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_OBSERVATION_MAX_BYTES = 65_536;

export interface RuntimeCoverageObservation {
  kind: "v8-coverage";
  files: string[];
  truncated?: true;
}

function repoRelativeFile(scriptUrl: string, repoRoot: string): string | null {
  if (!scriptUrl.startsWith("file://")) return null;
  let filePath: string;
  try {
    const url = new URL(scriptUrl);
    url.search = "";
    url.hash = "";
    filePath = fileURLToPath(url);
  } catch {
    return null;
  }

  const root = resolve(repoRoot);
  const path = resolve(filePath);
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  const normalized = rel.split(sep).join("/");
  if (normalized.split("/").includes("node_modules")) return null;
  if (normalized === "scripts/run-test-suite.mjs") return null;
  return normalized;
}

function boundObservation(files: string[], maxBytes: number): RuntimeCoverageObservation {
  const complete: RuntimeCoverageObservation = { kind: "v8-coverage", files };
  if (Buffer.byteLength(JSON.stringify(complete), "utf8") <= maxBytes) return complete;

  const bounded: string[] = [];
  for (const file of files) {
    const candidate: RuntimeCoverageObservation = { kind: "v8-coverage", files: [...bounded, file], truncated: true };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxBytes) break;
    bounded.push(file);
  }
  return { kind: "v8-coverage", files: bounded, truncated: true };
}

/** Parse NODE_V8_COVERAGE output into deterministic repo-relative stage edges. */
export async function collectCoverageObservation(
  coverageDir: string,
  repoRoot: string,
  maxBytes = RUNTIME_OBSERVATION_MAX_BYTES,
): Promise<RuntimeCoverageObservation> {
  const files = new Set<string>();
  let entries: string[] = [];
  try {
    entries = await readdir(coverageDir);
  } catch {
    return { kind: "v8-coverage", files: [] };
  }

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    try {
      const payload = JSON.parse(await readFile(resolve(coverageDir, entry), "utf8")) as {
        result?: Array<{ url?: unknown }>;
      };
      for (const script of payload.result ?? []) {
        if (typeof script.url !== "string") continue;
        const normalized = repoRelativeFile(script.url, repoRoot);
        if (normalized) files.add(normalized);
      }
    } catch {
      // Coverage is observational evidence; malformed individual V8 shards are ignored.
    }
  }

  return boundObservation([...files].sort(), maxBytes);
}
