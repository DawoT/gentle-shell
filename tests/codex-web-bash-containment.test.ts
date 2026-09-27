import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContainedBashOperations, hasDelegatedCommandCgroup } from "../lib/codex-web/pi-bash-containment.ts";
import gentleCodexWeb from "../extensions/gentle-codex-web.ts";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

test("bridge extension registers a bash fallback only when quiet tools are disabled", () => {
  const tools = new Map<string, unknown>();
  const fakePi = {
    on() {},
    registerCommand() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
  } as any;
  const previous = process.env.GENTLE_PI_QUIET_TOOLS;
  try {
    process.env.GENTLE_PI_QUIET_TOOLS = "0";
    gentleCodexWeb(fakePi);
    assert.ok(tools.has("bash"));
    tools.clear();
    delete process.env.GENTLE_PI_QUIET_TOOLS;
    gentleCodexWeb(fakePi);
    assert.equal(tools.has("bash"), false);
  } finally {
    if (previous === undefined) delete process.env.GENTLE_PI_QUIET_TOOLS;
    else process.env.GENTLE_PI_QUIET_TOOLS = previous;
  }
});

test("compaction checkpoints become digest-verified project memory", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "codex-project-memory-workspace-"));
  const configHome = mkdtempSync(join(tmpdir(), "codex-project-memory-config-"));
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const fakePi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
  } as any;
  const previous = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  try {
    gentleCodexWeb(fakePi);
    assert.ok(tools.has("memory_search"));
    assert.ok(tools.has("memory_read"));
    const ctx = {
      cwd,
      sessionManager: {
        getSessionId: () => "session-one",
        getSessionFile: () => join(configHome, "session-one.jsonl"),
        getBranch: () => [{
          type: "custom",
          customType: "gentle-facts-snapshot-v1",
          data: {
            version: 1,
            digest: "a".repeat(64),
            root: cwd,
            observedAt: Date.parse("2026-09-27T16:59:00.000Z"),
          },
        }],
      },
    };
    const event = {
      reason: "threshold",
      willRetry: false,
      fromExtension: false,
      compactionEntry: {
        type: "compaction",
        id: "compact-one",
        parentId: "parent-one",
        timestamp: "2026-09-27T17:00:00.000Z",
        summary: "Objective: repair the scheduler. Pending: verify cancellation semantics.",
        firstKeptEntryId: "kept-one",
        tokensBefore: 64000,
      },
    };
    for (const handler of handlers.get("session_compact") ?? []) await handler(event, ctx);

    const search = await tools.get("memory_search").execute("search", {
      query: "scheduler",
      offset: 0,
      limit: 10,
    }, undefined, undefined, ctx);
    assert.equal(search.details.status, "historical");
    assert.equal(search.details.total, 1);
    assert.match(search.content[0].text, /historical evidence/i);
    assert.doesNotMatch(search.content[0].text, /cancellation semantics/);

    const read = await tools.get("memory_read").execute("read", {
      id: search.details.results[0].id,
      offset_chars: 0,
      limit_chars: 12000,
    }, undefined, undefined, ctx);
    assert.equal(read.details.digest_verified, true);
    assert.equal(read.details.facts_receipt.digest, "a".repeat(64));
    assert.match(read.content[0].text, /repair the scheduler/);
    assert.match(read.content[0].text, /Historical evidence only/);
  } finally {
    if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
    else process.env.GENTLE_PI_CONFIG_HOME = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("project memory isolates workspaces and tolerates concurrent session writers and corrupt lines", async () => {
  const firstProject = mkdtempSync(join(tmpdir(), "codex-project-memory-first-"));
  const secondProject = mkdtempSync(join(tmpdir(), "codex-project-memory-second-"));
  const configHome = mkdtempSync(join(tmpdir(), "codex-project-memory-shared-"));
  try {
    const first = await ProjectMemory.open(configHome, firstProject, "session-a");
    const second = await ProjectMemory.open(configHome, firstProject, "session-b");
    const isolated = await ProjectMemory.open(configHome, secondProject, "session-c");
    const input = (id: string, timestamp: string, summary: string) => ({
      id,
      parentId: null,
      timestamp,
      summary,
      firstKeptEntryId: `kept-${id}`,
      tokensBefore: 50000,
      reason: "threshold" as const,
      willRetry: false,
    });
    await Promise.all([
      first.saveCompaction(input("one", "2026-09-27T17:00:00.000Z", "Shared scheduler evidence alpha")),
      second.saveCompaction(input("two", "2026-09-27T17:01:00.000Z", "Shared scheduler evidence beta")),
    ]);
    await assert.rejects(first.saveCompaction({
      ...input("x".repeat(1025), "2026-09-27T17:02:00.000Z", "unreadable evidence"),
    }), /entry ID/);
    await assert.rejects(first.saveCompaction({
      ...input("invalid-facts", "2026-09-27T17:03:00.000Z", "unreadable facts evidence"),
      factsReceipt: { digest: "invalid", root: firstProject, observedAt: 1 },
    }), /Facts receipt/);
    assert.equal((await first.search("scheduler", 0, 20)).total, 2);
    assert.equal((await isolated.search("scheduler", 0, 20)).total, 0);

    const [memoryFile] = readdirSync(join(firstProject, ".agents", "memory"));
    const memoryPath = join(firstProject, ".agents", "memory", memoryFile);
    appendFileSync(memoryPath, '{"id":"tampered"}\n{"torn":', "utf8");
    assert.equal((await first.search("scheduler", 0, 20)).total, 2);
    for (const file of readdirSync(join(firstProject, ".agents", "memory"))) {
      truncateSync(join(firstProject, ".agents", "memory", file), 16 * 1024 * 1024);
    }
    await assert.rejects(first.saveCompaction(
      input("retention", "2026-09-27T17:04:00.000Z", "must not grow an unbounded session file"),
    ), /retention budget/);
  } finally {
    rmSync(firstProject, { recursive: true, force: true });
    rmSync(secondProject, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
  }
});

test("Pi bash cancellation stops a descendant that starts a new session", { skip: !hasDelegatedCommandCgroup() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bash-containment-"));
  const controller = new AbortController();
  const operations = createContainedBashOperations();
  try {
    const pending = operations.exec(
      "setsid bash -c 'sleep 1; printf escaped > marker' </dev/null >/dev/null 2>&1 & printf ready > ready; sleep 10",
      cwd,
      { signal: controller.signal, onData: () => {} },
    );
    const deadline = Date.now() + 2000;
    while (!existsSync(join(cwd, "ready")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(join(cwd, "ready")), true);
    controller.abort();
    await assert.rejects(pending, /aborted/);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(existsSync(join(cwd, "marker")), false);
  } finally {
    controller.abort();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pi bash timeout keeps its timeout result and stops a detached descendant", { skip: !hasDelegatedCommandCgroup() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bash-timeout-"));
  try {
    await assert.rejects(
      createContainedBashOperations().exec(
        "setsid bash -c 'sleep 1; printf escaped > marker' </dev/null >/dev/null 2>&1 & sleep 10",
        cwd,
        { timeout: 0.1, onData: () => {} },
      ),
      /timeout:0\.1/,
    );
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(existsSync(join(cwd, "marker")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pi bash normal completion retires detached descendants", { skip: !hasDelegatedCommandCgroup() }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bash-complete-"));
  try {
    const result = await createContainedBashOperations().exec(
      "setsid bash -c 'sleep 1; printf escaped > marker' </dev/null >/dev/null 2>&1 & printf done",
      cwd,
      { onData: () => {} },
    );
    assert.equal(result.exitCode, 0);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(existsSync(join(cwd, "marker")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Pi bash immediate cancellation blocks execution before cgroup join", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-bash-immediate-"));
  try {
    for (let index = 0; index < 12; index += 1) {
      const controller = new AbortController();
      const pending = createContainedBashOperations().exec(
        `sleep 0.05; printf late > marker-${index}`,
        cwd,
        { signal: controller.signal, onData: () => {} },
      );
      controller.abort();
      await assert.rejects(pending, /aborted/);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    for (let index = 0; index < 12; index += 1) {
      assert.equal(existsSync(join(cwd, `marker-${index}`)), false);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
