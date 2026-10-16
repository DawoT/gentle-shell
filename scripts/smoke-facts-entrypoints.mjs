#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SMOKE_TIMEOUT_MS = 20000;

/**
 * Spawns an MCP entry point and runs the initialize + tools/list
 * round-trip against a disposable workspace. Resolves { ok, tools, error }
 * without throwing: a bin that cannot load (broken import, syntax error)
 * surfaces its stderr tail in `error`, so the smoke report states the
 * precise cause instead of a suite-wide mystery. Shared by the regression
 * test and the standalone pre-commit CLI below.
 */
export async function smokeMcpEntrypoint(binPath, { workspace, timeoutMs = SMOKE_TIMEOUT_MS } = {}) {
	return await new Promise((resolve) => {
		const proc = spawn(process.execPath, [binPath], {
			cwd: workspace,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		let settled = false;
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			proc.kill("SIGKILL");
			resolve(result);
		};
		const timer = setTimeout(() => {
			finish({ ok: false, tools: [], error: `smoke timeout after ${timeoutMs}ms; stderr tail: ${stderr.slice(-400)}` });
		}, timeoutMs);
		proc.on("error", (error) => finish({ ok: false, tools: [], error: String(error) }));
		proc.on("exit", (code) => {
			finish({
				ok: false,
				tools: [],
				error: `entry point exited with code ${code} before the handshake; stderr tail: ${stderr.slice(-400)}`,
			});
		});

		const pending = new Map();
		proc.stdout?.setEncoding("utf8");
		let buffer = "";
		proc.stdout?.on("data", (chunk) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id !== undefined && pending.has(message.id)) {
					const resolveRequest = pending.get(message.id);
					pending.delete(message.id);
					resolveRequest(message);
				}
			}
		});
		const request = (id, method, params) => new Promise((resolveRequest) => {
			pending.set(id, resolveRequest);
			proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});

		(async () => {
			const init = await request(1, "initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "entrypoints-smoke", version: "1.0.0" },
			});
			if (init.error) return finish({ ok: false, tools: [], error: `initialize failed: ${JSON.stringify(init.error)}` });
			proc.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
			const listed = await request(2, "tools/list", {});
			if (listed.error) return finish({ ok: false, tools: [], error: `tools/list failed: ${JSON.stringify(listed.error)}` });
			const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
			if (tools.length === 0) return finish({ ok: false, tools: [], error: "tools/list returned no tools" });
			finish({ ok: true, tools, error: undefined });
		})().catch((error) => finish({ ok: false, tools: [], error: String(error) }));
	});
}

async function main() {
	const bins = [
		join(process.cwd(), "bin", "gentle-facts-mcp.mjs"),
		join(process.cwd(), "bin", "gentle-proofs-mcp.mjs"),
	];
	const workspace = await mkdtemp(join(tmpdir(), "entrypoints-smoke-cli-"));
	await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "entrypoints-smoke", version: "1.0.0" }));
	let failed = false;
	try {
		for (const bin of bins) {
			const result = await smokeMcpEntrypoint(bin, { workspace });
			const toolNote = result.tools.length > 0 ? ` [${result.tools.join(", ")}]` : "";
			console.log(`${result.ok ? "PASS" : "FAIL"} ${bin}${toolNote}`);
			if (!result.ok) {
				console.error(`  ${result.error}`);
				failed = true;
			}
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
	process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await main();
}
