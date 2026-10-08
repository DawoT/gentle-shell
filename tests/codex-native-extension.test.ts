import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import registerCodexNativeExtension from "../extensions/codex-native.ts";
import { CODEX_NATIVE_PROVIDER_ID } from "../lib/codex-native/models.ts";

test("codex-native extension registers unconditionally so models appear in selectors", () => {
	// Registration is visibility; activation/credentials stay gated inside the
	// provider (lib/codex-native/provider.ts) and child selection stays gated
	// in gentle-agents. Any env shape must still register exactly once.
	for (const env of [{}, { GENTLE_CODEX_NATIVE: "0" }, { GENTLE_CODEX_NATIVE: "true" }, { GENTLE_CODEX_NATIVE: "1" }]) {
		let calls = 0;
		let registeredProvider: Provider | undefined;
		registerCodexNativeExtension(
			{
				registerProvider(provider: string | Provider) {
					assert.notEqual(typeof provider, "string");
					if (typeof provider !== "string") {
						registeredProvider = provider;
						calls++;
					}
				},
			},
			env,
		);
		assert.equal(calls, 1);
		assert.ok(registeredProvider, "Provider should be registered regardless of opt-in flag");
		assert.equal(registeredProvider.id, CODEX_NATIVE_PROVIDER_ID);
	}
});

test("codex-native extension registers provider with Pi and exposes the sol model", () => {
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

test("codex-native provider apiKey.check allows model visibility without opt-in flag", async () => {
	let registeredProvider: Provider | undefined;
	const mockPi = {
		registerProvider(provider: string | Provider) {
			if (typeof provider !== "string") registeredProvider = provider;
		},
	};

	registerCodexNativeExtension(mockPi, {});
	assert.ok(registeredProvider);
	assert.ok(registeredProvider.auth?.apiKey?.check);

	// With credential
	const withCred = await registeredProvider.auth.apiKey.check({
		ctx: { env: async () => undefined, fileExists: async () => false },
		credential: { type: "api_key", key: "codex-auth" },
		signal: new AbortController().signal,
	});
	assert.deepEqual(withCred, { source: "Codex auth.json", type: "api_key" });
});

