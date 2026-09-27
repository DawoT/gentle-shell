import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { calculateFactsDelta, scanGitWorkspace } from "./facts-git-indexer.ts";
import { extractExecutionReceipts } from "./facts-receipts-extractor.ts";
import { FactsStore } from "./facts-store.ts";
import { extractTypeScriptFacts } from "./facts-ts-extractor.ts";
import type { ExecutionReceipts, FactsDatabase, FileFacts, SymbolFact } from "./facts-types.ts";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export interface SyncResult {
	indexedCount: number;
	cachedCount: number;
	deletedCount: number;
}

export interface SymbolQueryResult {
	file: string;
	symbol: SymbolFact;
}

export class FactsService {
	private readonly workspaceRoot: string;
	private readonly store: FactsStore;
	private db: FactsDatabase | null = null;

	constructor(workspaceRoot: string, customDirName?: string) {
		this.workspaceRoot = workspaceRoot;
		this.store = new FactsStore(workspaceRoot, customDirName);
	}

	async sync(): Promise<SyncResult> {
		const scan = await scanGitWorkspace(this.workspaceRoot);

		let db = this.db;
		if (!db) {
			db = await this.store.load();
		}

		if (!db) {
			db = {
				version: "1.0.0",
				root: scan.root,
				updatedAt: Date.now(),
				files: {},
			};
		}

		// Compute existing hashes
		const previousHashes = new Map<string, string>();
		for (const [path, file] of Object.entries(db.files)) {
			previousHashes.set(path, file.sha);
		}

		const delta = calculateFactsDelta(previousHashes, scan.files);

		// 1. Purge deleted files
		for (const delPath of delta.deleted) {
			delete db.files[delPath];
		}

		// 2. Index added and modified files
		const toIndex = [...delta.added, ...delta.modified];
		let indexedCount = 0;

		for (const relPath of toIndex) {
			const ext = extname(relPath);
			if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

			const entry = scan.files.get(relPath);
			if (!entry || entry.status === "deleted") continue;

			try {
				const fullPath = join(scan.root, relPath);
				const content = await readFile(fullPath, "utf8");
				const facts = extractTypeScriptFacts(relPath, content, entry.sha);
				db.files[relPath] = facts;
				indexedCount++;
			} catch {
				// Continue indexing remaining files if one fails
			}
		}

		// 3. Extract execution receipts
		db.receipts = await extractExecutionReceipts(scan.root);
		db.lastHeadCommit = scan.headCommitSha;
		db.updatedAt = Date.now();

		this.db = db;
		await this.store.save(db);

		return {
			indexedCount,
			cachedCount: delta.untouched.length,
			deletedCount: delta.deleted.length,
		};
	}

	querySymbol(name: string): SymbolQueryResult[] {
		if (!this.db) return [];
		const results: SymbolQueryResult[] = [];

		for (const [file, facts] of Object.entries(this.db.files)) {
			for (const symbol of facts.symbols) {
				if (symbol.name === name || symbol.name.toLowerCase() === name.toLowerCase()) {
					results.push({ file, symbol });
				}
			}
		}

		return results;
	}

	queryDependents(symbolOrFile: string): string[] {
		if (!this.db) return [];
		const dependents: string[] = [];

		for (const [file, facts] of Object.entries(this.db.files)) {
			for (const imp of facts.imports) {
				if (imp === symbolOrFile || imp.endsWith(symbolOrFile) || symbolOrFile.endsWith(imp)) {
					if (!dependents.includes(file)) {
						dependents.push(file);
					}
				}
			}
		}

		return dependents.sort();
	}

	getReceipts(): ExecutionReceipts | undefined {
		return this.db?.receipts;
	}

	getDatabase(): FactsDatabase | null {
		return this.db;
	}

	getSummaryPromptBlock(): string {
		const receipts = this.db?.receipts;
		const fileCount = Object.keys(this.db?.files || {}).length;
		let totalSymbols = 0;
		for (const file of Object.values(this.db?.files || {})) {
			totalSymbols += file.symbols.length;
		}

		const lines: string[] = [
			"[PROJECT GROUND TRUTH]",
			`- Package Manager: ${receipts?.packageManager || "unknown"}`,
			`- Verified Test Command: ${receipts?.testCommand || "none declared"}`,
		];

		if (receipts?.buildCommand) {
			lines.push(`- Build Command: ${receipts.buildCommand}`);
		}
		if (receipts?.lintCommand) {
			lines.push(`- Lint Command: ${receipts.lintCommand}`);
		}

		lines.push(
			`- Indexed Files: ${fileCount} | Total Symbols: ${totalSymbols}`,
			"- Fact Tools: Use 'facts_query' to inspect signatures and types without opening files.",
		);

		return lines.join("\n");
	}
}
