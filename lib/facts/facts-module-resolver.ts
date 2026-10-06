import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import ts from "typescript";
import { createHash } from "node:crypto";
import type { FileFacts } from "./facts-types.ts";

export interface FactsModuleEdge {
  importer: string;
  specifier: string;
  target?: string;
  evidence: "typescript" | "filesystem" | "unresolved";
  reason?: string;
}

export type UnresolvedCategory = "builtin" | "external" | "relative";

/**
 * Classify an unresolved specifier by shape alone, at the reporter/consumer side,
 * so every unresolved-edge producer (module resolver and non-TypeScript languages)
 * is covered without changing edge semantics. "builtin" marks node: builtins and
 * "external" marks bare package specifiers; both are expected, not actionable.
 * "relative" marks genuinely broken relative (./ ../) or absolute imports.
 * Defensive: empty or non-string input (e.g. from dynamic callers) is "external".
 */
export function classifyUnresolvedSpecifier(specifier: string): UnresolvedCategory {
  if (typeof specifier !== "string" || specifier.length === 0) return "external";
  if (specifier.startsWith("node:")) return "builtin";
  if (specifier.startsWith(".") || isAbsolute(specifier)) return "relative";
  return "external";
}

/**
 * Render the facts_status resolution summary: one line with resolved/unresolved
 * counts split by category, plus up to three importer -> specifier examples for
 * the actionable "relative" category, sorted by importer then specifier.
 */
export function formatResolutionSummary(edges: FactsModuleEdge[]): string {
  const resolved = edges.filter((edge) => edge.evidence === "typescript" || edge.evidence === "filesystem").length;
  const unresolved = edges.filter((edge) => edge.evidence === "unresolved");
  const counts: Record<UnresolvedCategory, number> = { builtin: 0, external: 0, relative: 0 };
  for (const edge of unresolved) {
    counts[classifyUnresolvedSpecifier(edge.specifier)] += 1;
  }
  const lines = [
    `- Module resolution: ${resolved} resolved, ${unresolved.length} unresolved (builtins ${counts.builtin}, external ${counts.external}, relative ${counts.relative})`,
  ];
  const examples = unresolved
    .filter((edge) => classifyUnresolvedSpecifier(edge.specifier) === "relative")
    .sort((left, right) => left.importer === right.importer
      ? (left.specifier < right.specifier ? -1 : left.specifier > right.specifier ? 1 : 0)
      : (left.importer < right.importer ? -1 : 1))
    .slice(0, 3);
  for (const edge of examples) {
    lines.push(`  - ${edge.importer} -> ${edge.specifier}`);
  }
  return lines.join("\n");
}

interface ResolutionConfig {
  options: ts.CompilerOptions;
  invalid: boolean;
  usesDefaults?: boolean;
  references?: readonly ts.ProjectReference[];
}

type Probe = "fileExists" | "directoryExists" | "readFile" | "realpath" | "getDirectories" | "readDirectory";
interface ResolutionInput {
  operation: Probe;
  path: string;
  value: string;
}
export interface FactsModuleSnapshot {
  root: string;
  confined: boolean;
  edges: FactsModuleEdge[];
  inputs: ResolutionInput[];
  consistent: boolean;
  /** Set only by the incremental resolver: how many importers re-resolved fresh. */
  freshImporters?: number;
}

function createResolutionHost(root: string, confined: boolean) {
  const workspace = resolve(root);
  const permitted = (path: string) => {
    if (!confined) return true;
    const displacement = relative(workspace, resolve(path));
    return displacement !== ".." && !displacement.startsWith(`..${sep}`) && !isAbsolute(displacement);
  };
  let metadataBytes = 0;
  let operations = 0;
  const metadata = new Map<string, string | undefined>();
  const countOperation = () => {
    if (++operations > 100_000) throw new Error("Facts module metadata operation limit exceeded");
  };
  const host: ts.ModuleResolutionHost & { useCaseSensitiveFileNames: boolean } = {
    ...ts.sys,
    fileExists(path) {
      countOperation();
      return permitted(path) && ts.sys.fileExists(path);
    },
    directoryExists(path) {
      countOperation();
      return permitted(path) && ts.sys.directoryExists(path);
    },
    readFile(path) {
      countOperation();
      if (!permitted(path)) return undefined;
      if (metadata.has(path)) return metadata.get(path);
      let descriptor: number;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          metadata.set(path, undefined);
          return undefined;
        }
        throw error;
      }
      try {
        if (!fstatSync(descriptor).isFile()) throw new Error("Facts module metadata requires regular files");
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = readSync(descriptor, buffer, length, buffer.length - length, null);
          if (read === 0) break;
          length += read;
        }
        metadataBytes += length;
        if (length > 1024 * 1024 || metadataBytes > 8 * 1024 * 1024) {
          throw new Error("Facts module metadata byte limit exceeded");
        }
        const text = buffer.subarray(0, length).toString("utf8").replace(/^\uFEFF/, "");
        metadata.set(path, text);
        return text;
      } finally {
        closeSync(descriptor);
      }
    },
  };
  if (confined) {
    Object.assign(host, {
      getCurrentDirectory: () => workspace,
      realpath: (path: string) => resolve(path),
      getDirectories: (path: string) => permitted(path) ? ts.sys.getDirectories(path) : [],
      readDirectory: () => [],
    });
  }
  return host;
}

function probeValue(operation: Probe, value: unknown): string {
  // Hash exactly the parser-visible metadata; never transport its contents.
  const encoded = JSON.stringify(value) ?? "undefined";
  return operation === "readFile"
    ? createHash("sha256").update(encoded).digest("hex")
    : encoded;
}

export function resolveFactsModuleSnapshot(root: string, files: Record<string, FileFacts>, options: { confined?: boolean } = {}): FactsModuleSnapshot {
  return buildSnapshot(root, files, options);
}

export interface FactsResolutionCacheEntry {
  sha: string;
  probes: ResolutionInput[];
  edges: FactsModuleEdge[];
}

/** Per-importer resolution cache, keyed by importer path within one workspace root. */
export type FactsResolutionCache = Map<string, FactsResolutionCacheEntry>;

/**
 * Incremental variant of resolveFactsModuleSnapshot: an importer whose content
 * SHA is unchanged reuses its cached edges after replaying exactly the probes
 * that justified them against the live filesystem; anything that fails the
 * replay (changed imports, config, node metadata or probe disappearance)
 * re-resolves fresh. Replayed probes join the returned snapshot's read-set,
 * so downstream snapshot validation keeps its full semantics.
 */
export function resolveFactsModuleSnapshotIncremental(root: string, files: Record<string, FileFacts>, cache: FactsResolutionCache, options: { confined?: boolean } = {}): FactsModuleSnapshot {
  return buildSnapshot(root, files, options, cache);
}

function buildSnapshot(root: string, files: Record<string, FileFacts>, options: { confined?: boolean }, cache?: FactsResolutionCache): FactsModuleSnapshot {
  const host = createResolutionHost(root, Boolean(options.confined));
  const inputs = new Map<string, ResolutionInput>();
  let consistent = true;
  // Probes fired while resolving one importer are attributed to it, so a
  // cached importer can re-verify exactly its own justification later.
  let collector: Set<string> | null = null;
  for (const operation of ["fileExists", "directoryExists", "readFile", "realpath", "getDirectories", "readDirectory"] as const) {
    const original = host[operation]?.bind(host);
    if (!original) continue;
    Object.assign(host, {
      [operation]: (path: string) => {
        const value = original(path);
        const input = { operation, path, value: probeValue(operation, value) };
        const key = JSON.stringify([operation, path]);
        const previous = inputs.get(key);
        if (previous && previous.value !== input.value) {
          consistent = false;
        }
        inputs.set(key, input);
        collector?.add(key);
        return value;
      },
    });
  }
  const { configFor, readConfig } = createConfigFor(root, host, () => collector);
  const edges: FactsModuleEdge[] = [];
  let freshImporters = cache ? 0 : undefined;
  for (const importer of Object.keys(files).sort()) {
    let reused = false;
    if (cache) {
      const cached = cache.get(importer);
      if (cached && cached.sha === files[importer].sha) {
        collector = new Set<string>();
        let valid = true;
        for (const input of cached.probes) {
          const probe = host[input.operation];
          const value = probe ? probeValue(input.operation, probe.call(host, input.path)) : undefined;
          const key = JSON.stringify([input.operation, input.path]);
          const previous = inputs.get(key);
          if (previous && previous.value !== value) {
            consistent = false;
          }
          inputs.set(key, { operation: input.operation, path: input.path, value });
          if (value !== input.value) {
            valid = false;
            break;
          }
        }
        collector = null;
        if (valid) {
          for (const edge of cached.edges) edges.push({ ...edge });
          reused = true;
        }
      }
      if (!reused) {
        freshImporters = (freshImporters ?? 0) + 1;
      }
    }
    if (!reused) {
      collector = new Set<string>();
      const importerEdges = resolveOneImporter(root, files, importer, host, configFor, readConfig);
      for (const edge of importerEdges) edges.push(edge);
      if (cache) {
        const probes: ResolutionInput[] = [];
        for (const key of collector) {
          const input = inputs.get(key);
          if (input) probes.push(input);
        }
        cache.set(importer, { sha: files[importer].sha, probes, edges: importerEdges });
      }
      collector = null;
    }
  }
  if (cache) {
    for (const importer of cache.keys()) {
      if (!Object.hasOwn(files, importer)) cache.delete(importer);
    }
  }
  return {
    root,
    confined: Boolean(options.confined),
    edges,
    inputs: [...inputs.values()],
    consistent,
    ...(cache ? { freshImporters } : {}),
  };
}

export function validateFactsModuleSnapshot(snapshot: FactsModuleSnapshot): boolean {
  if (!snapshot.consistent) return false;
  const host = createResolutionHost(snapshot.root, snapshot.confined);
  for (const input of snapshot.inputs) {
    const probe = host[input.operation];
    if (!probe || probeValue(input.operation, probe.call(host, input.path)) !== input.value) return false;
  }
  return true;
}

/**
 * Filesystem fallback for relative specifiers the index cannot confirm through
 * TypeScript: when the unresolved push happens for a "./"- or "../"-prefixed
 * specifier, confirm the exact sibling path exists and return it as a
 * workspace-relative target so the edge can carry evidence "filesystem" — such
 * imports are real, not actionable breakage. This covers both JSON modules
 * TypeScript resolves outside the facts index ("outside-index", the live
 * false-positive case: JSON files are not indexed as source facts) and modules
 * TS cannot resolve at all ("module-not-found"). The probe runs through the
 * resolution host (confined trees never probe outside the workspace, and probes
 * join the snapshot read-set), checks exact-path file existence only — no
 * extension guessing, no directory/index resolution — and never fires for bare
 * (external stays external), absolute, or "invalid-tsconfig" edges where TS
 * never ran. Under confinement an out-of-workspace path fails the probe and
 * stays unresolved.
 */
function filesystemFallbackTarget(workspace: string, importerAbsolute: string, specifier: string, host: ts.ModuleResolutionHost): string | undefined {
  const path = resolve(dirname(importerAbsolute), specifier);
  if (!host.fileExists?.(path)) return undefined;
  return relative(workspace, path).split(sep).join("/");
}

/** Resolve literal module specifiers, not symbol identity or runtime imports. */
export function resolveFactsModules(root: string, files: Record<string, FileFacts>, options: { confined?: boolean } = {}): FactsModuleEdge[] {
  const snapshot = resolveFactsModuleSnapshot(root, files, options);
  if (!snapshot.consistent) throw new Error("Facts module inputs changed during resolution");
  return snapshot.edges;
}

interface AttributedConfig {
  config: ResolutionConfig;
  keys: Set<string>;
}

/**
 * Per-snapshot tsconfig lookup with probe attribution: importers that hit the
 * config cache inherit the probe keys of the config they reused, so a later
 * tsconfig change invalidates every importer that walked through it, not just
 * the first one that read it.
 */
function createConfigFor(root: string, host: ReturnType<typeof createResolutionHost>, currentCollector: () => Set<string> | null): {
  configFor: (file: string) => ResolutionConfig;
  readConfig: (path: string) => ResolutionConfig;
} {
  const workspace = resolve(root);
  const configs = new Map<string, AttributedConfig>();
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };

  function readConfig(path: string): ResolutionConfig {
    const cached = configs.get(path);
    if (cached) {
      const collector = currentCollector();
      if (collector) for (const key of cached.keys) collector.add(key);
      return cached.config;
    }
    const collector = currentCollector();
    const before = collector ? new Set(collector) : undefined;
    // Read outside readConfigFile: TypeScript otherwise converts IO failures to diagnostics.
    const source = host.readFile(path);
    const loaded = ts.readConfigFile(path, () => source);
    const parsed = ts.parseJsonConfigFileContent(loaded.config ?? {}, {
      ...ts.sys,
      ...host,
      // Module resolution needs options, not a recursive source inventory.
      readDirectory: () => [],
    }, dirname(path), undefined, path);
    const config = {
      options: parsed.options,
      references: parsed.projectReferences,
      // 18002/18003 only indicate our deliberately empty source inventory.
      invalid: Boolean(loaded.error) || parsed.errors.some((error) => ![18002, 18003].includes(error.code)),
    };
    const keys = new Set<string>();
    if (collector && before) {
      for (const key of collector) {
        if (!before.has(key)) keys.add(key);
      }
    }
    configs.set(path, { config, keys });
    return config;
  }

  function configFor(file: string): ResolutionConfig {
    let directory = dirname(file);
    while (true) {
      const cached = configs.get(directory);
      if (cached) {
        const collector = currentCollector();
        if (collector) for (const key of cached.keys) collector.add(key);
        return cached.config;
      }
      const configPath = resolve(directory, "tsconfig.json");
      if (host.fileExists(configPath)) {
        const config = readConfig(configPath);
        // Alias the directory to the loaded config, attributing this
        // directory's existence probe too: a tsconfig deletion must
        // invalidate importers that only hit the config cache.
        const entry = configs.get(configPath) ?? { config, keys: new Set<string>() };
        const keys = new Set(entry.keys);
        keys.add(JSON.stringify(["fileExists", configPath]));
        configs.set(directory, { config: entry.config, keys });
        return config;
      }
      if (directory === workspace || dirname(directory) === directory) {
        return { options: defaults, invalid: false, usesDefaults: true };
      }
      directory = dirname(directory);
    }
  }

  return { configFor, readConfig };
}

function resolveOneImporter(root: string, files: Record<string, FileFacts>, importer: string, host: ReturnType<typeof createResolutionHost>, configFor: (file: string) => ResolutionConfig, readConfig: (path: string) => ResolutionConfig): FactsModuleEdge[] {
  const workspace = resolve(root);
  const absolute = resolve(workspace, importer);
  let config = configFor(absolute);
  const visited = new Set<string>();
  while (config.references?.length && !config.invalid) {
    const candidates = config.references.map((reference) => {
      const path = ts.resolveProjectReferencePath(reference);
      return { path, directory: dirname(path) };
    }).filter(({ path, directory }) => {
      const within = relative(workspace, path);
      const source = relative(directory, absolute);
      return !visited.has(path) && !within.startsWith("..") && !isAbsolute(within)
        && !source.startsWith("..") && !isAbsolute(source);
    }).sort((left, right) => right.directory.length - left.directory.length);
    if (!candidates.length) {
      break;
    }
    if (candidates.length > 1 && candidates[0].directory === candidates[1].directory) {
      config = { options: {}, invalid: true };
      break;
    }
    const { path } = candidates[0];
    visited.add(path);
    config = readConfig(path);
  }
  const edges: FactsModuleEdge[] = [];
  for (const specifier of [...new Set(files[importer].imports)].sort()) {
    if (config.invalid) {
      edges.push({ importer, specifier, evidence: "unresolved", reason: "invalid-tsconfig" });
      continue;
    }
    const resolved = ts.resolveModuleName(specifier, absolute, config.options, host).resolvedModule;
    const target = resolved ? relative(workspace, resolved.resolvedFileName).split(sep).join("/") : undefined;
    if (target && !isAbsolute(target) && !target.startsWith("../") && Object.hasOwn(files, target)) {
      edges.push({ importer, specifier, target, evidence: "typescript", ...(config.usesDefaults ? { reason: "default-compiler-options" } : {}) });
      continue;
    }
    const filesystemTarget = specifier.startsWith(".")
      ? filesystemFallbackTarget(workspace, absolute, specifier, host)
      : undefined;
    if (filesystemTarget !== undefined) {
      edges.push({ importer, specifier, target: filesystemTarget, evidence: "filesystem" });
    } else {
      edges.push({
        importer,
        specifier,
        evidence: "unresolved",
        reason: resolved ? "outside-index" : "module-not-found",
      });
    }
  }
  return edges;
}
