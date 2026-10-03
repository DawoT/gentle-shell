// S1 (U1) facts-informed-review: advisory recurrence ledger with fix receipts.
//
// Presentation-only persistence for native review advisory findings. It never
// suppresses or alters provider content; it only records which findings were
// seen under which changed-path manifest so the closure mapping can annotate
// recurring findings and emit fix receipts.
//
// Storage mirrors the FactsStore lock+generation PATTERN (writer lock +
// content-addressed immutable generation + replaceable pointer) with its own
// schema — deliberately NOT the FactsDatabase-typed class. A corrupt or empty
// pointer fails closed to an empty ledger and the next write rebuilds it
// (motivated by the 0-byte corrupt lock incident).
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFactsWriterLock } from "./facts/facts-lock.ts";

export const MAX_REVIEW_ADVISORY_LEDGER_ENTRIES = 500;

const LEDGER_FORMAT = "review-advisory-ledger-pointer-v1";
const GENERATION_FORMAT = "review-advisory-ledger-generation-v1";
const GENERATION_DIGEST = /^[a-f0-9]{64}$/;

export interface ReviewAdvisoryLedgerFindingInput {
	id: string;
	lens?: string;
	location?: string;
}

export interface ReviewAdvisoryLedgerEntry {
	key: string;
	lens: string;
	findingId: string;
	location: string;
	changedPathManifestSha256: string;
	firstSeenAt: number;
	lastSeenAt: number;
	occurrences: number;
	status: "open" | "fixed";
	fixedAt?: number;
	fixedManifestSha256?: string;
}

export interface ReviewAdvisoryLedgerFixReceipt {
	key: string;
	lens: string;
	findingId: string;
	location: string;
	priorChangedPathManifestSha256: string;
	status: "fixed";
	fixedAt: number;
	fixedManifestSha256: string;
}

export interface ReviewAdvisoryRecordResult {
	recorded: readonly ReviewAdvisoryLedgerEntry[];
	/** Entries that already existed under a PRIOR manifest before this record. */
	recurring: readonly ReviewAdvisoryLedgerEntry[];
}

export function isLedgerRecord(value: unknown): value is ReviewAdvisoryLedgerEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.key === "string" && entry.key.length > 0
		&& typeof entry.lens === "string"
		&& typeof entry.findingId === "string" && entry.findingId.length > 0
		&& typeof entry.location === "string"
		&& typeof entry.changedPathManifestSha256 === "string"
		&& Number.isSafeInteger(entry.firstSeenAt)
		&& Number.isSafeInteger(entry.lastSeenAt)
		&& Number.isSafeInteger(entry.occurrences) && (entry.occurrences as number) >= 1
		&& (entry.status === "open" || entry.status === "fixed")
		&& (entry.fixedAt === undefined || Number.isSafeInteger(entry.fixedAt))
		&& (entry.fixedManifestSha256 === undefined || typeof entry.fixedManifestSha256 === "string");
}

interface PointerFile {
	format: typeof LEDGER_FORMAT;
	generation: string;
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Identity of a finding across manifests: the key without the manifest sha. */
function findingPrefix(lens: string, findingId: string, location: string): string {
	return `${lens}|${findingId}|${location}|`;
}

function manifestShaOrEmpty(value: string): string {
	return GENERATION_DIGEST.test(value) ? value : "";
}

/**
 * Dedup key. Dedup on id alone is unsafe: the same provider id can recur for
 * different locations and different trees, so the key binds lens, finding id,
 * location and the frozen changed-path manifest digest. `manifestSha` may be
 * "" when the closure variant carries no frozen manifest; ""-keyed entries are
 * recorded but excluded from cross-manifest recurrence and fix comparison
 * (documented S1 behavior — there is no tree identity to compare against).
 */
export function reviewAdvisoryLedgerKey(finding: ReviewAdvisoryLedgerFindingInput, manifestSha: string): string {
	return `${finding.lens ?? ""}|${finding.id}|${finding.location ?? ""}|${manifestShaOrEmpty(manifestSha)}`;
}

export class ReviewAdvisoryLedgerStore {
	private readonly storageDir: string;
	private readonly pointerPath: string;
	private readonly generationsDir: string;

	constructor(repoRoot: string, dirName = ".pi") {
		this.storageDir = join(repoRoot, dirName, "review-advisory-ledger");
		this.pointerPath = join(this.storageDir, "ledger.json");
		this.generationsDir = join(this.storageDir, "ledger-data", "generations");
	}

	// Same key derivation as the module function, exposed for tests and callers
	// that need key stability guarantees without touching storage.
	entryKey(finding: ReviewAdvisoryLedgerFindingInput, manifestSha: string): string {
		return reviewAdvisoryLedgerKey(finding, manifestSha);
	}

	/**
	 * Record findings seen under `manifestSha`. Findings already open under the
	 * same manifest dedup (no recurrence inflation); entries last seen under a
	 * prior manifest recur. Returns the upserted entries and the recurring set.
	 */
	async recordFindings(
		manifestSha: string,
		findings: readonly ReviewAdvisoryLedgerFindingInput[],
		signal?: AbortSignal,
	): Promise<ReviewAdvisoryRecordResult> {
		const sha = manifestShaOrEmpty(manifestSha);
		const now = Date.now();
		const recorded: ReviewAdvisoryLedgerEntry[] = [];
		const recurring: ReviewAdvisoryLedgerEntry[] = [];
		try {
			await this.withLockedLedger(signal, (entries) => {
				for (const finding of findings) {
					const lens = finding.lens ?? "";
					const location = finding.location ?? "";
					const key = reviewAdvisoryLedgerKey(finding, sha);
					const existing = entries.get(key);
					if (existing !== undefined) {
						// Same-manifest repetition is dedup, not recurrence: only a
						// PRIOR manifest re-sighted now proves recurrence.
						existing.lastSeenAt = now;
						recorded.push(existing);
						continue;
					}
					const prefix = findingPrefix(lens, finding.id, location);
					const prior = [...entries.values()]
						.filter((entry) => entry.key.startsWith(prefix) && entry.changedPathManifestSha256 !== sha)
						.sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
					if (prior !== undefined && sha !== "") {
						// Same finding re-sighted under a new tree: migrate the entry
						// to the new manifest key, preserving firstSeenAt and count.
						entries.delete(prior.key);
						prior.key = key;
						prior.changedPathManifestSha256 = sha;
						prior.occurrences += 1;
						prior.lastSeenAt = now;
						entries.set(key, prior);
						recurring.push(prior);
						recorded.push(prior);
						continue;
					}
					const fresh: ReviewAdvisoryLedgerEntry = {
						key,
						lens,
						findingId: finding.id,
						location,
						changedPathManifestSha256: sha,
						firstSeenAt: now,
						lastSeenAt: now,
						occurrences: 1,
						status: "open",
					};
					entries.set(key, fresh);
					recorded.push(fresh);
				}
				evictLRU(entries);
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			// Fail closed: a ledger failure must never surface into review
			// mapping. Callers receive the entries recorded before the failure.
		}
		return { recorded, recurring };
	}

	/**
	 * Emit fix receipts for open entries recorded under a PRIOR manifest whose
	 * lens|id|location is absent now AND whose location still appears among the
	 * new manifest's finding locations (path-persisted check: a file that left
	 * the diff entirely did not get "fixed", it left the review scope).
	 * ""-manifest entries are skipped — no tree identity to compare against.
	 */
	async markFixedIfAbsent(
		manifestSha: string,
		findings: readonly ReviewAdvisoryLedgerFindingInput[],
		signal?: AbortSignal,
	): Promise<ReviewAdvisoryLedgerFixReceipt[]> {
		const sha = manifestShaOrEmpty(manifestSha);
		if (sha === "") return [];
		const now = Date.now();
		const receipts: ReviewAdvisoryLedgerFixReceipt[] = [];
		try {
			await this.withLockedLedger(signal, (entries) => {
				const currentIdentities = new Set(findings.map((finding) => findingPrefix(finding.lens ?? "", finding.id, finding.location ?? "")));
				const currentLocations = new Set(findings.map((finding) => finding.location ?? ""));
				for (const entry of entries.values()) {
					if (entry.status !== "open") continue;
					if (entry.changedPathManifestSha256 === "" || entry.changedPathManifestSha256 === sha) continue;
					if (entry.location === "" || !currentLocations.has(entry.location)) continue;
					// Path persisted but the exact finding is gone: a fix receipt.
					if (currentIdentities.has(findingPrefix(entry.lens, entry.findingId, entry.location))) continue;
					entry.status = "fixed";
					entry.fixedAt = now;
					entry.fixedManifestSha256 = sha;
					receipts.push({
						key: entry.key,
						lens: entry.lens,
						findingId: entry.findingId,
						location: entry.location,
						priorChangedPathManifestSha256: entry.changedPathManifestSha256,
						status: "fixed",
						fixedAt: now,
						fixedManifestSha256: sha,
					});
				}
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			// Fail closed: no receipts rather than a thrown ledger error.
		}
		return receipts;
	}

	/** Snapshot of the ledger, oldest-createdAt entries first. Empty on any read failure (fail closed). */
	async getLedger(signal?: AbortSignal): Promise<readonly ReviewAdvisoryLedgerEntry[]> {
		try {
			let snapshot: ReviewAdvisoryLedgerEntry[] = [];
			await this.withLockedLedger(signal, (entries) => {
				snapshot = [...entries.values()].map((entry) => ({ ...entry }));
			});
			return snapshot;
		} catch (error) {
			if (signal?.aborted) throw error;
			return [];
		}
	}

	/** Lock + generation publish around a read-modify-write of the entry map. */
	private async withLockedLedger(
		signal: AbortSignal | undefined,
		mutate: (entries: Map<string, ReviewAdvisoryLedgerEntry>) => void,
	): Promise<void> {
		signal?.throwIfAborted();
		await withFactsWriterLock(this.storageDir, async () => {
			const entries = await this.loadLocked(signal);
			mutate(entries);
			await this.publishLocked(entries, signal);
		}, signal);
	}

	/** Corrupt, empty or unreadable state fails closed to an empty ledger. */
	private async loadLocked(signal?: AbortSignal): Promise<Map<string, ReviewAdvisoryLedgerEntry>> {
		const entries = new Map<string, ReviewAdvisoryLedgerEntry>();
		let raw: string;
		try {
			raw = await readFile(this.pointerPath, "utf8");
		} catch {
			return entries; // missing ledger — start empty
		}
		signal?.throwIfAborted();
		try {
			const pointer = JSON.parse(raw) as PointerFile;
			if (pointer?.format !== LEDGER_FORMAT || typeof pointer.generation !== "string" || !GENERATION_DIGEST.test(pointer.generation)) {
				return entries;
			}
			const text = await readFile(join(this.generationsDir, `${pointer.generation}.json`), "utf8");
			if (digest(text) !== pointer.generation) return entries;
			const parsed = JSON.parse(text) as { format?: unknown; entries?: unknown };
			if (parsed?.format !== GENERATION_FORMAT || !Array.isArray(parsed.entries)) return entries;
			for (const value of parsed.entries) {
				if (!isLedgerRecord(value)) return entries;
				entries.set(value.key, value);
			}
			return entries;
		} catch {
			return entries;
		}
	}

	/** Immutable generation published before the replaceable pointer (Facts pattern). */
	private async publishLocked(entries: Map<string, ReviewAdvisoryLedgerEntry>, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const ordered = [...entries.values()];
		const body = JSON.stringify({ format: GENERATION_FORMAT, entries: ordered });
		const generation = digest(body);
		const generationPath = join(this.generationsDir, `${generation}.json`);
		await mkdir(this.generationsDir, { recursive: true });
		try {
			await writeFile(generationPath, body, { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const pointer = JSON.stringify({ format: LEDGER_FORMAT, generation } satisfies PointerFile);
		await mkdir(dirname(this.pointerPath), { recursive: true });
		const staging = join(this.storageDir, `ledger.json.${generation.slice(0, 8)}.tmp`);
		await writeFile(staging, pointer, { flag: "wx" });
		await rename(staging, this.pointerPath);
		// Stale generations are content-addressed and harmless; the pointer is
		// the only authority, so no garbage collection is required for safety.
		void rm;
	}
}

function evictLRU(entries: Map<string, ReviewAdvisoryLedgerEntry>): void {
	if (entries.size <= MAX_REVIEW_ADVISORY_LEDGER_ENTRIES) return;
	const ordered = [...entries.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
	for (const entry of ordered.slice(0, entries.size - MAX_REVIEW_ADVISORY_LEDGER_ENTRIES)) {
		entries.delete(entry.key);
	}
}
