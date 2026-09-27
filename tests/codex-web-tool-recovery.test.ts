import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, symlink, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ToolReceipts } from "../lib/codex-web/tool-receipts.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import gentleCodexWeb from "../extensions/gentle-codex-web.ts";

function harness(sessionManager: SessionManager, cwd: string) {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(event: string, handler: Function) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
    registerTool() {},
  };
  gentleCodexWeb(pi as any);
  return async (event: string, data: unknown, selectedManager = sessionManager) => {
    let last;
    for (const handler of handlers.get(event) ?? []) {
      const result = await handler(data, {
        cwd, sessionManager: selectedManager, hasUI: false,
        model: { provider: "gentle-codex-web" },
      });
      if (result?.block) return result;
      if (result !== undefined) last = result;
    }
    return last;
  };
}

test("memory-only session switching retains admitted call identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-memory-"));
  try {
    const a = SessionManager.inMemory(dir);
    const b = SessionManager.inMemory(dir);
    const first = harness(a, dir);
    await first("tool_call", { toolCallId: "once", toolName: "bash", input: { command: "true" } });
    await first("tool_result", { toolCallId: "once", toolName: "bash", input: { command: "true" }, isError: false, content: [] });
    await first("tool_call", { toolCallId: "other", toolName: "bash", input: { command: "true" } }, b);
    assert.equal((await first("tool_call", { toolCallId: "once", toolName: "bash", input: { command: "true" } }))?.block, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("equal tool call IDs in concurrent Pi sessions have independent admissions and results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-scope-"));
  try {
    const a = SessionManager.create(dir, join(dir, "sessions"));
    const b = SessionManager.create(dir, join(dir, "sessions"));
    const dispatch = harness(a, dir);
    const call = { toolCallId: "same", toolName: "bash", input: { command: "true" } };

    assert.equal(await dispatch("tool_call", call, a), undefined);
    assert.equal(await dispatch("tool_call", call, b), undefined);
    assert.equal((await dispatch("tool_call", call, a))?.block, true);
    assert.equal((await dispatch("tool_call", call, b))?.block, true);

    await dispatch("tool_result", { ...call, isError: false, content: [{ type: "text", text: "A" }] }, a);
    const receiptsA = new ToolReceipts(a.getSessionId(), dir, a.getSessionFile());
    const receiptsB = new ToolReceipts(b.getSessionId(), dir, b.getSessionFile());
    assert.equal((await receiptsA.inspect("same"))?.state, "result-observed");
    assert.equal((await receiptsB.inspect("same"))?.state, "admitted");
    await dispatch("tool_result", { ...call, isError: false, content: [{ type: "text", text: "B" }] }, b);
    assert.equal((await receiptsB.inspect("same"))?.state, "result-observed");
    assert.equal((await dispatch("tool_call", call, a))?.block, true);
    assert.equal((await dispatch("tool_call", call, b))?.block, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a partial claim is never treated as free after a failed publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-partial-"));
  try {
    const receipts = new ToolReceipts("session", dir, join(dir, "session.jsonl"));
    await receipts.admit("once", "bash", { command: "true" });
    const [claim] = (await readdir(receipts.directory!)).filter(name => name.endsWith(".claim.json"));
    await writeFile(join(receipts.directory!, claim), "{");
    await assert.rejects(receipts.inspect("once"));
    await assert.rejects(receipts.admit("once", "bash", { command: "true" }), /already admitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt or foreign settlement cannot report a completed result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-foreign-"));
  try {
    const receipts = new ToolReceipts("session", dir, join(dir, "session.jsonl"));
    const claim = await receipts.admit("once", "bash", { command: "true" });
    await receipts.settle(claim, [{ type: "text", text: "ok" }], false);
    const [result] = (await readdir(receipts.directory!)).filter(name => name.endsWith(".result.json"));
    const path = join(receipts.directory!, result);
    const row = JSON.parse(await readFile(path, "utf8"));
    row.nonce = "foreign";
    await writeFile(path, JSON.stringify(row));
    await assert.rejects(receipts.inspect("once"), /Invalid recovery result/);
    await assert.rejects(receipts.admit("once", "bash", { command: "true" }), /already admitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistent storage symlink or unavailable path blocks execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-storage-"));
  try {
    const receipts = new ToolReceipts("session", dir, join(dir, "sessions", "session.jsonl"));
    await mkdir(join(dir, "sessions"));
    await symlink(dir, join(dir, "sessions", "web-recovery"));
    await assert.rejects(receipts.admit("once", "bash", {}), /directory/);
    await rm(join(dir, "sessions", "web-recovery"));
    await writeFile(join(dir, "sessions", "web-recovery"), "not a directory");
    await assert.rejects(receipts.admit("once", "bash", {}));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a symlinked session directory cannot redirect recovery receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-parent-link-"));
  try {
    await mkdir(join(dir, "actual"));
    await symlink(join(dir, "actual"), join(dir, "sessions"));
    const receipts = new ToolReceipts("session", dir, join(dir, "sessions", "session.jsonl"));
    await assert.rejects(receipts.admit("once", "bash", {}), /directory|symlink/);
    assert.equal((await readdir(join(dir, "actual"))).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent admission of one persistent call allows exactly one execution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-race-"));
  try {
    const participants = Array.from({ length: 8 }, () => new ToolReceipts("session", dir, join(dir, "session.jsonl")));
    const outcomes = await Promise.allSettled(participants.map(item => item.admit("once", "bash", { command: "true" })));
    assert.equal(outcomes.filter(item => item.status === "fulfilled").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery metadata rejects unsafe tool names and never displays raw call IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-display-"));
  try {
    const journal = new ToolReceipts("session", dir);
    await assert.rejects(journal.admit("once", "bash\nStatus: forged", {}), /Invalid recovery tool identity/);
    const session = SessionManager.inMemory(dir);
    const output: string[] = [];
    const handlers = new Map<string, Function>();
    const pi = {
      on(event: string, handler: Function) {
        handlers.set(event, handler);
      },
      registerCommand(name: string, command: { handler: Function }) {
        if (name === "web-bridge") handlers.set("command", command.handler);
      },
      registerTool() {},
    };
    gentleCodexWeb(pi as any);
    const context = {
      cwd: dir,
      sessionManager: session,
      hasUI: true,
      model: { provider: "gentle-codex-web" },
      ui: { notify(text: string) { output.push(text); }, setWidget() {} },
    };
    await handlers.get("tool_call")!({ toolCallId: "private\nStatus: forged", toolName: "bash", input: {} }, context);
    await handlers.get("command")!("recovery", context);
    assert.equal(output.some(text => text.includes("private\nStatus: forged")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("other Pi providers do not create bridge recovery receipts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-other-provider-"));
  try {
    const session = SessionManager.inMemory(dir);
    const handlers = new Map<string, Function>();
    gentleCodexWeb({
      on(event: string, handler: Function) { handlers.set(event, handler); },
      registerCommand() {},
      registerTool() {},
    } as any);
    const result = await handlers.get("tool_call")!({
      toolCallId: "other",
      toolName: "bash",
      input: { command: "true" },
    }, { cwd: dir, sessionManager: session, model: { provider: "openai" } });
    assert.equal(result, undefined);
    assert.equal(await new ToolReceipts(session.getSessionId(), dir).inspect("other"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed settlement reports uncertainty and leaves the claim blocked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-result-fail-"));
  try {
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    const call = { toolCallId: "call_once", toolName: "bash", input: { command: "true" } };
    const dispatch = harness(manager, dir);
    assert.equal(await dispatch("tool_call", call), undefined);
    const scopeRoot = join(dir, "sessions", "web-recovery");
    const [scope] = await readdir(scopeRoot);
    const path = join(scopeRoot, scope);
    const [claimName] = (await readdir(path)).filter(name => name.endsWith(".claim.json"));
    await writeFile(join(path, claimName), "{");
    const observed = await dispatch("tool_result", { ...call, content: [{ type: "text", text: "effect" }], isError: false });
    assert.equal(observed.isError, true);
    assert.match(JSON.stringify(observed.content), /could not be persisted/);
    assert.equal((await dispatch("tool_call", call))?.block, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function childAdmission(cwd: string, callId: string, effectFile?: string) {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    join(import.meta.dirname, "support", "codex-web-claim-child.mjs"),
    cwd,
    callId,
    effectFile ?? "",
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let errors = "";
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.stderr.on("data", chunk => {
    errors += chunk;
  });
  try {
    return await new Promise<{ state: string; message?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Child admission timed out")), 5000);
      child.once("message", value => {
        clearTimeout(timeout);
        resolve(value as { state: string; message?: string });
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error(`Child exited before admission: ${errors}`));
      });
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
}

test("two operating-system processes race for one call and only one is admitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-tool-process-race-"));
  try {
    const outcomes = await Promise.all([
      childAdmission(dir, "same"),
      childAdmission(dir, "same"),
    ]);
    assert.deepEqual(outcomes.map(item => item.state).sort(), ["admitted", "blocked"]);
    assert.match(outcomes.find(item => item.state === "blocked")?.message ?? "", /busy|already admitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const phase of ["before-effect", "after-effect"]) {
  test(`SIGKILL ${phase} leaves the claimed call blocked after reopening`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-tool-kill-"));
    try {
      const effect = join(dir, "effect.txt");
      const result = await childAdmission(dir, "once", phase === "after-effect" ? effect : undefined);
      assert.equal(result.state, "admitted");
      if (phase === "after-effect") assert.equal(await readFile(effect, "utf8"), "executed\n");
      else await assert.rejects(readFile(effect, "utf8"), { code: "ENOENT" });
      await assert.rejects(
        new ToolReceipts("shared-session", dir, join(dir, "session.jsonl")).admit("once", "bash", { command: "effect" }),
        /already admitted/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const phase of ["admitted", "settled"]) {
  test(`reopening a Pi session blocks a previously ${phase} tool call`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "web-tool-recovery-"));
    try {
      const manager = SessionManager.create(dir, join(dir, "sessions"));
      manager.appendMessage({ role: "user", content: "Run once", timestamp: 1 });
      manager.appendMessage({
        role: "assistant", content: [{ type: "text", text: "Ready" }],
        api: "openai-responses", provider: "gentle-codex-web", model: "test",
        stopReason: "stop", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      const call = { toolCallId: "call_once|fc_once", toolName: "bash", input: { command: "printf once" } };
      const first = harness(manager, dir);
      assert.equal(await first("tool_call", call), undefined);
      if (phase === "settled") {
        await first("tool_result", { ...call, isError: false, content: [{ type: "text", text: "once" }] });
      }
      const reopened = SessionManager.open(manager.getSessionFile()!);
      const second = harness(reopened, dir);
      assert.equal((await second("tool_call", call))?.block, true, "a reopened runtime must not execute this call again");
      assert.equal(await second("tool_call", { ...call, toolCallId: "call_new|fc_new" }), undefined, "a distinct call remains available");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
