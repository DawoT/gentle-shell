import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CodexWebClient } from "../lib/codex-web/client.ts";
import { SseDelivery } from "../lib/codex-web/sse-delivery.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createCodexWebProvider } from "../lib/codex-web/provider.ts";

async function fixture(events: string, status = 200) {
  let requests = 0;
  let cancellations = 0;
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => {
    cancelled = resolve;
  });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the request before deliberately ending its SSE response.
    }
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({ protocol: 1, session_id: "recovery", token: "cap", models: [] }));
    } else if (req.url?.endsWith("/cancel")) {
      cancellations += 1;
      cancelled();
      res.end('{"state":"settled"}');
    } else if (req.method === "DELETE") {
      res.end("{}");
    } else {
      requests += 1;
      res.setHeader("content-type", "text/event-stream");
      res.statusCode = status;
      res.end(events);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await client.connect("pair", "/workspace");
  return {
    client,
    counts: () => ({ requests, cancellations }),
    cancellation,
    async close() {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

for (const ending of ["empty", "done-marker", "tool-without-completion", "foreign-completion"] as const) {
  test(`clean HTTP EOF with ${ending} retires the turn instead of permitting a replay`, { timeout: 5000 }, async () => {
    const created = 'data: {"type":"response.created","response":{"id":"resp_one"}}\n\n';
    const endings = {
      empty: "",
      "done-marker": "data: [DONE]\n\n",
      "tool-without-completion": 'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_one","name":"bash","arguments":"{}"}}\n\n',
      "foreign-completion": 'data: {"type":"response.completed","response":{"id":"foreign","status":"completed","output":[]}}\n\n',
    };
    const api = await fixture(created + endings[ending]);
    try {
      const response = await api.client.request("turn_one", {});
      await assert.rejects(response.text(), /terminal|completion|incomplete|identity/i);
      await assert.rejects(api.client.request("turn_one", {}), /uncertain/);
      await api.cancellation;
      assert.equal(api.counts().requests, 1);
      assert.equal(api.counts().cancellations, 1);
      assert.equal(api.client.connected, true, "a failed turn must not silently re-pair its session");
    } finally {
      await api.close();
    }
  });
}

test("SSE terminal framing survives single-byte UTF-8, CRLF and multiline data chunks", () => {
  const delivery = new SseDelivery();
  const events = ': comentario ñ\r\n\r\n'
    + 'data: {"type":"response.created","response":{"id":"resp_one"}}\r\n\r\n'
    + 'data: {"type":"response.completed",\r\ndata: "response":{"id":"resp_one","status":"completed","output":[]}}\r\n\r\n';
  for (const byte of Buffer.from(events)) {
    delivery.push(Uint8Array.of(byte));
  }
  assert.doesNotThrow(() => delivery.finish());
});

test("terminal-looking text and an unterminated completion frame are not delivery proof", () => {
  for (const suffix of [
    'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_one","status":"completed","output":[]}}\n',
    'data: {"type":"response.completed","response":{"id":"resp_one","status":"completed","output":[]}}\n\ndata\n',
  ]) {
    const delivery = new SseDelivery();
    delivery.push(Buffer.from('data: {"type":"response.created","response":{"id":"resp_one"}}\n\n' + suffix));
    assert.throws(() => delivery.finish(), /terminal/);
  }
});

test("an SSE event without a terminating newline cannot grow past its budget", () => {
  const delivery = new SseDelivery();
  const chunk = Buffer.alloc(1024 * 1024, 97);
  for (let index = 0; index < 8; index += 1) {
    delivery.push(chunk);
  }
  assert.throws(() => delivery.push(Uint8Array.of(97)), /size budget/);
});

for (const failure of ["truncated", "explicit-failure-with-open-connection"]) {
  test(`Pi retires ${failure} without resubmitting and permits a distinct user turn`, { timeout: 5000 }, async () => {
    const requests: string[] = [];
    let cancellations = 0;
    let sessions = 0;
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Only the browser/model boundary is scripted; the Pi provider and SDK are real.
      }
      if (req.url === "/host/v1/sessions") {
        sessions += 1;
        res.end(JSON.stringify({
          protocol: 1,
          session_id: "sdk_recovery",
          token: "cap",
          models: [{ id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 }],
        }));
      } else if (req.url?.endsWith("/cancel")) {
        cancellations += 1;
        res.end('{"state":"settled"}');
      } else if (req.method === "DELETE") {
        res.end("{}");
      } else {
        requests.push(String(req.headers["x-cgw-turn-id"]));
        res.setHeader("content-type", "text/event-stream");
        res.write('data: {"type":"response.created","response":{"id":"resp_one"}}\n\n');
        if (requests.length === 1) {
          if (failure === "explicit-failure-with-open-connection") {
            res.write('data: {"type":"response.failed","response":{"id":"resp_one","status":"failed","output":[],"error":{"code":"fixture_failure","message":"deliberate provider failure"}}}\n\n');
            return;
          }
          const item = { type: "function_call", id: "fc_one", call_id: "call_one", name: "bash", arguments: '{"command":"printf once"}' };
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`);
        } else {
          res.write('data: {"type":"response.completed","response":{"id":"resp_one","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n');
        }
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const provider = await createCodexWebProvider({
      origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      pairingToken: "pair",
      cwd: "/workspace",
      sessionId: "primary",
    });
    const model = { ...provider.config.models![0], provider: "gentle-codex-web", api: "openai-responses", baseUrl: provider.config.baseUrl } as any;
    const context = normalizeContext({ messages: [{ role: "user", content: "Run once", timestamp: 1 }] });
    try {
      const first = await provider.config.streamSimple!(model, context).result();
      assert.equal(first.stopReason, "error", "partial calls must never become executable toolUse");
      const retry = await provider.config.streamSimple!(model, context).result();
      assert.equal(retry.stopReason, "error");
      assert.equal(requests.length, 1, "same-turn retry must not reach the model");
      const next = await provider.config.streamSimple!(model, normalizeContext({ messages: [{ role: "user", content: "Inspect instead", timestamp: 2 }] })).result();
      assert.equal(next.stopReason, "stop");
      assert.equal(requests.length, 2);
      assert.notEqual(requests[0], requests[1]);
      assert.equal(sessions, 1, "no automatic capability replacement");
      assert.equal(cancellations, 1);
    } finally {
      await provider.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test("accepted HTTP response without a body retires the turn", { timeout: 5000 }, async () => {
  const api = await fixture("", 204);
  try {
    await assert.rejects(api.client.request("turn_one", {}), /body|terminal/);
    await assert.rejects(api.client.request("turn_one", {}), /uncertain/);
    await api.cancellation;
    assert.equal(api.counts().requests, 1);
    assert.equal(api.counts().cancellations, 1);
  } finally {
    await api.close();
  }
});

test("an HTTP rejection is preserved rather than interpreted as a truncated stream", async () => {
  const api = await fixture("", 400);
  try {
    const response = await api.client.request("turn_one", {});
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "");
    assert.equal((await api.client.request("turn_one", {})).status, 400);
    assert.equal(api.counts().cancellations, 0);
  } finally {
    await api.close();
  }
});

test("a valid completed SSE response permits the next model round on the same turn", async () => {
  const events = 'data: {"type":"response.created","response":{"id":"resp_one"}}\r\n\r\n'
    + 'data: {"type":"response.completed",\r\ndata: "response":{"id":"resp_one","status":"completed","output":[]}}\r\n\r\n'
    + 'data: [DONE]\r\n\r\n';
  const api = await fixture(events);
  try {
    assert.equal(await (await api.client.request("turn_one", {})).text(), events);
    assert.equal(await (await api.client.request("turn_one", {})).text(), events);
    assert.equal(api.counts().requests, 2);
    assert.equal(api.counts().cancellations, 0);
  } finally {
    await api.close();
  }
});

for (const type of ["response.failed", "response.incomplete", "error"]) {
  test(`${type} is a known failure, not an ambiguous missing terminal`, async () => {
    const events = 'data: {"type":"response.created","response":{"id":"resp_one"}}\n\n'
      + `data: ${JSON.stringify({ type, response: { id: "resp_one", status: type.split(".").at(-1), output: [] } })}\n\n`;
    const api = await fixture(events);
    try {
      assert.equal(await (await api.client.request("turn_one", {})).text(), events);
      assert.equal(await (await api.client.request("turn_one", {})).text(), events);
      assert.equal(api.counts().cancellations, 0);
    } finally {
      await api.close();
    }
  });
}
