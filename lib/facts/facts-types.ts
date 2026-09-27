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
	kind: SymbolKind;
	signature: string;
	docstring?: string;
	startLine: number;
	endLine: number;
	isExported: boolean;
}

export interface FileFacts {
	path: string;
	sha: string;
	symbols: SymbolFact[];
	imports: string[];
	exports: string[];
}

export interface ExecutionReceipts {
	packageManager?: string;
	testCommand?: string;
	buildCommand?: string;
	lintCommand?: string;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
}

export interface FactsDatabase {
	version: string;
	root: string;
	lastHeadCommit?: string;
	updatedAt: number;
	files: Record<string, FileFacts>;
	receipts?: ExecutionReceipts;
}
