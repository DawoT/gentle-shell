import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gentleFacts from "../extensions/gentle-facts.ts";

async function createFixture() {
	const dir = await mkdtemp(join(tmpdir(), "facts-ext-test-"));
	execFileSync("git", ["init", "-b", "main"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

	await writeFile(join(dir, "package.json"), JSON.stringify({
		name: "test-facts-app",
		scripts: { test: "pnpm run test:fast" },
		packageManager: "pnpm@11.1.1",
	}));
	await writeFile(join(dir, "math.ts"), "/** Multiplies two numbers */\nexport function multiply(a: number, b: number): number { return a * b; }\n");
	await writeFile(join(dir, "main.ts"), "import { multiply } from './math.ts';\nexport const val = multiply(2, 3);\n");

	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

	return {
		dir,
		async cleanup() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

function createMockPi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Function[]>();

	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: Function) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		getTool(name: string) {
			return tools.get(name);
		},
		async emit(event: string, eventData: any, ctx: any) {
			const list = handlers.get(event) || [];
			let lastResult: any;
			for (const h of list) {
				const r = await h(eventData, ctx);
				if (r) lastResult = r;
			}
			return lastResult;
		},
	};

	return { pi, tools, handlers };
}

test("gentleFacts extension registers facts_query, facts_dependents, and facts_status tools", () => {
	const { pi, tools } = createMockPi();
	gentleFacts(pi as any);

	assert.ok(tools.has("facts_query"));
	assert.ok(tools.has("facts_dependents"));
	assert.ok(tools.has("facts_status"));

	const queryTool = tools.get("facts_query");
	assert.equal(queryTool.name, "facts_query");
	assert.ok(queryTool.parameters.properties.name);
});

test("facts_query retrieves exact symbol signatures and docstrings without reading raw files", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const { pi } = createMockPi();
		gentleFacts(pi as any);

		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "sess-1" } };

		// Trigger session_start to sync
		await pi.emit("session_start", {}, ctx);

		const queryTool = pi.getTool("facts_query");
		const result = await queryTool.execute("call-1", { name: "multiply" }, undefined, undefined, ctx);

		assert.ok(result.content);
		const text = result.content[0]?.text || "";
		assert.ok(text.includes("multiply"));
		assert.ok(text.includes("math.ts"));
		assert.ok(text.includes("function multiply(a: number, b: number): number"));
		assert.ok(text.includes("Multiplies two numbers"));
	} finally {
		await cleanup();
	}
});

test("facts_dependents finds files importing a given module or symbol", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const { pi } = createMockPi();
		gentleFacts(pi as any);

		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "sess-2" } };
		await pi.emit("session_start", {}, ctx);

		const dependentsTool = pi.getTool("facts_dependents");
		const result = await dependentsTool.execute("call-2", { target: "./math.ts" }, undefined, undefined, ctx);

		assert.ok(result.content);
		const text = result.content[0]?.text || "";
		assert.ok(text.includes("main.ts"));
	} finally {
		await cleanup();
	}
});

test("facts_status reports inventory summary and execution receipts", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const { pi } = createMockPi();
		gentleFacts(pi as any);

		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "sess-3" } };
		await pi.emit("session_start", {}, ctx);

		const statusTool = pi.getTool("facts_status");
		const result = await statusTool.execute("call-3", {}, undefined, undefined, ctx);

		assert.ok(result.content);
		const text = result.content[0]?.text || "";
		assert.ok(text.includes("pnpm@11.1.1"));
		assert.ok(text.includes("pnpm test"));
		assert.ok(text.includes("Indexed Files: 2"));
	} finally {
		await cleanup();
	}
});

test("before_agent_start hook injects ground truth block into systemPrompt", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const { pi } = createMockPi();
		gentleFacts(pi as any);

		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "sess-4" } };
		await pi.emit("session_start", {}, ctx);

		const initialPrompt = "You are a helpful coding assistant.";
		const result = await pi.emit("before_agent_start", { systemPrompt: initialPrompt }, ctx);

		assert.ok(result?.systemPrompt);
		assert.ok(result.systemPrompt.includes(initialPrompt));
		assert.ok(result.systemPrompt.includes("[PROJECT GROUND TRUTH]"));
		assert.ok(result.systemPrompt.includes("pnpm test"));
	} finally {
		await cleanup();
	}
});

test("tool_execution_end hook triggers incremental re-index when write or edit is executed", async () => {
	const { dir, cleanup } = await createFixture();
	try {
		const { pi } = createMockPi();
		gentleFacts(pi as any);

		const ctx = { cwd: dir, sessionManager: { getSessionId: () => "sess-5" } };
		await pi.emit("session_start", {}, ctx);

		// Write a new file to disk
		await writeFile(join(dir, "greet.ts"), "export function greet(name: string): string { return `Hi ${name}`; }\n");

		// Simulate tool_execution_end for write tool
		await pi.emit("tool_execution_end", {
			toolName: "write",
			input: { path: "greet.ts" },
			isError: false,
		}, ctx);

		const queryTool = pi.getTool("facts_query");
		const result = await queryTool.execute("call-4", { name: "greet" }, undefined, undefined, ctx);

		assert.ok(result.content[0]?.text.includes("function greet(name: string): string"));
	} finally {
		await cleanup();
	}
});
