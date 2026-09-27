import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { FileFacts } from "./facts-types.ts";

export interface FactsModuleEdge {
  importer: string;
  specifier: string;
  target?: string;
  evidence: "typescript" | "unresolved";
  reason?: string;
}

interface ResolutionConfig {
  options: ts.CompilerOptions;
  invalid: boolean;
  references?: readonly ts.ProjectReference[];
}

/** Resolve literal module specifiers, not symbol identity or runtime imports. */
export function resolveFactsModules(root: string, files: Record<string, FileFacts>): FactsModuleEdge[] {
  const workspace = resolve(root);
  const configs = new Map<string, ResolutionConfig>();
  const defaults: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
  };

  function readConfig(path: string): ResolutionConfig {
    const cached = configs.get(path);
    if (cached) {
      return cached;
    }
    const loaded = ts.readConfigFile(path, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(loaded.config ?? {}, {
      ...ts.sys,
      // Module resolution needs options, not a recursive source inventory.
      readDirectory: () => [],
    }, dirname(path), undefined, path);
    const config = {
      options: parsed.options,
      references: parsed.projectReferences,
      // 18002/18003 only indicate our deliberately empty source inventory.
      invalid: Boolean(loaded.error) || parsed.errors.some((error) => ![18002, 18003].includes(error.code)),
    };
    configs.set(path, config);
    return config;
  }

  function configFor(file: string): ResolutionConfig {
    let directory = dirname(file);
    while (true) {
      const cached = configs.get(directory);
      if (cached) {
        return cached;
      }
      const configPath = resolve(directory, "tsconfig.json");
      if (ts.sys.fileExists(configPath)) {
        const config = readConfig(configPath);
        configs.set(directory, config);
        return config;
      }
      if (directory === workspace || dirname(directory) === directory) {
        return { options: defaults, invalid: false };
      }
      directory = dirname(directory);
    }
  }

  const edges: FactsModuleEdge[] = [];
  for (const importer of Object.keys(files).sort()) {
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
    for (const specifier of [...new Set(files[importer].imports)].sort()) {
      if (config.invalid) {
        edges.push({ importer, specifier, evidence: "unresolved", reason: "invalid-tsconfig" });
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, absolute, config.options, ts.sys).resolvedModule;
      const target = resolved ? relative(workspace, resolved.resolvedFileName).split(sep).join("/") : undefined;
      if (target && !isAbsolute(target) && !target.startsWith("../") && Object.hasOwn(files, target)) {
        edges.push({ importer, specifier, target, evidence: "typescript" });
      } else {
        edges.push({
          importer,
          specifier,
          evidence: "unresolved",
          reason: resolved ? "outside-index" : "module-not-found",
        });
      }
    }
  }
  return edges;
}
