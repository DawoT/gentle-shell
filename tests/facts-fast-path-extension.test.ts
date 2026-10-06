import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsService } from "../lib/facts/facts-service.ts";
import { FactsHistory } from "../lib/facts/facts-history.ts";
import gentleFacts from "../extensions/gentle-facts.ts";

function createMockPi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();

  const pi = {
    appendEntry() {},
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

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-fastpath-ext-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });

  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "test-facts-app", packageManager: "pnpm@11.1.1" }));
  await writeFile(join(dir, "math.ts"), "export function multiply(a: number, b: number): number { return a * b; }\n");
  await writeFile(join(dir, ".gitignore"), ".pi/\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });

  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function sessionContext(dir: string) {
  // Production transcripts live outside the indexed workspace; keep it that
  // way here so transcript writes never dirty the watched epoch.
  const sessionFile = join(tmpdir(), `facts-fastpath-session-${process.pid}.jsonl`);
  return {
    cwd: dir,
    hasUI: false,
    sessionManager: {
      getSessionId: () => "fast-path-session",
      getSessionFile: () => sessionFile,
      getBranch: () => [],
    },
  };
}

test("write hooks mark dirty lazily and reads refresh through auto mode", async (t) => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    const sync = t.mock.method(FactsService.prototype, "sync", async function () {
      return { indexedCount: 0, cachedCount: 0, deletedCount: 0, path: "full" };
    });
    gentleFacts(pi as any);
    const ctx = sessionContext(dir);

    await pi.emit("session_start", {}, ctx);
    assert.equal(sync.mock.callCount(), 1);
    assert.equal((sync.mock.calls[0].arguments[1] as any)?.mode, "auto", "lifecycle refresh uses auto mode");

    await pi.emit("tool_execution_end", { toolName: "edit" }, ctx);
    assert.equal(sync.mock.callCount(), 1, "a write hook must not force a full refresh");

    await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.equal(sync.mock.callCount(), 2, "the next consumer refreshes lazily");
    assert.equal((sync.mock.calls[1].arguments[1] as any)?.mode, "auto");
  } finally {
    await cleanup();
  }
});

test("history is recorded on full refreshes but skipped on fast-path reads", async (t) => {
  const { dir, cleanup } = await createFixture();
  const saveOrig = FactsHistory.prototype.save;
  try {
    const { pi } = createMockPi();
    const save = t.mock.method(FactsHistory.prototype, "save", async function (database, edges, signal) {
      return saveOrig.call(this, database, edges, signal);
    });
    gentleFacts(pi as any);
    const ctx = sessionContext(dir);

    await pi.emit("session_start", {}, ctx);
    assert.equal(save.mock.callCount(), 1, "full refresh records history");

    const status = await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.equal(status.details.status, "ready");
    assert.equal(save.mock.callCount(), 1, "fast-path read does not rewrite history");
  } finally {
    await cleanup();
  }
});

test("the kill switch env disables the fast path for the extension", async (t) => {
  const { dir, cleanup } = await createFixture();
  const saveOrig = FactsHistory.prototype.save;
  try {
    const { pi } = createMockPi();
    const save = t.mock.method(FactsHistory.prototype, "save", async function (database, edges, signal) {
      return saveOrig.call(this, database, edges, signal);
    });
    gentleFacts(pi as any, { GENTLE_FACTS_DISABLE_FAST_PATH: "1" });
    const ctx = sessionContext(dir);

    await pi.emit("session_start", {}, ctx);
    await pi.getTool("facts_status").execute("status", {}, undefined, undefined, ctx);
    assert.equal(save.mock.callCount(), 2, "every read is a conservative full refresh");
  } finally {
    await cleanup();
  }
});

test("session shutdown closes the workspace watcher", async (t) => {
  const { dir, cleanup } = await createFixture();
  try {
    const { pi } = createMockPi();
    const close = t.mock.method(FactsService.prototype, "close", function () {});
    gentleFacts(pi as any);
    const ctx = sessionContext(dir);

    await pi.emit("session_start", {}, ctx);
    await pi.emit("session_shutdown", {}, ctx);
    assert.ok(close.mock.callCount() >= 1, "the per-cwd service must be closed");
  } finally {
    await cleanup();
  }
});
