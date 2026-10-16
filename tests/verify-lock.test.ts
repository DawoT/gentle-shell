import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireVerifyLock } from "../lib/verify-lock.ts";

test("a fresh directory acquires the lock; a second concurrent acquire reports the holder", async () => {
	const dir = await mkdtemp(join(tmpdir(), "verify-lock-"));
	try {
		const first = await acquireVerifyLock(dir, "suite A");
		assert.equal(first.heldByOther, false);
		const second = await acquireVerifyLock(dir, "suite B");
		assert.equal(second.heldByOther, true, "the lock is advisory: it must report, not block");
		assert.equal(second.owner?.pid, process.pid);
		assert.match(second.owner?.command ?? "", /suite A/);
		await first.release();
		await second.release();
		const third = await acquireVerifyLock(dir, "suite C");
		assert.equal(third.heldByOther, false, "after the real owner releases, the lock is free");
		await third.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stale lock older than the TTL is taken over, not honored", async () => {
	const dir = await mkdtemp(join(tmpdir(), "verify-lock-"));
	try {
		const stalePath = join(dir, ".pi", "verify.lock");
		await mkdir(join(dir, ".pi"), { recursive: true });
		await writeFile(stalePath, JSON.stringify({ pid: 999999, startedAt: Date.now() - 60 * 60 * 1000, command: "ancient run" }));
		const lock = await acquireVerifyLock(dir, "new suite");
		assert.equal(lock.heldByOther, false, "a stale lock must be taken over");
		assert.equal(lock.owner?.command, "new suite");
		await lock.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("a stale handle cannot release someone else's lock", async () => {
	const dir = await mkdtemp(join(tmpdir(), "verify-lock-"));
	try {
		const first = await acquireVerifyLock(dir, "real owner");
		const staleHandle = await acquireVerifyLock(dir, "latecomer");
		assert.equal(staleHandle.heldByOther, true);
		await staleHandle.release();
		const still = await acquireVerifyLock(dir, "observer");
		assert.equal(still.heldByOther, true, "the latecomer's release must not free the real owner's lock");
		await first.release();
		const after = await acquireVerifyLock(dir, "next");
		assert.equal(after.heldByOther, false);
		await after.release();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
