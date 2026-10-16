import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_PARSER_VERSION } from "../lib/facts/facts-contract-parser.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { FactsStore } from "../lib/facts/facts-store.ts";

test("a parser version change forces contract entities to be re-parsed even for unchanged files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "parser-version-"));
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "parser-version-fixture", version: "1.0.0" }));
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(dir, "petstore.openapi.yaml"), petstore);
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });

		// 1. First full sync: correct entities plus the current parser stamp.
		const service = new FactsService(dir);
		await service.sync(undefined, { mode: "full" });
		const db = service.getDatabase();
		assert.ok(db?.entities.some((entity) => entity.name === "Pets"), "the fixture entities must be indexed");
		assert.equal(db?.contractParserVersion, CONTRACT_PARSER_VERSION, "the stamp must be recorded");
		service.close();

		// 2. Simulate an older parser: garbage entities plus an old stamp in the
		//    persisted store — exactly what a real parser drift would leave behind.
		const store = new FactsStore(dir);
		const persisted = await store.load();
		assert.ok(persisted, "the persisted database must exist after a full sync");
		persisted.entities = [{ id: "json-schema:legacy-noise", kind: "json-schema", name: "legacy-noise", path: "petstore.openapi.yaml" }];
		persisted.contractParserVersion = "0";
		await store.save(persisted);

		// 3. A new service in auto mode must refuse the fast path (stamp
		//    mismatch), take the full reconciliation, re-parse the unchanged
		//    contract file and heal the entities.
		const next = new FactsService(dir);
		await next.sync(undefined, { mode: "auto" });
		const healed = next.getDatabase();
		assert.ok(!healed?.entities.some((entity) => entity.name === "legacy-noise"), "stale entities from an older parser must be replaced");
		assert.ok(healed?.entities.some((entity) => entity.name === "Pets"), "the correct entities must be restored");
		assert.equal(healed?.contractParserVersion, CONTRACT_PARSER_VERSION, "the stamp must be current after the healing sync");
		next.close();
		// 4. The stamp must survive persistence for the next session.
		const persistedAfter = await new FactsStore(dir).load();
		assert.equal(persistedAfter?.contractParserVersion, CONTRACT_PARSER_VERSION, "the stamp must be persisted");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
