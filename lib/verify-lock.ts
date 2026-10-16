import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Advisory verification lock. Concurrent verification runs over the same
 * tree/ledger (suite + GENTLE_PROOFS pass) produce spurious failures that
 * erode trust in results; this lock reports the contention loudly instead
 * of blocking, so CI patterns never deadlock. Best-effort by design: the
 * create race resolves to "heldByOther" and a stale lock older than the
 * TTL is taken over, never honored.
 */

export interface VerifyLockOwner {
	pid: number;
	startedAt: number;
	command: string;
}

export interface VerifyLock {
	heldByOther: boolean;
	owner?: VerifyLockOwner;
	release(): Promise<void>;
}

const LOCK_TTL_MS = 30 * 60 * 1000;

function lockPath(root: string): string {
	return join(root, ".pi", "verify.lock");
}

function readOwner(text: string): VerifyLockOwner | null {
	try {
		const owner = JSON.parse(text);
		if (owner && typeof owner.pid === "number" && typeof owner.startedAt === "number" && typeof owner.command === "string") {
			return owner;
		}
	} catch {
		// Unparsable lock content is treated as stale by the caller.
	}
	return null;
}

export async function acquireVerifyLock(root: string, command: string): Promise<VerifyLock> {
	const path = lockPath(root);
	await mkdir(join(root, ".pi"), { recursive: true });
	const mine: VerifyLockOwner = { pid: process.pid, startedAt: Date.now(), command };
	let existed = false;
	try {
		await writeFile(path, JSON.stringify(mine), { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		existed = true;
	}
	if (existed) {
		const text = await readFile(path, "utf8").catch(() => "");
		const owner = readOwner(text);
		if (owner && Date.now() - owner.startedAt < LOCK_TTL_MS) {
			return { heldByOther: true, owner, release: async () => {} };
		}
		await writeFile(path, JSON.stringify(mine));
	}
	return {
		heldByOther: false,
		owner: mine,
		release: async () => {
			const current = await readFile(path, "utf8").catch(() => "");
			const owner = readOwner(current);
			if (owner?.pid === process.pid) await rm(path, { force: true });
		},
	};
}
