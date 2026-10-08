import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { getDefaultCodexAuthPath, readCodexAuth, type CodexAuth } from "./auth.ts";
import {
	CODEX_NATIVE_DEFAULT_ORIGIN,
	CODEX_NATIVE_PROVIDER_ID,
	getCodexNativeModels,
} from "./models.ts";

export interface CodexNativeProviderOptions {
	env?: NodeJS.ProcessEnv;
	baseUrl?: string;
	authResolver?: () => CodexAuth;
	fetchImpl?: typeof fetch;
}

function requireLoopback(value: string): URL {
	const message = "Codex Native requires an http(s) literal loopback endpoint (localhost, 127.0.0.1, or [::1]) without userinfo";
	let url: URL;
	try { url = new URL(value); } catch { throw new Error(message); }
	// Check the raw authority too: URL normalizes integer, short and hex IPv4 aliases.
	const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
	if (!authority || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)
		|| !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error(message);
	}
	return url;
}

export function createCodexNativeProvider(
	options: CodexNativeProviderOptions = {}
): Provider<"openai-responses"> {
	const baseUrl = (options.baseUrl ?? CODEX_NATIVE_DEFAULT_ORIGIN).replace(/\/+$/, "");
	requireLoopback(baseUrl);
	const env = options.env ?? process.env;
	const resolveAuth = () => {
		if (env.GENTLE_CODEX_NATIVE !== "1") {
			throw new Error("Codex Native is experimental and disabled. Set GENTLE_CODEX_NATIVE=1 to opt in.");
		}
		requireLoopback(baseUrl);
		return (options.authResolver ?? readCodexAuth)();
	};
	const baseFetch = options.fetchImpl ?? globalThis.fetch;
	const api = openAIResponsesApi();

	const wrapFetch = (auth: CodexAuth, clientFetch?: typeof fetch): typeof fetch => {
		const targetFetch = clientFetch ?? baseFetch;
		return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = requireLoopback(input instanceof Request ? input.url : String(input));
			if (url.origin !== new URL(baseUrl).origin) throw new Error("Codex Native request must stay on the configured loopback origin");
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
			headers.set("authorization", `Bearer ${auth.accessToken}`);
			if (auth.accountId) headers.set("chatgpt-account-id", auth.accountId);
			else headers.delete("chatgpt-account-id");
			headers.set("originator", "pi");

			let body = init?.body;
			if (typeof body === "string") {
				try {
					const parsed = JSON.parse(body);
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						parsed.store = false;
						parsed.stream = true;
						body = JSON.stringify(parsed);
					}
				} catch {
					// Leave body as-is if not valid JSON
				}
			}

			const request = new Request(input, {
				...init,
				headers,
				...(body === undefined ? {} : { body }),
				redirect: "error",
			});
			request.signal.throwIfAborted();
			const response = await targetFetch(request);
			if (response.redirected || (response.status >= 300 && response.status < 400)) {
				throw new Error("Codex Native redirects are not permitted");
			}
			return response;
		};
	};

	const getModels = (): Model<"openai-responses">[] => {
		return getCodexNativeModels().map((model) => ({
			...model,
			provider: CODEX_NATIVE_PROVIDER_ID,
			baseUrl,
			api: "openai-responses" as const,
		}));
	};

	return {
		id: CODEX_NATIVE_PROVIDER_ID,
		name: "Codex Native (Daemon)",
		baseUrl,
		auth: {
			apiKey: {
				name: "Codex Auth",
				async check(input) {
					if (options.authResolver || input?.credential?.key || existsSync(getDefaultCodexAuthPath())) {
						return { source: "Codex auth.json", type: "api_key" };
					}
					return undefined;
				},
				async resolve() {
					try {
						const auth = resolveAuth();
						return {
							auth: { apiKey: auth.accessToken },
							source: "Codex auth.json",
						};
					} catch {
						return undefined;
					}
				},
			},
		},
		getModels,
		stream(model, context, streamOptions) {
			const auth = resolveAuth();
			const modelWithBaseUrl = { ...model, baseUrl };
			const customFetch = wrapFetch(auth, streamOptions?.fetch);

			return api.stream(modelWithBaseUrl as Model<"openai-responses">, context, {
				...streamOptions,
				apiKey: auth.accessToken,
				fetch: customFetch,
				onPayload: async (payload, m) => {
					const replaced = await streamOptions?.onPayload?.(payload, m);
					const current = replaced ?? payload;
					if (current && typeof current === "object" && !Array.isArray(current)) {
						(current as Record<string, unknown>).store = false;
						(current as Record<string, unknown>).stream = true;
					}
					return current;
				},
			});
		},
		streamSimple(model, context, streamOptions) {
			const auth = resolveAuth();
			const modelWithBaseUrl = { ...model, baseUrl };
			const customFetch = wrapFetch(auth, streamOptions?.fetch);

			return api.streamSimple(modelWithBaseUrl as Model<"openai-responses">, context, {
				...streamOptions,
				apiKey: auth.accessToken,
				fetch: customFetch,
				onPayload: async (payload, m) => {
					const replaced = await streamOptions?.onPayload?.(payload, m);
					const current = replaced ?? payload;
					if (current && typeof current === "object" && !Array.isArray(current)) {
						(current as Record<string, unknown>).store = false;
						(current as Record<string, unknown>).stream = true;
					}
					return current;
				},
			});
		},
	};
}
