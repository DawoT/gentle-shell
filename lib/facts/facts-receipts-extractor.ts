import { existsSync } from "node:fs";
import { readFactsFile } from "./facts-limits.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecutionReceipts } from "./facts-types.ts";

const MAX_MANIFEST_BYTES = 1024 * 1024;

type Manifest = Record<string, unknown>;

function record(value: unknown): value is Manifest {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (!record(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error(`Invalid ${field}`);
  }
  return value as Record<string, string>;
}

async function readManifest(path: string, signal?: AbortSignal): Promise<Manifest | undefined> {
  signal?.throwIfAborted();
  try {
    const content = await readFactsFile(path, MAX_MANIFEST_BYTES, signal);
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!record(parsed)) throw new Error("Manifest must be an object");
    strings(parsed.scripts, "scripts");
    strings(parsed.dependencies, "dependencies");
    strings(parsed.devDependencies, "devDependencies");
    if (parsed.packageManager !== undefined &&
      (typeof parsed.packageManager !== "string" || !/^(npm|pnpm|yarn|bun)(@[^\s]+)?$/.test(parsed.packageManager))) {
      throw new Error("Unsupported packageManager");
    }
    return parsed;
  } catch (error) {
    signal?.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid ${path}`, { cause: error });
  }
}

export async function extractExecutionReceipts(
  workspaceRoot: string,
  cwd: string = workspaceRoot,
  options: { signal?: AbortSignal } = {},
): Promise<ExecutionReceipts> {
  const { signal } = options;
  signal?.throwIfAborted();
  const root = resolve(workspaceRoot);
  let directory = resolve(cwd);
  const displacement = relative(root, directory);
  if (isAbsolute(displacement) || displacement === ".." || displacement.startsWith(`..${sep}`)) {
    throw new Error("Command directory is outside repository root");
  }
  let selected: { directory: string; manifest: Manifest } | undefined;
  let manager: string | undefined;
  while (true) {
    const manifest = await readManifest(join(directory, "package.json"), signal);
    if (manifest && !selected) selected = { directory, manifest };
    if (!manager && typeof manifest?.packageManager === "string") manager = manifest.packageManager;
    if (!manager) {
      for (const [lockfile, candidate] of [
        ["pnpm-lock.yaml", "pnpm"],
        ["yarn.lock", "yarn"],
        ["bun.lock", "bun"],
        ["bun.lockb", "bun"],
        ["package-lock.json", "npm"],
      ]) {
        if (existsSync(join(directory, lockfile))) {
          manager = candidate;
          break;
        }
      }
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  if (!selected) return { dependencies: {}, devDependencies: {} };
  const scripts = strings(selected.manifest.scripts, "scripts");
  const pm = (manager ?? "npm").split("@")[0];
  return {
    commandCwd: relative(root, selected.directory).split(sep).join("/") || ".",
    packagePath: relative(root, join(selected.directory, "package.json")).split(sep).join("/"),
    packageManager: manager ?? "npm",
    testCommand: scripts.test?.trim() ? `${pm} test` : undefined,
    buildCommand: scripts.build?.trim() ? `${pm} run build` : undefined,
    lintCommand: scripts.lint?.trim() ? `${pm} run lint` : undefined,
    dependencies: strings(selected.manifest.dependencies, "dependencies"),
    devDependencies: strings(selected.manifest.devDependencies, "devDependencies"),
  };
}
