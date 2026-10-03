import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_NATIVE_MODELS,
	CODEX_NATIVE_PROVIDER_ID,
	findCodexNativeModel,
	getCodexNativeModels,
} from "../lib/codex-native/models.ts";

test("CODEX_NATIVE_PROVIDER_ID is codex-native", () => {
	assert.equal(CODEX_NATIVE_PROVIDER_ID, "codex-native");
});

test("models catalog contains gpt-6.1-sol with expected capabilities and reasoning map", () => {
	const model = findCodexNativeModel("gpt-6.1-sol");
	assert.ok(model, "gpt-6.1-sol should exist in catalog");
	assert.equal(model.id, "gpt-6.1-sol");
	assert.equal(model.name, "GPT-6.1 Sol");
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.contextWindow, 272_000);
	assert.equal(model.maxTokens, 128_000);
	assert.equal(model.api, "openai-responses");
	assert.deepEqual(model.thinkingLevelMap, {
		off: null,
		minimal: "low",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
});

test("models catalog contains expected flagship and workhorse models", () => {
	const ids = getCodexNativeModels().map((m) => m.id);
	assert.ok(ids.includes("gpt-6.1-sol"));
	assert.ok(ids.includes("gpt-6-astra"));
	assert.ok(ids.includes("gpt-6-sol"));
	assert.ok(ids.includes("gpt-6-luna"));
	assert.ok(ids.includes("gpt-5.6-sol"));
});

test("findCodexNativeModel returns undefined for non-existent model", () => {
	assert.equal(findCodexNativeModel("non-existent-model"), undefined);
});

test("getCodexNativeModels returns deep copies preventing mutation of catalog", () => {
	const models1 = getCodexNativeModels();
	const model = models1.find((m) => m.id === "gpt-6.1-sol")!;
	model.input.pop();

	const models2 = getCodexNativeModels();
	const modelFresh = models2.find((m) => m.id === "gpt-6.1-sol")!;
	assert.deepEqual(modelFresh.input, ["text", "image"]);
});
