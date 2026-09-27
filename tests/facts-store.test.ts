import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractExecutionReceipts } from "../lib/facts/facts-receipts-extractor.ts";
import { FactsStore } from "../lib/facts/facts-store.ts";
import { FactsService } from "../lib/facts/facts-service.ts";

async function createFixture() {
	const dir = await mkdtemp(join(tmpdir(), "facts-store-test-"));
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

test("extractExecutionReceipts extracts package manager, scripts and dependencies", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const pkg = {
			name: "sample-project",
			scripts: {
				test: "node --test",
				build: "tsc",
				lint: "eslint .",
			},
			packageManager: "pnpm@11.1.1",
			dependencies: {
				express: "^4.18.2",
			},
			devDependencies: {
				typescript: "^5.0.0",
			},
		};
		await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
		await writeFile(join(dir, "pnpm-lock.yaml"), "# lockfile");

		const receipts = await extractExecutionReceipts(dir);

		assert.ok(receipts);
		assert.equal(receipts.packageManager, "pnpm@11.1.1");
		assert.equal(receipts.testCommand, "pnpm test");
		assert.equal(receipts.buildCommand, "pnpm run build");
		assert.equal(receipts.lintCommand, "pnpm run lint");
		assert.equal(receipts.dependencies["express"], "^4.18.2");
		assert.equal(receipts.devDependencies["typescript"], "^5.0.0");
	} finally {
		await cleanup();
	}
});

test("extractExecutionReceipts returns safe defaults when package.json is missing", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const receipts = await extractExecutionReceipts(dir);
		assert.ok(receipts);
		assert.deepEqual(receipts.dependencies, {});
		assert.deepEqual(receipts.devDependencies, {});
	} finally {
		await cleanup();
	}
});

test("FactsStore saves and loads facts database atomically", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const store = new FactsStore(dir);
		const initial = await store.load();
		assert.equal(initial, null);

		const sampleData = {
			version: "1.0.0",
			root: dir,
			updatedAt: Date.now(),
			files: {
				"src/index.ts": {
					path: "src/index.ts",
					sha: "sha_abc",
					symbols: [{
						name: "app",
						kind: "constant" as const,
						signature: "const app = 1;",
						startLine: 1,
						endLine: 1,
						isExported: true,
					}],
					imports: [],
					exports: ["app"],
				},
			},
		};

		await store.save(sampleData);

		const loaded = await store.load();
		assert.ok(loaded);
		assert.equal(loaded.version, "1.0.0");
		assert.equal(loaded.files["src/index.ts"]?.symbols[0]?.name, "app");
	} finally {
		await cleanup();
	}
});

test("FactsService coordinates initial sync, incremental updates, and symbol queries", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		// 1. Setup repository files
		await writeFile(join(dir, "package.json"), JSON.stringify({
			name: "test-app",
			scripts: { test: "node --test" },
		}));
		await writeFile(join(dir, "calc.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
		await writeFile(join(dir, "app.ts"), "import { add } from './calc.ts';\nexport const result = add(1, 2);\n");

		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });

		// 2. Initial sync
		const service = new FactsService(dir);
		const firstSync = await service.sync();

		assert.equal(firstSync.indexedCount, 2);
		assert.equal(firstSync.cachedCount, 0);

		// 3. Query symbol
		const addSymbols = service.querySymbol("add");
		assert.equal(addSymbols.length, 1);
		assert.equal(addSymbols[0]?.symbol.name, "add");
		assert.equal(addSymbols[0]?.file, "calc.ts");
		assert.match(addSymbols[0]?.symbol.signature, /function add/);

		// 4. Query dependents
		const dependents = service.queryDependents("./calc.ts");
		assert.ok(dependents.includes("app.ts"));

		// 5. Re-sync without changes: should be 100% cache hits
		const secondSync = await service.sync();
		assert.equal(secondSync.indexedCount, 0);
		assert.equal(secondSync.cachedCount, 2);

		// 6. Incremental modify
		await writeFile(join(dir, "calc.ts"), "export function add(a: number, b: number, c: number = 0): number { return a + b + c; }\n");
		const thirdSync = await service.sync();
		assert.equal(thirdSync.indexedCount, 1);
		assert.equal(thirdSync.cachedCount, 1);

		const updatedAdd = service.querySymbol("add");
		assert.match(updatedAdd[0]?.symbol.signature, /c\?: number/);

		// 7. Verify prompt block
		const block = service.getSummaryPromptBlock();
		assert.ok(block.includes("[PROJECT GROUND TRUTH]"));
		assert.ok(block.includes("Indexed Files: 2"));
		assert.ok(block.includes("npm test"));
	} finally {
		await cleanup();
	}
});
