import { FACTS_DATABASE_VERSION, type FactsDatabase } from "./facts-types.ts";

const SYMBOL_KINDS = new Set(["function", "class", "interface", "typeAlias", "enum", "variable", "constant"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function isFactsDatabase(value: unknown): value is FactsDatabase {
  if (!isRecord(value) || value.version !== FACTS_DATABASE_VERSION ||
    typeof value.root !== "string" || !value.root ||
    typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) ||
    (value.lastHeadCommit !== undefined && typeof value.lastHeadCommit !== "string") ||
    !isRecord(value.files)) {
    return false;
  }

  if (value.source !== undefined) {
    const source = value.source;
    if (!isRecord(source) || source.kind !== "commit" || typeof source.commit !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit) || source.commit !== value.lastHeadCommit ||
      typeof source.scope !== "string" || typeof source.extractorVersion !== "string" ||
      source.materialization !== "supported-sources-json-metadata-lock-markers" ||
      !Array.isArray(source.omitted) || !source.omitted.every((entry) => isRecord(entry) &&
        typeof entry.path === "string" && ["symlink", "submodule"].includes(entry.reason as string))) return false;
  }

  for (const [path, file] of Object.entries(value.files)) {
    if (!isRecord(file) || file.path !== path || typeof file.sha !== "string" ||
      (file.sourceBytes !== undefined && (!Number.isSafeInteger(file.sourceBytes) || (file.sourceBytes as number) < 0)) ||
      !isStringArray(file.imports) || !isStringArray(file.exports) || !Array.isArray(file.symbols)) {
      return false;
    }
    for (const symbol of file.symbols) {
      if (!isRecord(symbol) || typeof symbol.name !== "string" ||
        typeof symbol.kind !== "string" || !SYMBOL_KINDS.has(symbol.kind) ||
        typeof symbol.signature !== "string" || typeof symbol.isExported !== "boolean" ||
        (symbol.declarationName !== undefined && typeof symbol.declarationName !== "string") ||
        typeof symbol.startLine !== "number" || !Number.isInteger(symbol.startLine) || symbol.startLine < 1 ||
        typeof symbol.endLine !== "number" || !Number.isInteger(symbol.endLine) || symbol.endLine < symbol.startLine ||
        (symbol.docstring !== undefined && typeof symbol.docstring !== "string")) {
        return false;
      }
    }
  }

  if (value.receipts !== undefined) {
    const receipts = value.receipts;
    if (!isRecord(receipts) || !isStringRecord(receipts.dependencies) || !isStringRecord(receipts.devDependencies)) {
      return false;
    }
    for (const key of ["packageManager", "testCommand", "buildCommand", "lintCommand", "commandCwd", "packagePath"]) {
      if (receipts[key] !== undefined && typeof receipts[key] !== "string") {
        return false;
      }
    }
  }
  if (value.moduleEdges !== undefined && (!Array.isArray(value.moduleEdges) ||
    !value.moduleEdges.every((edge) => isRecord(edge) && typeof edge.importer === "string" &&
      typeof edge.specifier === "string" && ["typescript", "unresolved"].includes(edge.evidence as string) &&
      (edge.target === undefined || typeof edge.target === "string") &&
      (edge.reason === undefined || typeof edge.reason === "string")))) return false;
  return true;
}
