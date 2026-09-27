import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	scanGitWorkspace,
	calculateFactsDelta,
	NotAGitRepositoryError,
} from "../lib/facts/facts-git-indexer.ts";

async function createGitRepoFixture() {
	const dir = await mkdtemp(join(tmpdir(), "facts-git-test-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

	return {
		dir,
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

test("scanGitWorkspace indexes committed tracked files with valid Git blob SHAs", async () => {
	const { dir, cleanup } = await createGitRepoFixture();
	try {
		await writeFile(join(dir, "hello.ts"), "export const hello = 'world';\n");
		await mkdir(join(dir, "src"), { recursive: true });
		await writeFile(join(dir, "src", "index.ts"), "export * from '../hello.ts';\n");

		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });

		const expectedSha = execFileSync("git", ["hash-object", "hello.ts"], { cwd: dir, encoding: "utf8" }).trim();

		const result = await scanGitWorkspace(dir);

		assert.equal(result.isGit, true);
		assert.equal(result.files.size, 2);

		const helloEntry = result.files.get("hello.ts");
		assert.ok(helloEntry, "hello.ts should be in index");
		assert.equal(helloEntry.path, "hello.ts");
		assert.equal(helloEntry.sha, expectedSha);
		assert.equal(helloEntry.status, "tracked");

		const srcEntry = result.files.get("src/index.ts");
		assert.ok(srcEntry, "src/index.ts should be in index");
		assert.equal(srcEntry.status, "tracked");
	} finally {
		await cleanup();
	}
});

test("scanGitWorkspace detects untracked files and computes their content SHA", async () => {
	const { dir, cleanup } = await createGitRepoFixture();
	try {
		await writeFile(join(dir, "committed.ts"), "export const a = 1;\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "first"], { cwd: dir });

		await writeFile(join(dir, "untracked.ts"), "export const b = 2;\n");
		const expectedUntrackedSha = execFileSync("git", ["hash-object", "untracked.ts"], { cwd: dir, encoding: "utf8" }).trim();

		const result = await scanGitWorkspace(dir);

		const untrackedEntry = result.files.get("untracked.ts");
		assert.ok(untrackedEntry, "untracked.ts should be indexed");
		assert.equal(untrackedEntry.status, "untracked");
		assert.equal(untrackedEntry.sha, expectedUntrackedSha);
	} finally {
		await cleanup();
	}
});

test("scanGitWorkspace detects modified working tree files and updates SHA", async () => {
	const { dir, cleanup } = await createGitRepoFixture();
	try {
		await writeFile(join(dir, "file.ts"), "version 1\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "v1"], { cwd: dir });

		await writeFile(join(dir, "file.ts"), "version 2 (modified)\n");
		const expectedModifiedSha = execFileSync("git", ["hash-object", "file.ts"], { cwd: dir, encoding: "utf8" }).trim();

		const result = await scanGitWorkspace(dir);

		const fileEntry = result.files.get("file.ts");
		assert.ok(fileEntry);
		assert.equal(fileEntry.status, "modified");
		assert.equal(fileEntry.sha, expectedModifiedSha);
	} finally {
		await cleanup();
	}
});

test("scanGitWorkspace detects deleted files", async () => {
	const { dir, cleanup } = await createGitRepoFixture();
	try {
		await writeFile(join(dir, "todelete.ts"), "content\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "add file"], { cwd: dir });

		await unlink(join(dir, "todelete.ts"));

		const result = await scanGitWorkspace(dir);

		const deletedEntry = result.files.get("todelete.ts");
		assert.ok(deletedEntry);
		assert.equal(deletedEntry.status, "deleted");
	} finally {
		await cleanup();
	}
});

test("scanGitWorkspace handles paths with spaces properly", async () => {
	const { dir, cleanup } = await createGitRepoFixture();
	try {
		await writeFile(join(dir, "file with spaces.ts"), "export const space = true;\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "add spaced file"], { cwd: dir });

		const result = await scanGitWorkspace(dir);
		assert.ok(result.files.has("file with spaces.ts"));
	} finally {
		await cleanup();
	}
});

test("calculateFactsDelta classifies modified, added, deleted and untouched files", () => {
	const previousCache = new Map<string, string>([
		["untouched.ts", "sha_111"],
		["modified.ts", "sha_222_old"],
		["deleted.ts", "sha_333"],
	]);

	const currentScan = new Map([
		["untouched.ts", { path: "untouched.ts", sha: "sha_111", status: "tracked" as const }],
		["modified.ts", { path: "modified.ts", sha: "sha_222_new", status: "modified" as const }],
		["added.ts", { path: "added.ts", sha: "sha_444", status: "untracked" as const }],
		["deleted.ts", { path: "deleted.ts", sha: "sha_deleted", status: "deleted" as const }],
	]);

	const delta = calculateFactsDelta(previousCache, currentScan);

	assert.deepEqual(delta.untouched, ["untouched.ts"]);
	assert.deepEqual(delta.modified, ["modified.ts"]);
	assert.deepEqual(delta.added, ["added.ts"]);
	assert.deepEqual(delta.deleted, ["deleted.ts"]);
});

test("scanGitWorkspace throws NotAGitRepositoryError on non-git directories", async () => {
	const nonGitDir = await mkdtemp(join(tmpdir(), "facts-nongit-"));
	try {
		await assert.rejects(
			async () => {
				await scanGitWorkspace(nonGitDir);
			},
			(err: unknown) => err instanceof NotAGitRepositoryError,
		);
	} finally {
		await rm(nonGitDir, { recursive: true, force: true });
	}
});
