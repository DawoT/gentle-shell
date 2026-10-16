import assert from "node:assert/strict";
import test from "node:test";
import { pageFacts, paginationProperties } from "../lib/facts/facts-response.ts";

test("pageFacts defaults to a full 50-row page when limit is omitted", () => {
	const items = Array.from({ length: 60 }, (_, index) => `item-${index}`);
	const page = pageFacts(items, {}, (item) => item);
	assert.equal(page.details.returned, 50);
	assert.match(page.text, /item-49/, "the 50th row must be present");
	assert.doesNotMatch(page.text, /item-50/, "rows beyond the default page must wait for the continuation");
});

test("pageFacts keeps explicit limits and the 50-row guard", () => {
	const items = Array.from({ length: 60 }, (_, index) => `item-${index}`);
	assert.equal(pageFacts(items, { limit: 10 }, (item) => item).details.returned, 10);
	assert.equal(pageFacts(items, { limit: 50 }, (item) => item).details.returned, 50);
	assert.throws(() => pageFacts(items, { limit: 51 }, (item) => item), /limit/);
});

test("pagination schema documents the 50-row default", () => {
	assert.match(String((paginationProperties.limit as { description: string }).description), /default 50/);
});
