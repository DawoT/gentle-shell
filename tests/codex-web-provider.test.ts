import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolReceipts } from "../lib/codex-web/tool-receipts.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createCodexWebProvider } from "../lib/codex-web/provider.ts";

const modelRow = { id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 };

test("provider renews only a 401 proven to precede host admission", async () => {
  for (const preAdmission of [false, true]) {
    let pairs = 0;
    let requests = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the real HTTP transport request.
      }
      if (req.url === "/host/v1/sessions") {
        pairs += 1;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ protocol: 1, session_id: `host_${pairs}`, token: `cap_${pairs}`, models: [modelRow] }));
        return;
      }
      if (req.method === "DELETE" || req.url?.endsWith("/cancel")) {
        res.end("{}");
        return;
      }
      assert.equal(req.url, "/host/v1/responses");
      requests += 1;
      if (requests === 1) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        if (preAdmission) res.setHeader("x-cgw-admission", "rejected");
        res.end(JSON.stringify({ error: {
          type: "host_protocol_error",
          message: preAdmission ? "Capability expired" : "ChatGPT session expired",
          ...(preAdmission ? { code: "host_capability_invalid" } : {}),
        } }));
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_recovered" } })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "resp_recovered", status: "completed", output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } })}\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const provider = await createCodexWebProvider({ origin, pairingToken: "secret", cwd: "/workspace", sessionId: "primary" });
    try {
      const model = { ...provider.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: provider.config.baseUrl } as any;
      const result = await provider.config.streamSimple!(model, normalizeContext({
        messages: [{ role: "user", content: "Once", timestamp: 1 }],
      })).result();
      assert.equal(pairs, preAdmission ? 2 : 1);
      assert.equal(requests, preAdmission ? 2 : 1, "a post-admission 401 must not be resubmitted");
      assert.equal(result.stopReason, preAdmission ? "stop" : "error");
    } finally {
      await provider.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test("invalid output budget creates no recovery admission or model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "budget-admission-"));
  const sessionFile = join(root, "session.jsonl");
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain protocol input.
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({ protocol: 1, session_id: "budget", token: "cap", models: [modelRow] }));
    } else {
      if (req.url === "/host/v1/responses") requests += 1;
      res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = await createCodexWebProvider({ origin, pairingToken: "secret", cwd: root, sessionId: "primary", sessionFile });
  try {
    const config = provider.config;
    const model = { ...config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: config.baseUrl } as any;
    const result = await config.streamSimple!(model, normalizeContext({
      messages: [{ role: "user", content: "Preserve this request", timestamp: 1 }],
    }), {
      onPayload: (payload: any) => ({ ...payload, max_output_tokens: 10000 }),
    }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(requests, 0);
    const journal = new ToolReceipts("primary", root, sessionFile);
    assert.deepEqual((await journal.list()).receipts, [], "rejected input must not acquire immutable recovery claims");
    assert.equal(provider.inspectContext(), undefined, "no attempted-delivery snapshot for a rejected payload");
    assert.match(result.errorMessage ?? "", /output reserve/i, "local validation must not be reported as a transport failure");
  } finally {
    await provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi Responses translation preserves facts tool IDs through the host continuation", async () => {
  const requests: Array<{ body: any; headers: any }> = [];
  let sessions = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/host/v1/sessions") {
      sessions += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ protocol: 1, session_id: `session_${sessions}`, token: `cap_${sessions}`, models: [modelRow] }));
      return;
    }
    if (req.method === "DELETE") {
      res.end("{}");
      return;
    }
    if (req.method === "GET") {
      const previous = requests.at(-1)!;
      res.end(JSON.stringify({
        session_id: previous.headers["x-cgw-session-id"], turn_id: previous.headers["x-cgw-turn-id"],
        state: "idle", cancellation: null, request_sequence: 2, last_completed_sequence: 2,
        last_completed_response_id: "resp_2", response_retained: true, pending_tool_calls: 0,
        scope: "bridge-http-and-browser-only", replay_allowed: false,
      }));
      return;
    }
    const body = JSON.parse(raw);
    requests.push({ body, headers: req.headers });
    const item = requests.length === 1
      ? { type: "function_call", id: "fc_facts", call_id: "call_facts", name: "facts_query", arguments: '{"query":"login"}', status: "completed" }
      : { type: "message", id: "msg_done", role: "assistant", content: [{ type: "output_text", text: "Verified", annotations: [] }], status: "completed" };
    res.setHeader("content-type", "text/event-stream");
    const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: "response.created", response: { id: `resp_${requests.length}` } });
    emit({ type: "response.output_item.added", output_index: 0, item });
    emit({ type: "response.output_item.done", output_index: 0, item });
    emit({ type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = await createCodexWebProvider({ origin, pairingToken: "local-secret", cwd: "/workspace", sessionId: "primary" });
  try {
    assert.equal(await provider.inspect(), undefined, "inspection before first turn does not start work");
    const config = provider.config;
    const model = { ...config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: config.baseUrl } as any;
    const user = { role: "user" as const, content: "Inspect login", timestamp: 1 };
    const tool = { name: "facts_query", description: "Query symbols", parameters: { type: "object", properties: { query: { type: "string" } } } };
    let callbacks = 0;
    const controller = new AbortController();
    const first = await config.streamSimple!(model, normalizeContext({ messages: [user], tools: [tool] as any }), {
      sessionId: "primary", signal: controller.signal, onPayload: (payload: any) => {
        callbacks += 1;
        return { ...payload, instructions: "Transport instructions " + "x".repeat(500) };
      },
    }).result();
    const firstContext = (provider as any).inspectContext("primary");
    assert.equal(firstContext.model_context_window, 10000);
    assert.equal(firstContext.output_reserve_tokens, 1000);
    assert.equal(firstContext.target_input_tokens, 9000);
    assert.equal(firstContext.status, "within_target");
    assert.equal(firstContext.components.system.messages, 1);
    assert.equal(firstContext.components.user.messages, 1);
    assert.equal(firstContext.components.tool_declarations.items, 1);
    assert.ok(firstContext.total_bytes > 0);
    assert.equal(firstContext.total_bytes, Buffer.byteLength(JSON.stringify(requests[0].body), "utf8"));
    assert.equal(firstContext.measurement_scope, "sanitized_responses_payload");
    assert.ok(firstContext.estimated_input_tokens > 0);
    assert.equal(JSON.stringify(firstContext).includes("Inspect login"), false);
    assert.equal(JSON.stringify(firstContext).includes("Query symbols"), false);
    assert.equal((provider as any).inspectContext("unknown-affinity"), undefined);
    assert.equal(first.stopReason, "toolUse");
    const call = first.content.find(part => part.type === "toolCall")!;
    assert.equal(call.name, "facts_query");
    assert.deepEqual(call.arguments, { query: "login" });
    const second = await config.streamSimple!(model, normalizeContext({ messages: [user, first, {
      role: "toolResult", toolCallId: call.id, toolName: "facts_query", content: [{ type: "text", text: "login(user): Session" }], isError: false, timestamp: 2,
    }], tools: [tool] as any }), { sessionId: "primary", signal: controller.signal }).result();
    assert.equal(second.stopReason, "stop");
    const output = requests[1].body.input.find((item: any) => item.type === "function_call_output");
    assert.equal(output.call_id, "call_facts");
    assert.equal(requests[0].headers["x-cgw-turn-id"], requests[1].headers["x-cgw-turn-id"]);
    assert.equal(requests[1].headers["x-cgw-sequence"], "2");
    assert.equal(callbacks, 1);
    assert.equal(sessions, 1);
    assert.equal(await provider.inspect("unknown-affinity"), undefined);
    const inspection = await provider.inspect();
    assert.equal(inspection?.turn_id, requests[1].headers["x-cgw-turn-id"]);
    assert.equal(inspection?.state, "idle");
    assert.equal(sessions, 1, "inspection must not pair another client");
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.length, 2, "completed turns must release the agent abort subscription");
  } finally {
    await provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("aborting Pi between model rounds retires the pending host tool turn", async () => {
  const cancellations: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the local protocol request before replying.
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({ protocol: 1, session_id: "pending", token: "cap", models: [modelRow] }));
    } else if (req.url?.endsWith("/cancel")) {
      cancellations.push(req.url);
      res.end('{"state":"settled"}');
    } else if (req.method === "DELETE") {
      res.end("{}");
    } else {
      const item = { type: "function_call", id: "fc_pending", call_id: "call_pending", name: "bash", arguments: '{"command":"sleep 30"}', status: "completed" };
      res.setHeader("content-type", "text/event-stream");
      for (const event of [
        { type: "response.created", response: { id: "resp_pending" } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "resp_pending", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = await createCodexWebProvider({ origin, pairingToken: "local-secret", cwd: "/workspace", sessionId: "primary" });
  try {
    const config = provider.config;
    const model = { ...config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: config.baseUrl } as any;
    const controller = new AbortController();
    const result = await config.streamSimple!(model, normalizeContext({ messages: [{ role: "user", content: "Run", timestamp: 1 }] }), { signal: controller.signal }).result();
    assert.equal(result.stopReason, "toolUse");
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(cancellations.length, 1, "completed HTTP transport must retain agent cancellation during tool execution");
  } finally {
    await provider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("inspection completed after a new user turn does not report the old turn as current", async () => {
  let inspected!: () => void;
  const inspecting = new Promise<void>(resolve => { inspected = resolve; });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume host transport requests before serving controlled metadata.
    }
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({ protocol: 1, session_id: "inspection", token: "cap", models: [modelRow] }));
    } else if (req.method === "GET") {
      inspected();
      await released;
      res.end(JSON.stringify({
        session_id: "inspection", turn_id: decodeURIComponent(req.url!.split("/").at(-1)!),
        state: "idle", cancellation: null, request_sequence: 1, last_completed_sequence: 1,
        last_completed_response_id: "response_1", response_retained: true, pending_tool_calls: 0,
        scope: "bridge-http-and-browser-only", replay_allowed: false,
      }));
    } else if (req.method === "DELETE") {
      res.end("{}");
    } else {
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      for (const event of [
        { type: "response.created", response: { id: `response_${requests}` } },
        { type: "response.completed", response: { id: `response_${requests}`, status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const provider = await createCodexWebProvider({ origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, pairingToken: "pair", cwd: "/workspace", sessionId: "primary" });
  const model = { ...provider.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: provider.config.baseUrl } as any;
  try {
    await provider.config.streamSimple!(model, normalizeContext({ messages: [{ role: "user", content: "First", timestamp: 1 }] })).result();
    const status = provider.inspect();
    await inspecting;
    await provider.config.streamSimple!(model, normalizeContext({ messages: [{ role: "user", content: "Second", timestamp: 2 }] })).result();
    release();
    assert.equal(await status, undefined);
    assert.equal(requests, 2);
  } finally {
    release();
    await provider.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
