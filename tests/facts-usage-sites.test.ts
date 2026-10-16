import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsService } from "../lib/facts/facts-service.ts";

test("queryUsageSites finds referencing files and marks recorded imports", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usage-sites-"));
	try {
		await writeFile(join(dir, "package.json"), JSON.stringify({ name: "usages-fixture", version: "1.0.0" }));
		await writeFile(join(dir, "helper.ts"), "export function helper(value: number): number { return value * 2; }\n");
		await writeFile(join(dir, "main.ts"), "import { helper } from './helper.ts';\nexport const doubled = helper(21);\n");
		await writeFile(join(dir, "loose.ts"), "export const also = helper + 1;\n");
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "T"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
		const service = new FactsService(dir);
		await service.sync(undefined, { mode: "full" });
		const sites = service.queryUsageSites("helper");
		const byFile = new Map(sites.map((site) => [site.file, site]));
		assert.ok(byFile.has("main.ts"), "main.ts must be a usage site");
		assert.equal(byFile.get("main.ts")?.importsDeclaration, true, "main.ts imports the declaring file");
		assert.ok(byFile.has("loose.ts"), "loose.ts references the name without importing it");
		assert.equal(byFile.get("loose.ts")?.importsDeclaration, false, "loose.ts has no recorded import");
		assert.equal(sites.some((site) => site.file === "helper.ts"), false, "the declaring file is not its own usage site");
		assert.deepEqual(service.queryUsageSites("definitely-missing-symbol"), []);
		service.close();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
