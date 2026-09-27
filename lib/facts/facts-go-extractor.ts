import { execFile } from "node:child_process";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SOURCE_BYTES } from "./facts-limits.ts";
import type { FileFacts } from "./facts-types.ts";

let binary: Promise<string> | undefined;

function run(command: string, args: string[], cwd: string, signal?: AbortSignal, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd,
      signal,
      timeout: input === undefined ? 60_000 : 10_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, GOENV: "off", GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local", GOPROXY: "off", CGO_ENABLED: "0" },
    }, (error, stdout, stderr) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(new Error(`Go parser failed: ${stderr.trim().slice(0, 1000) || error.message}`, { cause: error }));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function build(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "gentle-facts-go-"));
  try {
    const source = join(directory, "parser.go");
    await copyFile(fileURLToPath(new URL("./parsers/go_facts.go", import.meta.url)), source);
    const output = join(directory, process.platform === "win32" ? "parser.exe" : "parser");
    await run("go", ["build", "-o", output, source], directory);
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    return output;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function extractGoFacts(filePath: string, sourceText: string, sha: string, signal?: AbortSignal): Promise<FileFacts> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(sourceText) > MAX_SOURCE_BYTES) throw new Error("Go source byte limit exceeded");
  binary ??= build().catch((error) => {
    binary = undefined;
    throw error;
  });
  const executable = await waitForBuild(binary, signal);
  signal?.throwIfAborted();
  return JSON.parse(await run(executable, [], tmpdir(), signal, JSON.stringify({ path: filePath, source: sourceText, sha }))) as FileFacts;
}

function waitForBuild(pending: Promise<string>, signal?: AbortSignal): Promise<string> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (path) => {
        signal.removeEventListener("abort", abort);
        resolve(path);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
