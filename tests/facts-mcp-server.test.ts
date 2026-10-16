import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

function createRpcClient(proc: ReturnType<typeof spawn>) {
  let seq = 1;
  const pending = new Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void }>();
  let buffer = "";

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const handler = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) handler.reject(msg.error);
          else handler.resolve(msg.result);
        }
      } catch {
        // ignore parse errors on client side
      }
    }
  });

  proc.on("error", (err) => {
    for (const [, handler] of pending) handler.reject(err);
    pending.clear();
  });

  proc.on("exit", (code) => {
    for (const [, handler] of pending) handler.reject(new Error(`Server exited prematurely with code ${code}`));
    pending.clear();
  });

  return {
    async request(method: string, params?: any): Promise<any> {
      const id = seq++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        proc.stdin?.write(payload);
      });
    },
    notify(method: string, params?: any): void {
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
      proc.stdin?.write(payload);
    },
    raw(text: string): void {
      proc.stdin?.write(text);
    },
  };
}

test("Facts MCP Server handles initialization, tool discovery, and tool execution over stdio", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-ws-"));
  const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");

  try {
    // Create a mock package.json and a source file in the workspace
    await writeFile(join(workspace, "package.json"), JSON.stringify({
      name: "mcp-test-fixture",
      version: "1.0.0",
      scripts: { test: "echo pass" }
    }));
    await writeFile(join(workspace, "index.ts"), `
export interface UserSession { id: string; active: boolean; }
export function authenticate(sessionId: string): UserSession {
  return { id: sessionId, active: true };
}
`);

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

    // Create a project memory compaction checkpoint
    const memory = await ProjectMemory.open(workspace, "session-test");
    const ref = await memory.saveCompaction({
      id: "entry-mcp-01",
      parentId: null,
      timestamp: "2026-09-27T18:00:00.000Z",
      summary: "Completed migration of memory storage to .agents/memory",
      firstKeptEntryId: "entry-mcp-01",
      tokensBefore: 24000,
      reason: "manual",
      willRetry: false,
    });

    // Spawn server process
    const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: workspace,
    });

    const client = createRpcClient(proc);

    try {
      // 1. Initialize
      const initResult = await client.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });

      assert.equal(initResult.protocolVersion, "2024-11-05");
      assert.equal(initResult.serverInfo?.name, "gentle-facts-mcp");
      assert.ok(initResult.capabilities?.tools);

      client.notify("notifications/initialized");

      // 2. tools/list
      const toolsResult = await client.request("tools/list");
      assert.ok(Array.isArray(toolsResult.tools));
      const toolNames = toolsResult.tools.map((t: any) => t.name);
      assert.ok(toolNames.includes("facts_query"), "must include facts_query");
      assert.ok(toolNames.includes("facts_dependents"), "must include facts_dependents");
      assert.ok(toolNames.includes("facts_impact"), "must include facts_impact");
      assert.ok(toolNames.includes("facts_status"), "must include facts_status");
      assert.equal(toolNames.includes("memory_search"), false, "unbound memory search must not consume tool catalog context");
      assert.equal(toolNames.includes("memory_read"), false, "unbound memory read must not consume tool catalog context");
      assert.ok(toolNames.includes("context_status"), "must include context_status");

      // 3. tools/call: facts_status
      const statusCall = await client.request("tools/call", {
        name: "facts_status",
        arguments: {},
      });
      assert.ok(Array.isArray(statusCall.content));
      assert.match(statusCall.content[0].text, /package manager|indexed|ground truth/i);

      // 4. tools/call: memory_search
      const memorySearchCall = await client.request("tools/call", {
        name: "memory_search",
        arguments: { query: "migration" },
      });
      assert.ok(Array.isArray(memorySearchCall.content));
      assert.equal(memorySearchCall.isError, true);
      assert.match(memorySearchCall.content[0].text, /session_scope_required/);
      assert.doesNotMatch(memorySearchCall.content[0].text, new RegExp(ref.id));

      // 5. tools/call: memory_read
      const memoryReadCall = await client.request("tools/call", {
        name: "memory_read",
        arguments: { id: ref.id, offset_chars: 0, limit_chars: 100 },
      });
      assert.ok(Array.isArray(memoryReadCall.content));
      assert.equal(memoryReadCall.isError, true);
      assert.doesNotMatch(memoryReadCall.content[0].text, /Completed migration of memory storage/);

      // 6. tools/call: facts_query
      const queryCall = await client.request("tools/call", {
        name: "facts_query",
        arguments: { name: "authenticate" },
      });
      assert.ok(Array.isArray(queryCall.content));
      assert.match(queryCall.content[0].text, /authenticate/);
      assert.match(queryCall.content[0].text, /index\.ts/);

      // 7. tools/call: context_status
      const contextStatusCall = await client.request("tools/call", {
        name: "context_status",
        arguments: {},
      });
      assert.ok(Array.isArray(contextStatusCall.content));
      assert.match(contextStatusCall.content[0].text, /CONTEXT & MEMORY STATUS/);
      assert.match(contextStatusCall.content[0].text, /session_scope_required/);

      // 8. Unknown method returns -32601
      await assert.rejects(
        client.request("non_existent_method"),
        (err: any) => err.code === -32601,
      );

      // 9. Unknown tool call returns error in content or isError: true
      const invalidToolCall = await client.request("tools/call", {
        name: "unknown_tool",
        arguments: {},
      });
      assert.equal(invalidToolCall.isError, true);
    } finally {
      proc.kill("SIGKILL");
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Facts MCP Server returns standard JSON-RPC 2.0 errors on malformed messages", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-err-"));
  const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
  try {
    const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const received: any[] = [];
    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { received.push(JSON.parse(line)); } catch {}
      }
    });

    // Send malformed JSON line
    proc.stdin?.write("{ malformed json\n");

    // Send invalid request structure (missing jsonrpc)
    proc.stdin?.write(JSON.stringify({ id: 99, method: "test" }) + "\n");

    const start = Date.now();
    while (received.length < 2 && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }

    proc.kill("SIGKILL");

    assert.equal(received.length, 2);
    assert.equal(received[0].error?.code, -32700); // Parse error
    assert.equal(received[1].error?.code, -32600); // Invalid request
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("facts_query file mode reports the file's resolved and unresolved imports", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-imports-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");

	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "mcp-imports-fixture", version: "1.0.0" }));
		await writeFile(join(workspace, "index.ts"), `
export function authenticate(sessionId: string): string {
	return sessionId;
}
`);
		await writeFile(join(workspace, "app.ts"), `
import { authenticate } from "./index.ts";
import { join } from "node:path";
import { helper } from "external-pkg";

export function run(): string {
	return join(".", authenticate("1"), helper());
}
`);

		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

		const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: workspace,
		});
		const client = createRpcClient(proc);

		try {
			await client.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});
			client.notify("notifications/initialized");

			const result = await client.request("tools/call", {
				name: "facts_query",
				arguments: { file: "app.ts" },
			});
			const text = result.content[0].text;

			assert.match(text, /imports \(/, "file-mode responses must include an imports section");
			assert.match(text, /index\.ts/, "the relative import must show its resolved target");
			assert.match(text, /node:path/, "the builtin specifier must be listed");
			assert.match(text, /external-pkg/, "the external specifier must be listed");
			assert.match(text, /unresolved/, "unresolved imports must be marked as such");
		} finally {
			proc.kill("SIGKILL");
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("facts_entities surfaces contract entities extracted from indexed contract files", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-entities-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");

	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "mcp-entities-fixture", version: "1.0.0" }));
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(workspace, "petstore.openapi.yaml"), petstore);

		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

		const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: workspace,
		});
		const client = createRpcClient(proc);

		try {
			await client.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});
			client.notify("notifications/initialized");

			const result = await client.request("tools/call", {
				name: "facts_entities",
				arguments: { name: "Pets" },
			});
			const text = result.content[0].text;
			assert.match(text, /\[openapi-schema\] Pets/, "the exact-name entity lookup must return the entity with its kind");
			assert.match(text, /petstore\.openapi\.yaml/, "entity rows must state their source path");

			const byKind = await client.request("tools/call", {
				name: "facts_entities",
				arguments: { kind: "api-route" },
			});
			assert.match(byKind.content[0].text, /api-route/, "kind filtering must work");
		} finally {
			proc.kill("SIGKILL");
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("facts_entities rows carry the touching contract relations", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-relations-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");

	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "mcp-relations-fixture", version: "1.0.0" }));
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(workspace, "petstore.openapi.yaml"), petstore);

		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });

		const proc = spawn(process.execPath, [binPath, "--workspace", workspace], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: workspace,
		});
		const client = createRpcClient(proc);

		try {
			await client.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "test", version: "1.0.0" },
			});
			client.notify("notifications/initialized");

			const schema = await client.request("tools/call", {
				name: "facts_entities",
				arguments: { name: "Pets" },
			});
			assert.match(schema.content[0].text, /relations \(1\): serves ← GET \/pets/, "the schema must show its incoming serves relation");

			const route = await client.request("tools/call", {
				name: "facts_entities",
				arguments: { name: "GET /pets" },
			});
			assert.match(route.content[0].text, /relations \(\d+\): serves → Pets/, "the route must show its outgoing serves relation");
		} finally {
			proc.kill("SIGKILL");
		}
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});

test("facts_usages answers which files reference a symbol over MCP", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-usages-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
	let proc;
	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "usages-fixture", version: "1.0.0" }));
		await writeFile(join(workspace, "helper.ts"), "export function helper(value: number): number { return value * 2; }\n");
		await writeFile(join(workspace, "main.ts"), "import { helper } from './helper.ts';\nexport const doubled = helper(21);\n");
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "T"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "init"], { cwd: workspace });
		proc = spawn(process.execPath, [binPath], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
		const client = createRpcClient(proc);
		await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		client.notify("notifications/initialized");
		const result = await client.request("tools/call", { name: "facts_usages", arguments: { name: "helper" } });
		assert.match(result.content[0].text, /main\.ts/, "the usage site must be returned");
	} finally {
		proc?.kill("SIGKILL");
		await rm(workspace, { recursive: true, force: true });
	}
});

test("facts_entities federates sibling repositories with tagged rows", async () => {
	const parent = await mkdtemp(join(tmpdir(), "facts-mcp-fed-"));
	const workspace = join(parent, "primary");
	const sibling = join(parent, "sibling-repo");
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
	try {
		const { execFileSync } = await import("node:child_process");
		for (const root of [workspace, sibling]) {
			await mkdir(root, { recursive: true });
			await writeFile(join(root, "package.json"), JSON.stringify({ name: "fed-fixture", version: "1.0.0" }));
			const { execFileSync } = await import("node:child_process");
			execFileSync("git", ["init", "-b", "main"], { cwd: root });
			execFileSync("git", ["config", "user.name", "T"], { cwd: root });
			execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
		}
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(workspace, "petstore.openapi.yaml"), petstore);
		await writeFile(join(sibling, "sibling.schema.json"), JSON.stringify({ title: "SiblingContract", type: "object" }));
		for (const root of [workspace, sibling]) {
			execFileSync("git", ["add", "."], { cwd: root });
			execFileSync("git", ["commit", "-m", "init"], { cwd: root });
		}

		const proc = spawn(process.execPath, [binPath, "--workspace", workspace, "--sibling-root", sibling], {
			cwd: workspace,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const client = createRpcClient(proc);
		try {
			await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
			client.notify("notifications/initialized");

			const siblingEntity = await client.request("tools/call", { name: "facts_entities", arguments: { name: "SiblingContract" } });
			assert.match(siblingEntity.content[0].text, /\[sibling-repo\] \[json-schema\] SiblingContract/, "sibling rows must carry the sibling tag");

			const primaryEntity = await client.request("tools/call", { name: "facts_entities", arguments: { name: "Pets" } });
			assert.match(primaryEntity.content[0].text, /\[openapi-schema\] Pets/, "primary rows stay untagged");
			assert.doesNotMatch(primaryEntity.content[0].text, /\[sibling-repo\]/, "primary-only results must not carry the sibling tag");
		} finally {
			proc.kill("SIGKILL");
		}
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test("facts_search discovers entities through fuzzy queries over MCP", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-search-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
	let proc;
	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "search-fixture", version: "1.0.0" }));
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(workspace, "petstore.openapi.yaml"), petstore);
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "T"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "init"], { cwd: workspace });
		proc = spawn(process.execPath, [binPath, "--workspace", workspace], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
		const client = createRpcClient(proc);
		await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		client.notify("notifications/initialized");
		const result = await client.request("tools/call", { name: "facts_search", arguments: { query: "pets" } });
		assert.match(result.content[0].text, /Pets/, "fuzzy discovery must find the petstore schema entity");
	} finally {
		proc?.kill("SIGKILL");
		await rm(workspace, { recursive: true, force: true });
	}
});

test("facts_search kind filter restricts results before the caller limit", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "facts-mcp-kind-"));
	const binPath = join(process.cwd(), "bin", "gentle-facts-mcp.mjs");
	let proc;
	try {
		await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "kind-fixture", version: "1.0.0" }));
		const petstore = await readFile(join(process.cwd(), "tests", "fixtures", "contracts", "petstore.openapi.yaml"), "utf8");
		await writeFile(join(workspace, "petstore.openapi.yaml"), petstore);
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
		execFileSync("git", ["config", "user.name", "T"], { cwd: workspace });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: workspace });
		execFileSync("git", ["add", "."], { cwd: workspace });
		execFileSync("git", ["commit", "-m", "init"], { cwd: workspace });
		proc = spawn(process.execPath, [binPath, "--workspace", workspace], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
		const client = createRpcClient(proc);
		await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
		client.notify("notifications/initialized");
		const result = await client.request("tools/call", { name: "facts_search", arguments: { query: "pets", kind: "entity", limit: 3 } });
		const rows = result.content[0].text.split("\n").filter((line) => line.startsWith("•"));
		assert.ok(rows.length > 0 && rows.length <= 3, "the caller limit must be honored");
		assert.ok(rows.every((line) => line.includes("[entity]")), "every row must honor the kind filter");
	} finally {
		proc?.kill("SIGKILL");
		await rm(workspace, { recursive: true, force: true });
	}
});
