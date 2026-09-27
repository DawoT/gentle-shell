import test from "node:test";
import assert from "node:assert/strict";
import gentleCodexWeb from "../extensions/gentle-codex-web.ts";

test("native compaction waits for idle, deduplicates a leaf and isolates sessions", async () => {
  const handlers = new Map<string, Function[]>();
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
  };
  const previous = process.env.GENTLE_CODEX_WEB_AUTO_COMPACT;
  process.env.GENTLE_CODEX_WEB_AUTO_COMPACT = "1";
  try {
    gentleCodexWeb(pi as any);
    let idle = false;
    let pending = false;
    let session = "one";
    let leaf = "leaf-one";
    const calls: any[] = [];
    const ctx = {
      cwd: "/workspace",
      model: { provider: "gentle-codex-web", contextWindow: 128000, maxTokens: 16000 },
      hasUI: false,
      isIdle: () => idle,
      hasPendingMessages: () => pending,
      getContextUsage: () => ({ tokens: 60000, contextWindow: 128000, percent: 46 }),
      sessionManager: { getSessionId: () => session, getLeafId: () => leaf },
      compact: (options: any) => calls.push(options),
    };
    const settle = async () => {
      for (const handler of handlers.get("agent_settled") ?? []) await handler({}, ctx);
    };
    await settle();
    assert.equal(calls.length, 0);
    idle = true;
    pending = true;
    await settle();
    assert.equal(calls.length, 0);
    pending = false;
    await settle();
    assert.equal(calls.length, 1);
    assert.match(calls[0].customInstructions, /unresolved/i);
    leaf = "another-leaf";
    await settle();
    assert.equal(calls.length, 1, "only one native compaction in flight");
    calls[0].onError(new Error("provider unavailable"));
    leaf = "leaf-one";
    await settle();
    assert.equal(calls.length, 1, "no automatic retry at a failed leaf");
    session = "two";
    await settle();
    assert.equal(calls.length, 2);
    calls[1].onComplete({});
    delete process.env.GENTLE_CODEX_WEB_AUTO_COMPACT;
    leaf = "new-leaf";
    await settle();
    assert.equal(calls.length, 2, "automatic compaction remains opt-in");
  } finally {
    if (previous === undefined) delete process.env.GENTLE_CODEX_WEB_AUTO_COMPACT;
    else process.env.GENTLE_CODEX_WEB_AUTO_COMPACT = previous;
  }
});
