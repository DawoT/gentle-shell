#!/usr/bin/env node
// Advisory contention guard: runs a verification command while holding the
// shared .pi/verify.lock, and warns loudly when another verification run
// already holds it. Advisory by design: it never blocks CI patterns, it
// just makes contention visible instead of reporting false failures
// silently. See lib/verify-lock.ts for the semantics.
import { acquireVerifyLock } from "../lib/verify-lock.ts";

const command = process.argv.slice(2).join(" ");
if (!command.trim()) {
	console.error("usage: verify-lock-run.mjs <command>");
	process.exit(2);
}

const lock = await acquireVerifyLock(process.cwd(), command);
if (lock.heldByOther) {
	console.error(`WARNING: another verification run holds .pi/verify.lock (pid ${lock.owner?.pid}, started ${new Date(lock.owner?.startedAt).toISOString()}, command "${lock.owner?.command}"); results may be contended.`);
}

try {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync("sh", ["-c", command], { stdio: "inherit" });
	if (result.error) {
		console.error(String(result.error));
		process.exitCode = 1;
	} else {
		process.exitCode = result.status ?? 1;
	}
} finally {
	await lock.release();
}
