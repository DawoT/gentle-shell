import { Worker } from "node:worker_threads";
import { MAX_SOURCE_BYTES } from "./facts-limits.ts";
import type { FactsModuleEdge, FactsModuleSnapshot } from "./facts-module-resolver.ts";
import type { FileFacts } from "./facts-types.ts";

let worker: Worker | undefined;
let queue: Promise<void> = Promise.resolve();

function request<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();

  const current = worker ??= new Worker(new URL("../../runtime/facts-parser-worker.mjs", import.meta.url), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 },
  });
  current.ref();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, result?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      current.off("message", message);
      current.off("error", failed);
      current.off("exit", exited);
      if (error) {
        if (worker === current) worker = undefined;
        current.terminate().then(() => reject(error), () => reject(error));
      } else {
        current.unref();
        resolve(result!);
      }
    };
    const abort = () => finish(signal?.reason ?? new Error("Facts parsing cancelled"));
    const failed = (error: Error) => finish(error);
    const exited = (code: number) => finish(new Error(`Facts parser worker exited (${code})`));
    const message = (response: { facts?: T; error?: string }) => {
      if (response.error) finish(new Error(response.error));
      else if (!response.facts) finish(new Error("Invalid Facts worker response"));
      else finish(undefined, response.facts);
    };
    const timer = setTimeout(() => finish(new Error("Facts parser deadline exceeded")), 15_000);
    current.once("message", message);
    current.once("error", failed);
    current.once("exit", exited);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else current.postMessage(payload);
  });
}

function enqueue<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  let started = false;
  const result = queue.then(() => {
    started = true;
    return request<T>(payload, signal);
  });
  queue = result.then(() => undefined, () => undefined);
  if (!signal) return result;
  return new Promise((resolve, reject) => {
    const abort = () => {
      if (!started) reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    result.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function extractTypeScriptInWorker(path: string, source: string, sha: string, signal?: AbortSignal): Promise<FileFacts> {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return Promise.reject(new Error("TypeScript source byte limit exceeded"));
  return enqueue({ operation: "parse", path, source, sha }, signal);
}

export function resolveModulesInWorker(root: string, files: Record<string, FileFacts>, signal?: AbortSignal, confined = false): Promise<FactsModuleEdge[]> {
  const imports = Object.fromEntries(Object.entries(files).map(([path, file]) => [path, {
    path, sha: file.sha, imports: file.imports, symbols: [], exports: [],
  }]));
  return enqueue({ operation: "resolve", root, files: imports, confined }, signal);
}

export function resolveModuleSnapshotInWorker(root: string, files: Record<string, FileFacts>, signal?: AbortSignal): Promise<FactsModuleSnapshot> {
  const imports = Object.fromEntries(Object.entries(files).map(([path, file]) => [path, {
    path, sha: file.sha, imports: file.imports, symbols: [], exports: [],
  }]));
  return enqueue({ operation: "resolveSnapshot", root, files: imports }, signal);
}

export async function validateModuleSnapshotInWorker(snapshot: FactsModuleSnapshot, signal?: AbortSignal): Promise<boolean> {
  const result = await enqueue<{ valid: boolean }>({ operation: "validateSnapshot", snapshot }, signal);
  return result.valid;
}
