import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gentleFacts from "../extensions/gentle-facts.ts";

test("facts_query refreshes external edits before returning signatures", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };
    await pi.emit("session_start", {}, ctx);
    await writeFile(join(dir, "math.ts"), "export function multiply(value: bigint): bigint { return value; }\n");
    const result = await pi.getTool("facts_query").execute("query", { name: "multiply" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /value: bigint/);
    assert.doesNotMatch(result.content[0].text, /a: number/);
  } finally {
    await cleanup();
  }
});

test("facts tools report refresh failure instead of returning a stale snapshot", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };
    await pi.emit("session_start", {}, ctx);
    await rm(join(dir, ".git"), { recursive: true });
    for (const [name, params] of [
      ["facts_query", { name: "multiply" }],
      ["facts_dependents", { target: "math.ts" }],
      ["facts_status", {}],
    ] as const) {
      const result = await pi.getTool(name).execute("query", params, undefined, undefined, ctx);
      assert.equal(result.details.status, "unavailable", name);
      assert.match(result.content[0].text, /not indexed/, name);
    }
    assert.equal(await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx), undefined);
  } finally {
    await cleanup();
  }
});

test("facts_query does not retain facts when a tracked source becomes unreadable", {
  skip: process.platform === "win32" ? "Symbolic links require privileges on Windows" : false,
}, async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };
    await pi.emit("session_start", {}, ctx);
    await rm(join(dir, "math.ts"));
    await symlink("missing-source.ts", join(dir, "math.ts"));

    const result = await pi.getTool("facts_query").execute("query", { name: "multiply" }, undefined, undefined, ctx);
    assert.equal(result.details.status, "unavailable");
    assert.doesNotMatch(result.content[0].text, /function multiply/);
  } finally {
    await cleanup();
  }
});

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

test("session lifecycle mounts and refreshes the facts card in the UI", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const widgets = new Map<string, any>();
    const ctx = {
      cwd: dir,
      hasUI: true,
      ui: {
        setWidget(key: string, value: any) {
          if (value === undefined) widgets.delete(key);
          else widgets.set(key, value);
        },
      },
    };
    const render = () => {
      const factory = widgets.get("gentle-facts");
      assert.ok(factory);
      return factory({ terminal: null }, { fg: (_color: string, text: string) => text }).render(60).join("\n");
    };

    await pi.emit("session_start", {}, ctx);
    assert.match(render(), /2 files/);

    await writeFile(join(dir, "new.ts"), "export const added = true;\n");
    await pi.emit("tool_execution_end", { toolName: "write", isError: false }, ctx);
    assert.match(render(), /3 files/);

    await pi.emit("session_shutdown", {}, ctx);
    assert.equal(widgets.has("gentle-facts"), false);
  } finally {
    await cleanup();
  }
});

test("facts_status reports unavailable in a non-Git directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-nongit-ext-"));
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };

    await pi.emit("session_start", {}, ctx);
    const result = await pi.getTool("facts_status").execute("call", {}, undefined, undefined, ctx);
    assert.match(result.content[0]?.text, /not indexed/);
    assert.equal(result.details.status, "unavailable");
    assert.equal(await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("facts tools propagate caller cancellation", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      pi.getTool("facts_query").execute("cancel", { name: "multiply" }, controller.signal, undefined, { cwd: dir, hasUI: false }),
      { name: "AbortError" },
    );
  } finally {
    await cleanup();
  }
});

test("facts_query pages results and bounds individual signatures", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    for (let i = 0; i < 4; i++) {
      await writeFile(join(dir, `page-${i}.ts`), `export interface Shared {\n${"  value: string;\n".repeat(800)}\n}\n`);
    }
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const tool = pi.getTool("facts_query");
    const ctx = { cwd: dir, hasUI: false };
    const first = await tool.execute("page", { name: "Shared", limit: 2 }, undefined, undefined, ctx);
    assert.equal(first.details.returned, 2);
    assert.equal(first.details.nextOffset, 2);
    assert.ok(first.content[0].text.length <= 16000);
    const second = await tool.execute("page", { name: "Shared", limit: 2, offset: 2 }, undefined, undefined, ctx);
    assert.equal(second.details.returned, 2);
    assert.equal(second.details.nextOffset, null);
    assert.doesNotMatch(second.content[0].text, /page-0.ts/);
  } finally {
    await cleanup();
  }
});

test("facts_dependents returns stable pages", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    for (let i = 0; i < 3; i++) {
      await writeFile(join(dir, `consumer-${i}.ts`), "import { multiply } from './math';\n");
    }
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const tool = pi.getTool("facts_dependents");
    const ctx = { cwd: dir, hasUI: false };
    const page = await tool.execute("page", { target: "math.ts", offset: 1, limit: 1 }, undefined, undefined, ctx);
    assert.equal(page.details.returned, 1);
    assert.equal(page.details.nextOffset, 2);
    assert.match(page.content[0].text, /consumer-1.ts/);
    assert.doesNotMatch(page.content[0].text, /consumer-0.ts/);
  } finally {
    await cleanup();
  }
});

test("facts_status explains unavailable indexing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-diagnostic-"));
  try {
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const result = await pi.getTool("facts_status").execute("status", {}, undefined, undefined, { cwd: dir, hasUI: false });
    assert.equal(result.details.diagnostics.failure.code, "not_git");
    assert.match(result.content[0].text, /Git repository/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status and injected summary bound oversized package manager metadata", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ packageManager: "npm@" + "x".repeat(20000) }));
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };
    const result = await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.ok(result.content[0].text.length <= 16000);
    assert.match(result.content[0].text, /truncated/i);
    const injected = await pi.emit("before_agent_start", { systemPrompt: "base" }, ctx);
    assert.ok(injected.systemPrompt.length <= 16005);
  } finally {
    await cleanup();
  }
});

test("cursor pages preserve the original query across edits and repository disappearance", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "a.ts"), "export const Shared = 1;\n");
    await writeFile(join(dir, "b.ts"), "export const Shared = 2;\n");
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false };
    const tool = pi.getTool("facts_query");
    const first = await tool.execute("first", { name: "Shared", limit: 1 }, undefined, undefined, ctx);
    assert.equal(typeof first.details.nextCursor, "string");
    await writeFile(join(dir, "b.ts"), "export const Different = 3;\n");
    await rm(join(dir, ".git"), { recursive: true, force: true });
    const next = await tool.execute("next", { name: "Shared", cursor: first.details.nextCursor }, undefined, undefined, ctx);
    assert.match(next.content[0].text, /b.ts/);
    assert.doesNotMatch(next.content[0].text, /Different/);
    assert.equal(next.details.generation, first.details.generation);
    assert.equal(next.details.nextCursor, null);
    await assert.rejects(tool.execute("wrong", { name: "Different", cursor: first.details.nextCursor }, undefined, undefined, ctx), /different query/);
  } finally {
    await cleanup();
  }
});

test("facts_dependents exposes transitive resolution evidence", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "middle.ts"), "export { multiply } from './math';\n");
    await writeFile(join(dir, "outer.ts"), "import { multiply } from './middle';\n");
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const result = await pi.getTool("facts_dependents").execute("impact", { target: "math.ts", transitive: true }, undefined, undefined, { cwd: dir, hasUI: false });
    assert.match(result.content[0].text, /outer.ts/);
    assert.match(result.content[0].text, /typescript/);
    assert.match(result.content[0].text, /depth 2/);
  } finally {
    await cleanup();
  }
});

test("facts_status reports unresolved module coverage without claiming complete resolution", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "unknown.ts"), "import { missing } from '@missing/module';\n");
    const { pi } = createMockPi();
    gentleFacts(pi as any);
    const result = await pi.getTool("facts_status").execute("status", {}, undefined, undefined, { cwd: dir, hasUI: false });
    assert.equal(result.details.resolution.unresolved, 1);
    assert.ok(result.details.resolution.resolved >= 1);
    assert.match(result.content[0].text, /unresolved/);
  } finally {
    await cleanup();
  }
});

test("shutdown in another extension instance does not expire this session's cursors", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "a.ts"), "export const Shared = 1;\n");
    await writeFile(join(dir, "b.ts"), "export const Shared = 2;\n");
    const first = createMockPi().pi;
    const second = createMockPi().pi;
    gentleFacts(first as any);
    gentleFacts(second as any);
    const ctx = { cwd: dir, hasUI: false };
    const tool = second.getTool("facts_query");
    const page = await tool.execute("page", { name: "Shared", limit: 1 }, undefined, undefined, ctx);
    await first.emit("session_shutdown", {}, ctx);
    const next = await tool.execute("next", { name: "Shared", cursor: page.details.nextCursor }, undefined, undefined, ctx);
    assert.match(next.content[0].text, /b.ts/);
  } finally {
    await cleanup();
  }
});

test("session transcript references restore historical symbols without resync", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const branch: any[] = [];
    const { pi } = createMockPi();
    (pi as any).appendEntry = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data });
    const ctx = {
      cwd: dir,
      hasUI: false,
      sessionManager: { getSessionFile: () => join(dir, "session.jsonl"), getBranch: () => branch },
    };
    gentleFacts(pi as any);
    await pi.emit("session_start", {}, ctx);
    assert.equal(branch.length, 1);
    await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.equal(branch.length, 1, "unchanged snapshots must not duplicate transcript entries");
    await rm(join(dir, ".git"), { recursive: true, force: true });
    const result = await pi.getTool("facts_history").execute("past", { name: "multiply" }, undefined, undefined, ctx);
    assert.equal(result.details.status, "historical");
    assert.match(result.content[0].text, /Historical/);
    assert.match(result.content[0].text, /multiply/);
    const empty = await pi.getTool("facts_history").execute("branch", {}, undefined, undefined, {
      ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [] },
    });
    assert.equal(empty.details.status, "unavailable");
  } finally {
    await cleanup();
  }
});

test("history persistence failures are visible without discarding current facts", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "facts-snapshots"), "not a directory");
    const { pi } = createMockPi();
    (pi as any).appendEntry = () => assert.fail("must not append an unavailable snapshot");
    gentleFacts(pi as any);
    const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionFile: () => join(dir, "session.jsonl"), getBranch: () => [] } };
    const result = await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.equal(result.details.status, "ready");
    assert.match(result.content[0].text, /History snapshot unavailable/);
  } finally {
    await cleanup();
  }
});

test("facts_commit labels pinned evidence and leaves current facts and transcript history intact", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    await writeFile(join(dir, "math.ts"), "export function multiply(value: bigint): bigint { return value; }\n");
    const { pi } = createMockPi();
    const branch: any[] = [];
    (pi as any).appendEntry = (customType: string, data: unknown) => branch.push({ type: "custom", customType, data });
    const ctx = { cwd: dir, hasUI: false, sessionManager: { getSessionFile: () => join(dir, "session.jsonl"), getBranch: () => branch } };
    gentleFacts(pi as any);
    await pi.emit("session_start", {}, ctx);
    const entries = branch.length;
    const tool = pi.getTool("facts_commit");
    assert.ok(tool, "commit evidence tool must be registered");
    const pinned = await tool.execute("commit", { revision: commit, name: "multiply" }, undefined, undefined, ctx);
    assert.equal(pinned.details.status, "committed");
    assert.equal(pinned.details.commit, commit);
    assert.match(pinned.content[0].text, /a: number/);
    assert.doesNotMatch(pinned.content[0].text, /bigint/);
    assert.equal(branch.length, entries);
    const current = await pi.getTool("facts_query").execute("current", { name: "multiply" }, undefined, undefined, ctx);
    assert.match(current.content[0].text, /bigint/);
  } finally {
    await cleanup();
  }
});
