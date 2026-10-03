import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { createCodexNativeProvider as createProvider } from "../lib/codex-native/provider.ts";
import type { CodexNativeProviderOptions } from "../lib/codex-native/provider.ts";
const createCodexNativeProvider = (options: CodexNativeProviderOptions = {}) => createProvider({ ...options, env: { GENTLE_CODEX_NATIVE: "1" } });
import type { CodexAuth } from "../lib/codex-native/auth.ts";

test("disabled provider use fails before credentials or fetch", async () => {
	let reads = 0;
	let requests = 0;
	const provider = createProvider({ env: {}, authResolver() { reads++; return { accessToken: "secret" }; }, fetchImpl: async () => { requests++; return new Response(); } });
	assert.throws(() => provider.stream(provider.getModels()[0]!, normalizeContext({ messages: [] })), /GENTLE_CODEX_NATIVE=1/);
	assert.throws(() => provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] })), /GENTLE_CODEX_NATIVE=1/);
	assert.equal(await provider.auth?.apiKey?.resolve?.({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal }), undefined);
	assert.equal(reads, 0);
	assert.equal(requests, 0);
});

test("createCodexNativeProvider initializes provider with expected id, name, and models", () => {
	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "test-token", accountId: "test-account" }),
	});

	assert.equal(provider.id, "codex-native");
	assert.equal(provider.name, "Codex Native (Daemon)");
	assert.equal(provider.baseUrl, "http://127.0.0.1:17841/v1");

	const models = provider.getModels();
	assert.ok(models.length >= 5);
	const gpt61 = models.find((m) => m.id === "gpt-6.1-sol");
	assert.ok(gpt61);
	assert.equal(gpt61.name, "GPT-6.1 Sol");
	assert.equal(gpt61.api, "openai-responses");
	assert.equal(gpt61.provider, "codex-native");
});

test("provider rejects non-literal loopback endpoints before resolving auth", () => {
	for (const baseUrl of ["https://example.com/v1", "http://user:secret@localhost/v1", "file:///v1", "http://127.1/v1", "http://2130706433/v1", "http://localhost.example/v1"]) {
		let authReads = 0;
		assert.throws(() => createCodexNativeProvider({ baseUrl, authResolver() { authReads++; return { accessToken: "secret" }; } }), /loopback/);
		assert.equal(authReads, 0);
	}
});

test("createCodexNativeProvider accepts custom baseUrl", () => {
	const provider = createCodexNativeProvider({
		baseUrl: "http://127.0.0.1:9999/v1",
		authResolver: () => ({ accessToken: "test-token" }),
	});

	assert.equal(provider.baseUrl, "http://127.0.0.1:9999/v1");
	const models = provider.getModels();
	assert.equal(models[0]?.baseUrl, "http://127.0.0.1:9999/v1");
});

test("provider injects fresh Authorization and chatgpt-account-id headers into requests", async () => {
	let capturedRequest: Request | undefined;
	const customFetch: typeof fetch = async (input, init) => {
		capturedRequest = new Request(input, init);
		return new Response(
			'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\nevent: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\nevent: response.done\ndata: {"type":"response.done"}\n\n',
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}
		);
	};

	let tokenCounter = 1;
	const authResolver = (): CodexAuth => ({
		accessToken: `token-v${tokenCounter++}`,
		accountId: "acct-dyn-123",
	});

	const provider = createCodexNativeProvider({
		authResolver,
		fetchImpl: customFetch,
	});

	const model = provider.getModels().find((m) => m.id === "gpt-6.1-sol")!;
	const stream = provider.stream(
		model,
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
		{}
	);

	// Consume stream
	for await (const _event of stream) {
		// iterate
	}

	assert.ok(capturedRequest, "fetch should have been called");
	assert.equal(capturedRequest.headers.get("authorization"), "Bearer token-v1");
	assert.equal(capturedRequest.headers.get("chatgpt-account-id"), "acct-dyn-123");

	const body = await capturedRequest.json();
	assert.equal(body.store, false);
	assert.equal(body.stream, true);
	assert.equal(body.model, "gpt-6.1-sol");
});

test("provider streamSimple injects dynamic auth headers and sets store: false", async () => {
	let capturedRequest: Request | undefined;
	const customFetch: typeof fetch = async (input, init) => {
		capturedRequest = new Request(input, init);
		return new Response(
			'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"simple"}\n\nevent: response.output_text.done\ndata: {"type":"response.output_text.done"}\n\nevent: response.done\ndata: {"type":"response.done"}\n\n',
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}
		);
	};

	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "test-simple-token", accountId: "acct-simple" }),
		fetchImpl: customFetch,
	});

	const model = provider.getModels().find((m) => m.id === "gpt-6.1-sol")!;
	const stream = provider.streamSimple(
		model,
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
		{}
	);

	for await (const _event of stream) {
		// iterate
	}

	assert.ok(capturedRequest);
	assert.equal(capturedRequest.headers.get("authorization"), "Bearer test-simple-token");
	assert.equal(capturedRequest.headers.get("chatgpt-account-id"), "acct-simple");
	const body = await capturedRequest.json();
	assert.equal(body.store, false);
});

test("provider transport forbids redirects while preserving custom headers and cancellation", async () => {
	let captured: Request | undefined;
	const controller = new AbortController();
	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "local-token" }),
		fetchImpl: async (input, init) => {
			captured = new Request(input, init);
			return new Response(null, { status: 302, headers: { location: "https://remote.example/credentials" } });
		},
	});
	const stream = provider.stream(provider.getModels()[0]!, normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }), {
		headers: { "x-custom": "kept", "authorization": "stale", "chatgpt-account-id": "stale-account" },
		signal: controller.signal,
		maxRetries: 0,
	});
	const events = [];
	for await (const event of stream) events.push(event);
	assert.ok(captured);
	assert.equal(captured.redirect, "error");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.get("x-custom"), "kept");
	assert.equal(captured.headers.get("authorization"), "Bearer local-token");
	assert.equal(captured.headers.get("chatgpt-account-id"), null);
	controller.abort();
	assert.equal(captured.signal.aborted, true);
	assert.equal(events.filter(event => event.type === "error").length, 1);
	assert.equal(events.some(event => event.type === "done"), false);
});

test("Request inputs retain headers, body, method and signal with init overrides", async (t) => {
	const controller = new AbortController();
	let captured: Request | undefined;
	// Replace only the SDK dispatch representation, not the provider adapter or
	// SSE parser: exercise a valid fetch Request input instead of the SDK's URL.
	const dispatch = OpenAI.prototype.fetchWithTimeout;
	t.mock.method(OpenAI.prototype, "fetchWithTimeout", function (this: OpenAI, url: RequestInfo, init: RequestInit, ms: number, sdkController: AbortController) {
		const request = new Request(url, { ...init, signal: controller.signal });
		request.headers.set("x-request-only", "retained");
		request.headers.set("x-override", "old");
		return dispatch.call(this, request, { method: request.method, headers: { "x-override": "new", "x-init-only": "retained" }, signal: controller.signal }, ms, controller);
	});
	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "request-token" }),
		fetchImpl: async (input, init) => {
			captured = new Request(input, init);
			return new Response('data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n', { headers: { "content-type": "text/event-stream" } });
		},
	});
	for await (const _event of provider.stream(provider.getModels()[0]!, normalizeContext({ messages: [] }), { maxRetries: 0 })) { /* consume */ }
	assert.ok(captured);
	assert.equal(captured.headers.get("x-request-only"), "retained");
	assert.equal(captured.headers.get("x-init-only"), "retained");
	assert.equal(captured.headers.get("x-override"), "new");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.get("authorization"), "Bearer request-token");
	const body = await captured.json();
	assert.equal(body.model, "gpt-6.1-sol");
	assert.equal(body.store, false);
	controller.abort();
	assert.equal(captured.signal.aborted, true);
});

test("remote Request inputs fail before fetch can receive credentials", async (t) => {
	const dispatch = OpenAI.prototype.fetchWithTimeout;
	t.mock.method(OpenAI.prototype, "fetchWithTimeout", function (this: OpenAI, _url: RequestInfo, _init: RequestInit, ms: number, controller: AbortController) {
		return dispatch.call(this, new Request("https://remote.example/v1/responses"), undefined, ms, controller);
	});
	let calls = 0;
	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "must-stay-local" }),
		fetchImpl: async () => { calls++; return new Response(); },
	});
	const events = [];
	for await (const event of provider.stream(provider.getModels()[0]!, normalizeContext({ messages: [] }), { maxRetries: 0 })) events.push(event);
	assert.equal(calls, 0);
	const terminal = events.at(-1)!;
	assert.equal(terminal.type, "error");
	if (terminal.type === "error") assert.equal(terminal.error.errorMessage?.includes("must-stay-local"), false);
	assert.equal(events.filter(event => event.type === "error").length, 1);
});

test("Pi Responses delegation closes with exactly one terminal event for completed and partial SSE", async () => {
	for (const completed of [true, false]) {
		const provider = createCodexNativeProvider({
			authResolver: () => ({ accessToken: "synthetic-token" }),
			fetchImpl: async () => new Response(completed
				? 'data: {"type":"response.completed","response":{"id":"synthetic-response","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":0,"total_tokens":2}}}\n\n'
				: 'data: {"type":"response.created","response":{"id":"synthetic-response"}}\n\n',
				{ headers: { "content-type": "text/event-stream" } }),
		});
		const events = [];
		for await (const event of provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), { maxRetries: 0 })) events.push(event);
		assert.equal(events.filter(event => event.type === "done" || event.type === "error").length, 1);
		const terminal = events.at(-1)!;
		assert.equal(terminal.type, completed ? "done" : "error");
		if (terminal.type === "done") {
			assert.equal(terminal.message.usage.input, 2);
			assert.deepEqual(terminal.message.content, []);
		}
	}
});

test("aborting an in-flight synthetic fetch produces one aborted terminal event", async () => {
	const controller = new AbortController();
	let ready!: () => void;
	const started = new Promise<void>(resolve => { ready = resolve; });
	const provider = createCodexNativeProvider({
		authResolver: () => ({ accessToken: "synthetic-token" }),
		fetchImpl: async (input, init) => {
			const request = new Request(input, init);
			return new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
				ready();
			});
		},
	});
	const stream = provider.stream(provider.getModels()[0]!, normalizeContext({ messages: [] }), { signal: controller.signal, maxRetries: 0 });
	await started;
	controller.abort();
	const events = [];
	for await (const event of stream) events.push(event);
	assert.equal(events.filter(event => event.type === "error").length, 1);
	const terminal = events.at(-1)!;
	assert.equal(terminal.type, "error");
	if (terminal.type === "error") assert.equal(terminal.reason, "aborted");
});

test("provider throws when authResolver cannot resolve credentials", () => {
	const provider = createCodexNativeProvider({
		authResolver: () => {
			throw new Error("No Codex credentials found");
		},
	});

	const model = provider.getModels().find((m) => m.id === "gpt-6.1-sol")!;
	assert.throws(
		() => provider.stream(
			model,
			normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
			{}
		),
		/No Codex credentials found/
	);
});
