import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { smokeMcpEntrypoint } from "../scripts/smoke-facts-entrypoints.mjs";

async function tempWorkspace() {
	const dir = await mkdtemp(join(tmpdir(), "entrypoints-smoke-"));
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "smoke-fixture", version: "1.0.0" }));
	return dir;
}

test("every Facts MCP entry point loads and answers a tools/list round-trip", async () => {
	const workspace = await tempWorkspace();
	try {
		for (const bin of ["gentle-facts-mcp.mjs", "gentle-proofs-mcp.mjs"]) {
			const result = await smokeMcpEntrypoint(join(process.cwd(), "bin", bin), { workspace });
			assert.equal(result.ok, true, `${bin} smoke failed: ${result.error ?? "unknown"}`);
			assert.ok(result.tools.length >= 1, `${bin} must list at least one tool`);
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("a broken entry point fails the smoke check fast with the precise cause", async () => {
	const workspace = await tempWorkspace();
	try {
		const broken = join(workspace, "broken-bin.mjs");
		await writeFile(broken, "import { nope } from './definitely-missing-thing.ts';\nconsole.log(nope);\n");
		const result = await smokeMcpEntrypoint(broken, { workspace });
		assert.equal(result.ok, false, "a bin that cannot even load must fail the smoke check");
		assert.match(result.error ?? "", /definitely-missing-thing/, "the precise cause must surface");
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
