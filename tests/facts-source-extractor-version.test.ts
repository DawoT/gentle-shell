import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOURCE_EXTRACTOR_VERSION } from "../lib/facts/facts-languages.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { FactsStore } from "../lib/facts/facts-store.ts";

test("a source extractor version change forces source files to be re-indexed even for unchanged files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "source-extractor-version-"));
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "source-version-fixture", version: "1.0.0" }));
		await writeFile(join(dir, "helper.ts"), "export function helper(value: number): number { return value * 2; }\n");
		await writeFile(join(dir, "main.ts"), "import { helper } from './helper.ts';\nexport const doubled = helper(21);\n");
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

		// 1. First full sync: correct facts (with references) plus the current
		//    source extractor stamp.
		const service = new FactsService(dir);
		await service.sync(undefined, { mode: "full" });
		const db = service.getDatabase();
		assert.ok(db?.files["main.ts"]?.references?.includes("helper"), "references must be recorded by the current extractor");
		assert.equal(db?.sourceExtractorVersion, SOURCE_EXTRACTOR_VERSION, "the source extractor stamp must be recorded");
		service.close();

		// 2. Simulate an older extractor: FileFacts without references plus an
		//    old stamp in the persisted store — exactly what a real extractor
		//    output-shape change leaves behind for unchanged files.
		const store = new FactsStore(dir);
		const persisted = await store.load();
		assert.ok(persisted);
		for (const file of Object.values(persisted.files)) {
			delete file.references;
		}
		persisted.sourceExtractorVersion = "1";
		await store.save(persisted);

		// 3. A new service in auto mode must refuse the fast path (stamp
		//    mismatch), take the full reconciliation and re-index every source.
		const next = new FactsService(dir);
		await next.sync(undefined, { mode: "auto" });
		const healed = next.getDatabase();
		assert.ok(healed?.files["main.ts"]?.references?.includes("helper"), "references must be restored by the re-index");
		assert.equal(healed?.sourceExtractorVersion, SOURCE_EXTRACTOR_VERSION, "the stamp must be current after the healing sync");
		next.close();

		// 4. The stamp must survive persistence for the next session.
		const persistedAfter = await new FactsStore(dir).load();
		assert.equal(persistedAfter?.sourceExtractorVersion, SOURCE_EXTRACTOR_VERSION, "the stamp must be persisted");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
