import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FactsService } from "../lib/facts/facts-service.ts";

export const FACTS_TOOL_QUERY = "facts_query";
export const FACTS_TOOL_DEPENDENTS = "facts_dependents";
export const FACTS_TOOL_STATUS = "facts_status";

const services = new Map<string, FactsService>();

function getService(cwd: string): FactsService {
	let service = services.get(cwd);
	if (!service) {
		service = new FactsService(cwd);
		services.set(cwd, service);
	}
	return service;
}

export default function gentleFacts(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	// 1. Tool: facts_query
	pi.registerTool({
		name: FACTS_TOOL_QUERY,
		label: "Facts Query",
		description: "Deterministic AST query for exact symbols, signatures, interfaces, and docstrings without reading raw source files.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["name"],
			properties: {
				name: {
					type: "string",
					description: "Name of the symbol (function, interface, class, type, or variable) to find.",
				},
				kind: {
					type: "string",
					enum: ["function", "interface", "class", "typeAlias", "enum", "variable", "constant", "all"],
					description: "Optional filter by symbol kind.",
				},
			},
		},
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
			const service = getService(ctx.cwd);
			const matches = service.querySymbol(params.name);

			const filtered = params.kind && params.kind !== "all"
				? matches.filter((m) => m.symbol.kind === params.kind)
				: matches;

			if (filtered.length === 0) {
				return {
					content: [{
						type: "text",
						text: `No symbols found matching '${params.name}'. Check the spelling or run 'facts_status' to inspect indexed files.`,
					}],
					details: { found: 0, query: params.name },
				};
			}

			const formatted = filtered.map(({ file, symbol }) => {
				const doc = symbol.docstring ? `\n  Doc: ${symbol.docstring.trim()}` : "";
				return `• ${symbol.name} (${symbol.kind})\n  File: ${file} (lines ${symbol.startLine}-${symbol.endLine})\n  Signature: ${symbol.signature}${doc}`;
			}).join("\n\n");

			return {
				content: [{
					type: "text",
					text: `Found ${filtered.length} symbol(s) matching '${params.name}':\n\n${formatted}`,
				}],
				details: { found: filtered.length, query: params.name },
			};
		},
	});

	// 2. Tool: facts_dependents
	pi.registerTool({
		name: FACTS_TOOL_DEPENDENTS,
		label: "Facts Dependents",
		description: "Find files that import or depend on a given file or module path for safe refactoring.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["target"],
			properties: {
				target: {
					type: "string",
					description: "Target file path or module name to check for dependents (e.g. './calc.ts' or 'calc.ts').",
				},
			},
		},
		execute: async (_toolCallId: string, params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
			const service = getService(ctx.cwd);
			const dependents = service.queryDependents(params.target);

			if (dependents.length === 0) {
				return {
					content: [{
						type: "text",
						text: `No files in the project currently depend on or import '${params.target}'.`,
					}],
					details: { dependentsCount: 0, target: params.target },
				};
			}

			return {
				content: [{
					type: "text",
					text: `Files depending on '${params.target}':\n${dependents.map((f) => `• ${f}`).join("\n")}`,
				}],
				details: { dependentsCount: dependents.length, target: params.target },
			};
		},
	});

	// 3. Tool: facts_status
	pi.registerTool({
		name: FACTS_TOOL_STATUS,
		label: "Facts Status",
		description: "Inspect the current status of the deterministic facts knowledge base and verified execution receipts.",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {},
		},
		execute: async (_toolCallId: string, _params: any, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) => {
			const service = getService(ctx.cwd);
			const block = service.getSummaryPromptBlock();
			return {
				content: [{
					type: "text",
					text: block,
				}],
				details: { status: "ready" },
			};
		},
	});

	// Lifecycle hooks
	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		try {
			const service = getService(ctx.cwd);
			await service.sync();
		} catch {
			// Fail-safe: if not a git repo or indexing fails, continue session cleanly
		}
	});

	pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: ExtensionContext) => {
		try {
			const service = getService(ctx.cwd);
			const block = service.getSummaryPromptBlock();
			if (!block) return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${block}`,
			};
		} catch {
			return undefined;
		}
	});

	pi.on("tool_execution_end", async (event: { toolName: string; isError?: boolean }, ctx: ExtensionContext) => {
		if (event.isError) return;
		if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "apply_diff") {
			try {
				const service = getService(ctx.cwd);
				await service.sync();
			} catch {
				// Fail-safe incremental update
			}
		}
	});

	pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
		services.delete(ctx.cwd);
	});
}
