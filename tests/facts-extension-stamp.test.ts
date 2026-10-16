import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSourceStale, sourceStamp, syncSourceStamp } from "../lib/facts/facts-extension-stamp.ts";

test("a source stamp is stable while the file is unchanged and stale after any edit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extension-stamp-"));
	const filePath = join(dir, "extension.ts");
	try {
		await writeFile(filePath, "export const version = 1;\n");
		const stamp = await sourceStamp(filePath);
		assert.match(stamp, /^[a-f0-9]{12}$/, "the stamp is a short hex prefix");
		assert.equal(await isSourceStale(stamp, filePath), false, "an unchanged file is not stale");
		await writeFile(filePath, "export const version = 2;\n");
		assert.equal(await isSourceStale(stamp, filePath), true, "any content change makes the stamp stale");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("an unreadable source reports staleness instead of throwing", async () => {
	const missing = join(tmpdir(), "extension-stamp-missing", "nope.ts");
	assert.equal(await isSourceStale("aaaaaaaaaaaa", missing), true, "a missing file cannot match any stamp");
});

test("syncSourceStamp matches the async variant for load-time capture", async () => {
	const dir = await mkdtemp(join(tmpdir(), "extension-stamp-sync-"));
	const filePath = join(dir, "extension.ts");
	try {
		await writeFile(filePath, "export const a = 1;\n");
		const sync = syncSourceStamp(filePath);
		assert.match(sync, /^[a-f0-9]{12}$/);
		assert.equal(sync, await sourceStamp(filePath));
		assert.equal(syncSourceStamp(join(dir, "missing.ts")), "unavailable");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
