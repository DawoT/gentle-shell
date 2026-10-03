import type { FactsModuleEdge } from "./facts-module-resolver.ts";

export const FACTS_DATABASE_VERSION = "1.3.0";

export type FileGitStatus = "tracked" | "modified" | "untracked" | "deleted";

export interface GitFileEntry {
  path: string;
  sha: string;
  status: FileGitStatus;
}

export interface WorkspaceGitScan {
  isGit: boolean;
  root: string;
  headCommitSha?: string;
  files: Map<string, GitFileEntry>;
}

export interface FactsDelta {
  modified: string[];
  added: string[];
  deleted: string[];
  untouched: string[];
}

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "typeAlias"
  | "enum"
  | "variable"
  | "constant";

export interface SymbolFact {
  name: string;
  declarationName?: string;
  kind: SymbolKind;
  signature: string;
  docstring?: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
}

export interface FileFacts {
  sourceBytes?: number;
  language?: "typescript" | "python" | "go";
  path: string;
  sha: string;
  symbols: SymbolFact[];
  imports: string[];
  exports: string[];
}

export interface ExecutionReceipts {
  commandCwd?: string;
  packagePath?: string;
  packageManager?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface FactsDatabase {
  source?: {
    kind: "commit";
    commit: string;
    scope: string;
    extractorVersion: string;
    materialization: "supported-sources-json-metadata-lock-markers";
    omitted: Array<{ path: string; reason: "symlink" | "submodule" }>;
  };
  moduleEdges?: FactsModuleEdge[];
  version: string;
  root: string;
  lastHeadCommit?: string;
  updatedAt: number;
  files: Record<string, FileFacts>;
  receipts?: ExecutionReceipts;
}
