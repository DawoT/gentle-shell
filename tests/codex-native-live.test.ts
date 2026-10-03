import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { existsSync } from "node:fs";
import { getDefaultCodexAuthPath } from "../lib/codex-native/auth.ts";
import { createCodexNativeProvider } from "../lib/codex-native/provider.ts";

test("live integration with local daemon: gpt-6.1-sol streams output", {
	skip: process.env.GENTLE_CODEX_NATIVE !== "1" || process.env.GENTLE_CODEX_NATIVE_LIVE !== "1",
	timeout: 15_000,
}, async (t) => {
	const deadline = AbortSignal.timeout(10_000);
	const authPath = getDefaultCodexAuthPath();
	if (!existsSync(authPath)) {
		t.skip("Skipping live integration test: auth.json not found");
		return;
	}

	// Check if local daemon is up
	let daemonHealthy = false;
	try {
		const res = await fetch("http://127.0.0.1:17841/healthz", { signal: AbortSignal.any([deadline, AbortSignal.timeout(1000)]) });
		daemonHealthy = res.ok;
	} catch {
		daemonHealthy = false;
	}

	if (!daemonHealthy) {
		t.skip("Skipping live integration test: local daemon at 127.0.0.1:17841 is not running");
		return;
	}

	const provider = createCodexNativeProvider();
	const model = provider.getModels().find((m) => m.id === "gpt-6.1-sol");
	assert.ok(model, "gpt-6.1-sol must exist");

	const stream = provider.stream(
		model,
		normalizeContext({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Reply with exactly the word PONG" }],
					timestamp: Date.now(),
				},
			],
		}),
		{
			reasoningEffort: "low",
			signal: deadline,
			maxRetries: 0,
		}
	);

	let gathered = "";
	for await (const event of stream) {
		if (event.type === "text_delta" && event.delta) {
			gathered += event.delta;
		}
	}

	assert.ok(gathered.length > 0, "Should have received streamed text from gpt-6.1-sol");
	assert.match(gathered.toUpperCase(), /PONG/);
});
