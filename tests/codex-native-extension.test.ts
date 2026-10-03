import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import registerCodexNativeExtension from "../extensions/codex-native.ts";
import { CODEX_NATIVE_PROVIDER_ID } from "../lib/codex-native/models.ts";

test("codex-native extension is disabled unless explicitly opted in", () => {
	for (const env of [{}, { GENTLE_CODEX_NATIVE: "0" }, { GENTLE_CODEX_NATIVE: "true" }]) {
		let calls = 0;
		registerCodexNativeExtension({ registerProvider() { calls++; } }, env);
		assert.equal(calls, 0);
	}
});

test("codex-native extension registers provider with Pi", () => {
	let registeredProvider: Provider | undefined;
	const mockPi = {
		registerProvider(provider: string | Provider) {
			assert.notEqual(typeof provider, "string");
			if (typeof provider !== "string") registeredProvider = provider;
		},
	};

	registerCodexNativeExtension(mockPi, { GENTLE_CODEX_NATIVE: "1" });

	assert.ok(registeredProvider, "Provider should be registered");
	assert.equal(registeredProvider.id, CODEX_NATIVE_PROVIDER_ID);
	assert.equal(registeredProvider.name, "Codex Native (Daemon)");
	assert.equal(registeredProvider.baseUrl, "http://127.0.0.1:17841/v1");

	const models = registeredProvider.getModels();
	assert.ok(models.some((m) => m.id === "gpt-6.1-sol"));
});
