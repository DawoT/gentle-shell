import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createCodexWebProvider } from "../lib/codex-web/provider.ts";

for (const delivery of ["complete", "truncated"] as const) {
  test(`reopened Pi session does not resubmit a ${delivery} model turn`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "web-turn-recovery-"));
    const sessionFile = join(workspace, "sessions", "session.jsonl");
    await mkdir(join(workspace, "sessions"));
    let requests = 0;
    let pairs = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the host request before responding.
      }
      if (req.url === "/host/v1/sessions") {
        pairs += 1;
        res.end(JSON.stringify({
          protocol: 1,
          session_id: `host_${pairs}`,
          token: `cap_${pairs}`,
          models: [{ id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 }],
        }));
      } else if (req.method === "DELETE" || req.url?.endsWith("/cancel")) {
        res.end("{}");
      } else {
        requests += 1;
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${requests}` } })}\n\n`);
        if (delivery === "complete" || requests > 1) {
          res.write(`data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: `resp_${requests}`,
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`);
        }
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const settings = { origin, pairingToken: "pair", cwd: workspace, sessionId: "pi-session", sessionFile };
    const context = normalizeContext({ messages: [{ role: "user", content: "Run once", timestamp: 1 }] });
    let first;
    let reopened;
    try {
      first = await createCodexWebProvider(settings);
      const model = { ...first.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: first.config.baseUrl } as any;
      let firstPayload: any;
      const result = await first.config.streamSimple!(model, context, {
        onPayload: payload => {
          firstPayload = structuredClone(payload);
        },
      }).result();
      assert.equal(result.stopReason, delivery === "complete" ? "stop" : "error");
      assert.equal(requests, 1);
      if (delivery === "complete") {
        const repeated = await first.config.streamSimple!(model, context).result();
        assert.equal(repeated.stopReason, "error", "an identical completed model round cannot run twice");
        assert.equal(requests, 1);
        const rewritten = await first.config.streamSimple!(model, context, {
          onPayload: payload => ({ ...payload, metadata: { representation: "changed" } }),
        }).result();
        assert.equal(rewritten.stopReason, "error", "a payload callback cannot replay the same Pi context");
        assert.equal(requests, 1);
        const alteredContext = normalizeContext({ messages: [context.messages[0], result] });
        const alteredReplay = await first.config.streamSimple!(model, alteredContext, {
          onPayload: () => firstPayload,
        }).result();
        assert.equal(alteredReplay.stopReason, "error", "a changed context cannot replay an identical model payload");
        assert.equal(requests, 1);
      }
      await first.close();
      first = undefined;

      reopened = await createCodexWebProvider(settings);
      const recoveredModel = { ...reopened.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: reopened.config.baseUrl } as any;
      const retry = await reopened.config.streamSimple!(recoveredModel, context).result();
      assert.equal(retry.stopReason, "error");
      assert.equal(requests, 1, "an old user turn must not submit a second model request");
      const next = await reopened.config.streamSimple!(recoveredModel, normalizeContext({
        messages: [{ role: "user", content: "New instruction", timestamp: 2 }],
      })).result();
      assert.equal(next.stopReason, "stop");
      assert.equal(requests, 2);
    } finally {
      await first?.close();
      await reopened?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

test("two concurrent streams for one user submit at most one model request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-turn-concurrent-"));
  let requests = 0;
  let started!: () => void;
  const admitted = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void;
  const released = new Promise<void>(resolve => { finish = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // The held stream keeps its transport open during the second invocation.
    }
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({
        protocol: 1,
        session_id: "concurrent",
        token: "cap",
        models: [{ id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 }],
      }));
    } else if (req.method === "DELETE" || req.url?.endsWith("/cancel")) {
      res.end("{}");
    } else {
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${requests}` } })}\n\n`);
      started();
      if (requests > 1) finish();
      await released;
      res.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: { id: `resp_${requests}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createCodexWebProvider({
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    pairingToken: "pair",
    cwd: dir,
    sessionId: "pi-session",
  });
  const model = { ...provider.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: provider.config.baseUrl } as any;
  const context = normalizeContext({ messages: [{ role: "user", content: "Run", timestamp: 1 }] });
  try {
    const first = provider.config.streamSimple!(model, context).result();
    await admitted;
    const second = await provider.config.streamSimple!(model, context).result();
    assert.equal(second.stopReason, "error");
    assert.equal(requests, 1);
    finish();
    assert.equal((await first).stopReason, "stop");
  } finally {
    finish();
    await provider.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("SIGKILL during model delivery blocks that turn in a new Pi process", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "web-turn-process-"));
  const sessionFile = join(dir, "sessions", "session.jsonl");
  await mkdir(join(dir, "sessions"));
  let requests = 0;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // The first response stays incomplete until its owning process is killed.
    }
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({
        protocol: 1,
        session_id: "process_fixture",
        token: "cap",
        models: [{ id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 }],
      }));
    } else if (req.method === "DELETE" || req.url?.endsWith("/cancel")) {
      res.end("{}");
    } else {
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: `resp_${requests}` } })}\n\n`);
      started();
      if (requests === 1) await released;
      res.end(`data: ${JSON.stringify({
        type: "response.completed",
        response: { id: `resp_${requests}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      })}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    join(import.meta.dirname, "support", "codex-web-model-child.mjs"),
    origin,
    dir,
    sessionFile,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let reopened;
  try {
    await requestStarted;
    assert.equal(requests, 1);
    child.kill("SIGKILL");
    await exited;
    release();
    reopened = await createCodexWebProvider({ origin, pairingToken: "pair", cwd: dir, sessionId: "pi-session", sessionFile });
    const model = { ...reopened.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: reopened.config.baseUrl } as any;
    const original = normalizeContext({ messages: [{ role: "user", content: "Run once", timestamp: 1 }] });
    assert.equal((await reopened.config.streamSimple!(model, original).result()).stopReason, "error");
    assert.equal(requests, 1);
    const fresh = normalizeContext({ messages: [{ role: "user", content: "New instruction", timestamp: 2 }] });
    assert.equal((await reopened.config.streamSimple!(model, fresh).result()).stopReason, "stop");
    assert.equal(requests, 2);
  } finally {
    release();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await reopened?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
