// S1 (review-pipeline-hardening): pure binding-reference resolution for the
// gentle_review_capture / gentle_review_capture_group facade. A caller may pass
// the compact {"bindingRef": N} object instead of re-transcribing 5-8KB of
// provider-issued binding JSON. Resolution is BYTE-EXACT by construction: the
// resolved value is the retained provider-issued binding string itself, never
// a reconstructed, re-serialized, or composed copy. Validation of the resolved
// binding always remains downstream (parseCanonicalReviewCaptureBinding plus
// the exact-match stale check), exactly as for a full-JSON submission.

export interface ReviewCaptureBindingRefSuccess {
	ok: true;
	/** The retained provider-issued binding string, byte-exact. */
	binding: string;
	/** The resolved index into the retained collectBindings array. */
	index: number;
}

export interface ReviewCaptureBindingRefFailure {
	ok: false;
	/** Refusal reason surfaced through the existing capture-binding-rejected envelope. */
	reason: string;
}

export type ReviewCaptureBindingRefOutcome = ReviewCaptureBindingRefSuccess | ReviewCaptureBindingRefFailure;

/**
 * Resolves a 0-based bindingRef against the collectBindings of the most recent
 * bound STATUS retained for the requested lineage. Fails closed on a missing
 * retained STATUS, a lineage mismatch, or an out-of-range / non-integer slot.
 * The success binding is the retained array element itself (string primitives:
 * value identity equals byte identity; no copy or re-serialization happens).
 */
export function resolveBindingRef(
	retainedBindings: readonly string[],
	retainedLineageId: string | undefined,
	requestedLineageId: string,
	slot: number,
): ReviewCaptureBindingRefOutcome {
	if (!Array.isArray(retainedBindings) || retainedBindings.length === 0) {
		return { ok: false, reason: "bindingRef requires a retained bound STATUS with collect bindings, but none is retained" };
	}
	if (typeof retainedLineageId !== "string" || retainedLineageId.length === 0 || retainedLineageId !== requestedLineageId) {
		return { ok: false, reason: `bindingRef retained STATUS belongs to lineage ${retainedLineageId ?? "<none>"}, not requested lineage ${requestedLineageId}` };
	}
	if (!Number.isSafeInteger(slot)) {
		return { ok: false, reason: "bindingRef must be an integer" };
	}
	if (slot < 0) {
		return { ok: false, reason: "bindingRef must be a non-negative integer" };
	}
	if (slot >= retainedBindings.length) {
		return { ok: false, reason: `bindingRef ${slot} is out of range for ${retainedBindings.length} retained collectBindings` };
	}
	return { ok: true, binding: retainedBindings[slot]!, index: slot };
}

/**
 * Classifies one capture input slot. Returns the 0-based slot for the compact
 * {"bindingRef": N} object form, or undefined when the value is a full
 * collectBinding (string or object) that keeps the unchanged existing path.
 * A malformed ref object fails closed with a parse-time error rather than
 * falling through to the full-binding path.
 */
export function parseCollectBindingRefSlot(value: unknown): number | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!Object.prototype.hasOwnProperty.call(record, "bindingRef")) return undefined;
	if (Object.keys(record).length !== 1) {
		throw new Error("bindingRef must be an object with exactly one bindingRef key");
	}
	const slot = record.bindingRef;
	if (typeof slot !== "number" || !Number.isSafeInteger(slot) || slot < 0) {
		throw new Error("bindingRef must be a non-negative integer");
	}
	return slot;
}
