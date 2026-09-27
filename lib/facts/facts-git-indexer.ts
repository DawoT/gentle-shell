import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { FactsDelta, GitFileEntry, WorkspaceGitScan } from "./facts-types.ts";

const execFileAsync = promisify(execFile);

export class NotAGitRepositoryError extends Error {
	constructor(path: string, cause?: unknown) {
		super(`The directory is not a Git repository: ${path}`, cause === undefined ? undefined : { cause });
		this.name = "NotAGitRepositoryError";
	}
}

/**
 * Computes the exact Git blob SHA-1 of a buffer or string.
 * Canonical Git blob format: "blob <size>\0<content>"
 */
export function computeGitBlobSha(content: Buffer | string): string {
	const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
	const header = Buffer.from(`blob ${buffer.length}\0`);
	return createHash("sha1").update(header).update(buffer).digest("hex");
}

async function execGit(args: string[], cwd: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			encoding: "utf8",
			maxBuffer: 50 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		throw error;
	}
}

/**
 * Scans a Git workspace and builds an exact map of relative file paths to their
 * current Git blob SHA and working tree status.
 */
export async function scanGitWorkspace(workspaceRoot: string): Promise<WorkspaceGitScan> {
	const resolvedRoot = resolve(workspaceRoot);

	let gitRoot: string;
	try {
		const stdout = await execGit(["rev-parse", "--show-toplevel"], resolvedRoot);
		gitRoot = stdout.trim();
	} catch (error) {
		throw new NotAGitRepositoryError(resolvedRoot, error);
	}

	let headCommitSha: string | undefined;
	try {
		const stdout = await execGit(["rev-parse", "HEAD"], gitRoot);
		headCommitSha = stdout.trim();
	} catch {
		headCommitSha = undefined; // Unborn branch / fresh repo
	}

	const files = new Map<string, GitFileEntry>();

	// 1. Read all tracked index files via `git ls-files -s -z`
	// Output format: "<mode> <sha> <stage>\t<path>\0"
	const lsFilesOutput = await execGit(["ls-files", "-s", "-z"], gitRoot);
	if (lsFilesOutput.length > 0) {
		const entries = lsFilesOutput.split("\0");
		for (const entry of entries) {
			if (!entry) continue;
			const tabIndex = entry.indexOf("\t");
			if (tabIndex === -1) continue;
			const meta = entry.slice(0, tabIndex);
			const filePath = entry.slice(tabIndex + 1);
			const parts = meta.split(" ");
			if (parts.length >= 2) {
				const sha = parts[1];
				files.set(filePath, {
					path: filePath,
					sha,
					status: "tracked",
				});
			}
		}
	}

	// 2. Read working tree modifications, untracked, and deleted files via `git status --porcelain=v1 -z -uall`
	// Format: "XY <path>\0" (with renames: "XY <path>\0<origPath>\0")
	const statusOutput = await execGit(["status", "--porcelain=v1", "-z", "-uall"], gitRoot);
	if (statusOutput.length > 0) {
		const tokens = statusOutput.split("\0");
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token || token.length < 3) continue;

			const x = token[0];
			const y = token[1];
			const filePath = token.slice(3);

			if (x === "?" && y === "?") {
				// Untracked file: compute its blob SHA from disk
				const fullPath = isAbsolute(filePath) ? filePath : join(gitRoot, filePath);
				try {
					const content = await readFile(fullPath);
					const sha = computeGitBlobSha(content);
					files.set(filePath, {
						path: filePath,
						sha,
						status: "untracked",
					});
				} catch {
					// File might have been removed concurrently
				}
			} else if (x === "D" || y === "D") {
				// Deleted file
				const existing = files.get(filePath);
				files.set(filePath, {
					path: filePath,
					sha: existing?.sha ?? "",
					status: "deleted",
				});
			} else {
				// Modified or added in working tree/index
				const fullPath = isAbsolute(filePath) ? filePath : join(gitRoot, filePath);
				try {
					const content = await readFile(fullPath);
					const sha = computeGitBlobSha(content);
					files.set(filePath, {
						path: filePath,
						sha,
						status: "modified",
					});
				} catch {
					// Fall back to index entry if disk read fails
				}
			}
		}
	}

	return {
		isGit: true,
		root: gitRoot,
		headCommitSha,
		files,
	};
}

/**
 * Compares previously cached file SHAs with the current scan to produce an
 * exact, minimal set of modified, added, deleted, and untouched files.
 */
export function calculateFactsDelta(
	previousHashes: Map<string, string> | Record<string, string>,
	currentScan: Map<string, GitFileEntry> | Record<string, GitFileEntry>,
): FactsDelta {
	const prevMap = previousHashes instanceof Map
		? previousHashes
		: new Map(Object.entries(previousHashes));

	const currMap = currentScan instanceof Map
		? currentScan
		: new Map(Object.entries(currentScan));

	const modified: string[] = [];
	const added: string[] = [];
	const deleted: string[] = [];
	const untouched: string[] = [];

	// Check files in current scan
	for (const [path, entry] of currMap.entries()) {
		if (entry.status === "deleted") {
			deleted.push(path);
			continue;
		}

		const prevSha = prevMap.get(path);
		if (prevSha === undefined) {
			added.push(path);
		} else if (prevSha !== entry.sha) {
			modified.push(path);
		} else {
			untouched.push(path);
		}
	}

	// Check for files that were in previous map but completely absent from current scan
	for (const prevPath of prevMap.keys()) {
		if (!currMap.has(prevPath)) {
			deleted.push(prevPath);
		}
	}

	return {
		modified: modified.sort(),
		added: added.sort(),
		deleted: deleted.sort(),
		untouched: untouched.sort(),
	};
}
