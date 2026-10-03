export const CODEX_NATIVE_PROVIDER_ID = "codex-native";
export const CODEX_NATIVE_DEFAULT_ORIGIN = "http://127.0.0.1:17841/v1";

export interface CodexNativeThinkingLevelMap {
	off: string | null;
	minimal: string | null;
	low: string | null;
	medium: string | null;
	high: string | null;
	xhigh: string | null;
	max: string | null;
}

export interface CodexNativeModelDefinition {
	id: string;
	name: string;
	api: "openai-responses";
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap: CodexNativeThinkingLevelMap;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const FULL_THINKING_LEVEL_MAP: CodexNativeThinkingLevelMap = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

// Pi requires numeric pricing. Zero is an unknown-price placeholder, NOT a
// statement about actual billing. This provisional catalog has not been probed
// against a daemon: model availability, limits and capabilities are unverified.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const CODEX_NATIVE_MODELS: readonly CodexNativeModelDefinition[] = [
	{
		id: "gpt-6.1-sol",
		name: "GPT-6.1 Sol",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
	{
		id: "gpt-6-sol",
		name: "GPT-6 Sol",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
	{
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol (Native)",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (Native)",
		api: "openai-responses",
		provider: CODEX_NATIVE_PROVIDER_ID,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 272_000,
		maxTokens: 128_000,
		thinkingLevelMap: { ...FULL_THINKING_LEVEL_MAP },
		cost: ZERO_COST,
	},
];

function cloneModel(model: CodexNativeModelDefinition): CodexNativeModelDefinition {
	return {
		...model,
		input: [...model.input],
		thinkingLevelMap: { ...model.thinkingLevelMap },
		cost: { ...model.cost },
	};
}

export function getCodexNativeModels(): CodexNativeModelDefinition[] {
	return CODEX_NATIVE_MODELS.map(cloneModel);
}

export function findCodexNativeModel(id: string): CodexNativeModelDefinition | undefined {
	const model = CODEX_NATIVE_MODELS.find((m) => m.id === id);
	return model ? cloneModel(model) : undefined;
}
