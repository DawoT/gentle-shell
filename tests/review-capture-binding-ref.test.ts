import assert from "node:assert/strict";
import test from "node:test";
import { parseCollectBindingRefSlot, resolveBindingRef, type ReviewCaptureBindingRefOutcome, type ReviewCaptureBindingRefSuccess } from "../lib/review-capture-binding-ref.ts";

// strict:false disables discriminated-union narrowing; these helpers assert
// and cast explicitly.
function expectOk(outcome: ReviewCaptureBindingRefOutcome): ReviewCaptureBindingRefSuccess {
	assert.ok(outcome.ok);
	return outcome as ReviewCaptureBindingRefSuccess;
}
function expectFail(outcome: ReviewCaptureBindingRefOutcome): { reason: string } {
	assert.ok(!outcome.ok);
	return outcome as { reason: string };
}

const RETAINED = ['{"name":"risk"}', '{"name":"resilience"}', '{"name":"readability"}'];
const LINEAGE = "lineage-a";

test("bindingRef resolves to the exact retained collectBinding element", () => {
	const outcome = expectOk(resolveBindingRef(RETAINED, LINEAGE, LINEAGE, 1));
	// Byte-exact: the resolved value IS the retained provider-issued string.
	assert.equal(outcome.binding, RETAINED[1]);
	assert.equal(typeof outcome.binding, "string");
	assert.equal(outcome.binding.length, RETAINED[1]!.length);
	assert.equal(JSON.parse(outcome.binding).name, "resilience");
	// Reference semantics: the returned binding is the same retained array
	// element (string primitives compare by value; the module never rebuilds,
	// re-serializes, or composes the binding).
	assert.equal(RETAINED.indexOf(outcome.binding), 1);
});

test("bindingRef resolves index 0 and the last slot", () => {
	for (const slot of [0, 2]) {
		const outcome = expectOk(resolveBindingRef(RETAINED, LINEAGE, LINEAGE, slot));
		assert.equal(outcome.binding, RETAINED[slot]);
	}
});

test("bindingRef fails closed on out-of-range slot", () => {
	const outcome = expectFail(resolveBindingRef(RETAINED, LINEAGE, LINEAGE, 3));
	assert.match(outcome.reason, /out of range/);
	const negative = expectFail(resolveBindingRef(RETAINED, LINEAGE, LINEAGE, -1));
	assert.match(negative.reason, /non-negative/);
});

test("bindingRef fails closed on non-integer slot", () => {
	for (const slot of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const outcome = expectFail(resolveBindingRef(RETAINED, LINEAGE, LINEAGE, slot));
		assert.match(outcome.reason, /integer/);
	}
});

test("bindingRef fails closed on retained-STATUS lineage mismatch", () => {
	const outcome = expectFail(resolveBindingRef(RETAINED, "lineage-b", LINEAGE, 0));
	assert.match(outcome.reason, /lineage/);
});

test("bindingRef fails closed when the retained lineage id is missing", () => {
	const outcome = expectFail(resolveBindingRef(RETAINED, undefined, LINEAGE, 0));
	assert.match(outcome.reason, /lineage/);
});

test("bindingRef fails closed when no retained bindings exist", () => {
	const outcome = expectFail(resolveBindingRef([], LINEAGE, LINEAGE, 0));
	assert.match(outcome.reason, /retained bound STATUS with collect bindings/);
});

test("parseCollectBindingRefSlot accepts only the compact ref object", () => {
	assert.equal(parseCollectBindingRefSlot({ bindingRef: 2 }), 2);
	assert.equal(parseCollectBindingRefSlot({ bindingRef: 0 }), 0);
	assert.equal(parseCollectBindingRefSlot("full binding"), undefined);
	assert.equal(parseCollectBindingRefSlot({ collectBinding: "x" }), undefined);
	assert.equal(parseCollectBindingRefSlot({ name: "risk", schema: "s" }), undefined);
	// Malformed ref objects fail closed at parse time.
	assert.throws(() => parseCollectBindingRefSlot({ bindingRef: 1.5 }), /non-negative integer/);
	assert.throws(() => parseCollectBindingRefSlot({ bindingRef: "0" }), /non-negative integer/);
	assert.throws(() => parseCollectBindingRefSlot({ bindingRef: -3 }), /non-negative integer/);
	assert.throws(() => parseCollectBindingRefSlot({ bindingRef: 0, extra: true }), /exactly one bindingRef key/);
});
