import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/**
 * Source stamps make extension staleness visible: the session extension
 * hashes its own source at load time, and facts_status re-hashes it on
 * disk, so "the working tree changed since /reload" is reported instead of
 * misdiagnosed as broken behavior. Shared by the MCP and session paths.
 */

/** Short hex stamp of a source file's current content; throws if unreadable. */
export async function sourceStamp(filePath: string): Promise<string> {
	return createHash("sha256").update(await readFile(filePath)).digest("hex").slice(0, 12);
}

/** Synchronous variant for load-time capture (the extension registers synchronously). */
export function syncSourceStamp(filePath: string): string {
	try {
		return createHash("sha256").update(readFileSync(filePath)).digest("hex").slice(0, 12);
	} catch {
		return "unavailable";
	}
}

/** True when the file's current content no longer matches the recorded stamp. */
export async function isSourceStale(stamp: string, filePath: string): Promise<boolean> {
	try {
		return (await sourceStamp(filePath)) !== stamp;
	} catch {
		return true;
	}
}
