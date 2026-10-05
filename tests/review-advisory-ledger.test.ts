// S1 (U1) advisory ledger — behavior tests, written RED-first (facts-informed-review).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MAX_REVIEW_ADVISORY_LEDGER_ENTRIES,
	type ReviewAdvisoryLedgerEntry,
	ReviewAdvisoryLedgerStore,
	isLedgerRecord,
} from "../lib/review-advisory-ledger.ts";

function fixture(t: { after(fn: () => void): unknown }): string {
	const root = mkdtempSync(join(tmpdir(), "review-advisory-ledger-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

const { createHash } = await import("node:crypto");
const shaOf = (n: number | string) => createHash("sha256").update(String(n)).digest("hex");

function finding(id: string, location: string, lens = "review-risk") {
	return { id, lens, location };
}

test("dedup key is stable across lens, finding id, location and manifest sha", (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	const key = store.entryKey(finding("A1", "src/a.ts"), shaOf("a"));
	assert.equal(key, `review-risk|A1|src/a.ts|${shaOf("a")}`);
	assert.equal(store.entryKey(finding("A1", "src/a.ts"), shaOf("b")) !== key, true);
});

test("native and bare manifest digests share keys, occurrences and fix identity", async (t) => {
	const store = new ReviewAdvisoryLedgerStore(fixture(t));
	const a = shaOf("native-a");
	const b = shaOf("native-b");
	const item = finding("A1", "src/a.ts");
	assert.equal(store.entryKey(item, `sha256:${a}`), store.entryKey(item, a));
	const first = await store.recordFindings(`sha256:${a}`, [item]);
	assert.equal(first.recorded[0]?.changedPathManifestSha256, a);
	const same = await store.recordFindings(a, [item]);
	assert.equal(same.recorded[0]?.occurrences, 1);
	assert.equal(same.recurring.length, 0);
	assert.deepEqual(await store.markFixedIfAbsent(`sha256:${a}`, [finding("B1", "src/a.ts")]), []);
	const next = await store.recordFindings(`sha256:${b}`, [item]);
	assert.equal(next.recurring[0]?.occurrences, 2);
	assert.equal(next.recorded[0]?.changedPathManifestSha256, b);
	const receipts = await store.markFixedIfAbsent(`sha256:${a}`, [finding("B1", "src/a.ts")]);
	assert.equal(receipts[0]?.priorChangedPathManifestSha256, b);
	assert.equal(receipts[0]?.fixedManifestSha256, a);
	assert.equal((await store.getLedger())[0]?.status, "fixed");
});

test("malformed and unknown manifests cannot prove recurrence or fixes", async (t) => {
	const store = new ReviewAdvisoryLedgerStore(fixture(t));
	const sha = shaOf("valid");
	const item = finding("A1", "src/a.ts");
	for (const invalid of ["", `SHA256:${sha}`, `sha256:${sha.toUpperCase()}`, ` sha256:${sha}`, `sha256:${sha}\n`, `sha256:${sha.slice(1)}`, `${sha}x`]) {
		assert.equal(store.entryKey(item, invalid), "review-risk|A1|src/a.ts|");
		await store.recordFindings(invalid, [item]);
		assert.deepEqual(await store.markFixedIfAbsent(invalid, [finding("B1", "src/a.ts")]), []);
	}
	const valid = await store.recordFindings(`sha256:${sha}`, [item]);
	assert.equal(valid.recurring.length, 0);
	assert.equal(valid.recorded[0]?.occurrences, 1);
	const snapshot = await store.getLedger();
	assert.equal(snapshot.length, 2);
	assert.equal(snapshot.find((entry) => entry.changedPathManifestSha256 === "")?.occurrences, 1);
	assert.deepEqual(await store.markFixedIfAbsent(shaOf("later"), [finding("B1", "src/a.ts")]).then((receipts) => receipts.map((receipt) => receipt.priorChangedPathManifestSha256)), [sha]);
});

test("records findings and flags recurrence across two manifests", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	const first = await store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts")]);
	assert.equal(first.recorded.length, 1);
	assert.equal(first.recurring.length, 0);
	const second = await store.recordFindings(shaOf("2"), [finding("A1", "src/a.ts")]);
	assert.equal(second.recorded.length, 1);
	assert.equal(second.recurring.length, 1);
	assert.equal(second.recurring[0]?.occurrences, 2);
	const snapshot = await store.getLedger();
	assert.equal(snapshot.length, 1);
	assert.equal(snapshot[0]?.status, "open");
	assert.ok(snapshot[0]?.firstSeenAt <= snapshot[0]!.lastSeenAt);
});

test("same manifest re-record does not inflate occurrences as cross-manifest recurrence", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	await store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts")]);
	const again = await store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts")]);
	assert.equal(again.recorded.length, 1);
	// Same-manifest repetition is dedup, not recurrence evidence.
	assert.equal(again.recurring.length, 0);
	const snapshot = await store.getLedger();
	assert.equal(snapshot[0]?.occurrences, 1);
});

test("marks fixed when a finding disappears while its location persists in the new manifest", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	await store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts"), finding("A2", "src/a.ts")]);
	const receipts = await store.markFixedIfAbsent(shaOf("2"), [finding("A2", "src/a.ts")]);
	assert.equal(receipts.length, 1);
	assert.equal(receipts[0]?.findingId, "A1");
	assert.equal(receipts[0]?.status, "fixed");
	assert.equal(receipts[0]?.fixedManifestSha256, shaOf("2"));
	const snapshot = await store.getLedger();
	assert.equal(snapshot.find((entry) => entry.findingId === "A1")?.status, "fixed");
	assert.equal(snapshot.find((entry) => entry.findingId === "A2")?.status, "open");
});

test("does not emit a false fix receipt when the location left the manifest entirely", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	await store.recordFindings(shaOf("1"), [finding("A1", "src/deleted.ts")]);
	// src/deleted.ts is absent from the new finding set: the file left the
	// diff, so its absence is not evidence the finding was fixed.
	const receipts = await store.markFixedIfAbsent(shaOf("2"), [finding("B9", "src/other.ts")]);
	assert.equal(receipts.length, 0);
	const snapshot = await store.getLedger();
	assert.equal(snapshot[0]?.status, "open");
});

test("corrupt or empty ledger file fails closed and rebuilds empty", async (t) => {
	const root = fixture(t);
	const ledgerDir = join(root, ".pi", "review-advisory-ledger");
	const { mkdirSync } = await import("node:fs");
	mkdirSync(ledgerDir, { recursive: true });
	writeFileSync(join(ledgerDir, "ledger.json"), "");
	const store = new ReviewAdvisoryLedgerStore(root);
	assert.deepEqual(await store.getLedger(), []);
	const recorded = await store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts")]);
	assert.equal(recorded.recorded.length, 1);
	const fresh = new ReviewAdvisoryLedgerStore(root);
	const snapshot = await fresh.getLedger();
	assert.equal(snapshot.length, 1);
	assert.equal(isLedgerRecord(snapshot[0]), true);
});

test("concurrent writes through two store instances serialize without loss", async (t) => {
	const root = fixture(t);
	const a = new ReviewAdvisoryLedgerStore(root);
	const b = new ReviewAdvisoryLedgerStore(root);
	await Promise.all([
		a.recordFindings(shaOf("a"), [finding("A1", "src/a.ts")]),
		b.recordFindings(shaOf("b"), [finding("B1", "src/b.ts")]),
		await Promise.resolve().then(() => a.recordFindings(shaOf("a2"), [finding("A2", "src/a2.ts")])),
	]);
	const snapshot = await new ReviewAdvisoryLedgerStore(root).getLedger();
	const ids = snapshot.map((entry) => entry.findingId).sort();
	assert.deepEqual(ids, ["A1", "A2", "B1"]);
});

test("ledger evicts least recently seen entries beyond the cap", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	const total = MAX_REVIEW_ADVISORY_LEDGER_ENTRIES + 5;
	for (let index = 0; index < total; index += 1) {
		await store.recordFindings(shaOf(index), [finding(`F${index}`, `src/${index}.ts`)]);
	}
	const snapshot = await store.getLedger();
	assert.equal(snapshot.length, MAX_REVIEW_ADVISORY_LEDGER_ENTRIES);
	// Oldest manifests were evicted, newest survive.
	assert.equal(snapshot.some((entry) => entry.findingId === "F0"), false);
	assert.equal(snapshot.some((entry) => entry.findingId === `F${total - 1}`), true);
});

test("abort signal stops a pending ledger operation", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		store.recordFindings(shaOf("1"), [finding("A1", "src/a.ts")], controller.signal),
		(Error),
	);
});

test("empty manifest sha entries are recorded but excluded from fix comparison", async (t) => {
	const root = fixture(t);
	const store = new ReviewAdvisoryLedgerStore(root);
	await store.recordFindings("", [finding("A1", "src/a.ts")]);
	const receipts = await store.markFixedIfAbsent(shaOf("2"), [finding("B9", "src/a.ts")]);
	assert.equal(receipts.length, 0);
});
