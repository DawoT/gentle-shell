import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CodexWebClient } from "../lib/codex-web/client.ts";

async function fixture(recoveryReply?: unknown) {
  const seen: Array<{ url: string; headers: Record<string, unknown>; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    seen.push({ url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : null });
    res.setHeader("content-type", "application/json");
    if (req.url === "/host/v1/sessions") {
      res.end(JSON.stringify({ protocol: 1, session_id: "session_test", token: "cap_test", models: [
        { id: "chatgpt-web/test", name: "Test", reasoning: true, contextWindow: 10000, maxTokens: 1000 },
      ] }));
    } else if (req.url === "/host/v1/sessions/session_test/recovery") {
      res.end(JSON.stringify(recoveryReply ?? {
        scope: "bridge-model-only",
        turn_id: "turn-one",
        state: "model-completed",
        cancellation: null,
        last_completed_sequence: 1,
        last_completed_response_id: "resp_1",
        replay_allowed: false,
      }));
    } else {
      res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { seen, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("pairing and requests keep session authority out of caller-controlled headers", async () => {
  const api = await fixture();
  try {
    const client = new CodexWebClient(api.origin);
    await client.connect("pair-secret", "/workspace");
    const response = await client.request("turn-one", { model: "chatgpt-web/test", input: [] }, {
      headers: { authorization: "Bearer forged", "x-cgw-sequence": "1000", "x-cgw-session-id": "foreign" },
    });
    await response.text();
    assert.equal(api.seen[0].headers.authorization, "Bearer pair-secret");
    assert.deepEqual(api.seen[0].body, { protocol: 1, host: "pi", cwd: "/workspace" });
    assert.equal(api.seen[1].headers.authorization, "Bearer cap_test");
    assert.equal(api.seen[1].headers["x-cgw-session-id"], "session_test");
    assert.equal(api.seen[1].headers["x-cgw-sequence"], "1");
    await client.close();
    await assert.rejects(client.request("turn-two", {}), /not connected/);
  } finally {
    await api.close();
  }
});

test("recovery inspection rejects replay authority and extra response fields", async () => {
  for (const reply of [
    {
      scope: "bridge-model-only", turn_id: "turn-one", state: "admitted",
      cancellation: null, last_completed_sequence: null, last_completed_response_id: null,
      replay_allowed: true,
    },
    {
      scope: "bridge-model-only", turn_id: "turn-one", state: "admitted",
      cancellation: null, last_completed_sequence: null, last_completed_response_id: null,
      replay_allowed: false, token: "must-not-expose",
    },
    {
      scope: "bridge-model-only", turn_id: "turn-one", state: "model-completed",
      cancellation: null, last_completed_sequence: null, last_completed_response_id: null,
      replay_allowed: false,
    },
  ]) {
    const api = await fixture(reply);
    const client = new CodexWebClient(api.origin);
    try {
      await client.connect("pair-secret", "/workspace", "a".repeat(64));
      await assert.rejects(client.inspectRecovery(), /Invalid bridge recovery status/);
    } finally {
      await client.close();
      await api.close();
    }
  }
});

test("persistent pairing can inspect host recovery with its new capability", async () => {
  const api = await fixture();
  const client = new CodexWebClient(api.origin);
  try {
    const scope = "a".repeat(64);
    await client.connect("pair-secret", "/workspace", scope);
    assert.deepEqual(api.seen[0].body, {
      protocol: 1,
      host: "pi",
      cwd: "/workspace",
      recovery_scope: scope,
    });
    assert.deepEqual(await client.inspectRecovery(), {
      scope: "bridge-model-only",
      turn_id: "turn-one",
      state: "model-completed",
      cancellation: null,
      last_completed_sequence: 1,
      last_completed_response_id: "resp_1",
      replay_allowed: false,
    });
    const inspection = api.seen.at(-1)!;
    assert.equal(inspection.headers.authorization, "Bearer cap_test");
    assert.equal(inspection.headers["x-cgw-sequence"], undefined);
  } finally {
    await client.close();
    await api.close();
  }
});

test("client rejects remote, credential-bearing and redirected pairing destinations", async () => {
  for (const origin of ["https://example.com", "http://user:password@127.0.0.1:17841", "http://127.0.0.1:17841/path"]) {
    assert.throws(() => new CodexWebClient(origin), /loopback/);
  }
  const server = createServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/secret" });
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await assert.rejects(client.connect("pair-secret", "/workspace"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("closing during pairing cannot resurrect the connection", async () => {
  let release!: () => void;
  let started!: () => void;
  const handshakeStarted = new Promise<void>(resolve => { started = resolve; });
  const server = createServer((_req, res) => {
    release = () => res.end(JSON.stringify({ protocol: 1, session_id: "late", token: "late-cap", models: [] }));
    started();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const pending = client.connect("pair-secret", "/workspace").catch(error => error);
    await handshakeStarted;
    await client.close();
    release();
    await pending;
    assert.equal(client.connected, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("concurrent pairing keeps the newer HTTP session when the older response is released late", async () => {
  let releaseOld!: () => void;
  let started!: () => void;
  const oldStarted = new Promise<void>(resolve => { started = resolve; });
  let paired = 0;
  const authorities: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    if (req.url === "/host/v1/sessions") {
      paired += 1;
      const number = paired;
      const reply = () => res.end(JSON.stringify({
        protocol: 1,
        session_id: `session_${number}`,
        token: `cap_${number}`,
        models: [],
      }));
      if (number === 1) {
        releaseOld = reply;
        started();
      } else {
        reply();
      }
    } else {
      authorities.push(req.headers.authorization);
      res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const client = new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  try {
    const old = client.connect("pair-secret", "/workspace").then(() => "connected", () => "rejected");
    await oldStarted;
    await client.connect("pair-secret", "/workspace");
    releaseOld();
    assert.equal(await old, "rejected");
    assert.equal(client.connected, true);
    await (await client.request("turn-current", {})).text();
    assert.deepEqual(authorities, ["Bearer cap_2"]);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a late unauthorized response cannot disconnect a newer session", async t => {
  // Native fetch aborts held HTTP responses on reconnect. This transport intentionally
  // delivers a late response despite cancellation to exercise the generation boundary.
  let releaseOld!: (response: Response) => void;
  let paired = 0;
  const sent: Array<{ url: string; authorization: string | null }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get("authorization");
    sent.push({ url, authorization });
    if (url.endsWith("/host/v1/sessions")) {
      paired += 1;
      return new Response(JSON.stringify({ protocol: 1, session_id: `session_${paired}`, token: `cap_${paired}`, models: [] }));
    }
    if (url.endsWith("/responses") && authorization === "Bearer cap_1") {
      return new Promise<Response>(resolve => { releaseOld = resolve; });
    }
    return new Response("{}");
  });
  const client = new CodexWebClient();
  try {
    await client.connect("pair-secret", "/workspace");
    const old = client.request("shared-turn", {});
    await client.connect("pair-secret", "/workspace");
    releaseOld(new Response("{}", { status: 401 }));
    await (await old).text();
    assert.equal(client.connected, true);
    await (await client.request("shared-turn", {})).text();
    assert.equal(sent.at(-1)?.authorization, "Bearer cap_2");
    const cancels = sent.filter(request => request.url.endsWith("/cancel"));
    assert.equal(cancels.length, 1);
    assert.match(cancels[0].url, /session_1\/turns\/shared-turn\/cancel$/);
    assert.equal(cancels[0].authorization, "Bearer cap_1");
  } finally {
    await client.close();
  }
});

test("current session unauthorized response aborts its other active requests", async t => {
  let waitingSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/host/v1/sessions")) {
      return new Response(JSON.stringify({ protocol: 1, session_id: "session", token: "cap", models: [] }));
    }
    if (url.endsWith("/responses") && new Headers(init.headers).get("x-cgw-turn-id") === "waiting") {
      waitingSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => waitingSignal!.addEventListener("abort", () => reject(waitingSignal!.reason), { once: true }));
    }
    if (url.endsWith("/responses")) return new Response("{}", { status: 401 });
    return new Response("{}");
  });
  const client = new CodexWebClient();
  await client.connect("pair-secret", "/workspace");
  const waiting = client.request("waiting", {}).catch(error => error);
  await client.request("unauthorized", {});
  assert.equal(waitingSignal?.aborted, true);
  await waiting;
  assert.equal(client.connected, false);
  await client.close();
});

for (const operation of ["pairing", "health", "cancel"] as const) {
  test(`${operation} rejects an oversized streamed JSON body before its sender finishes`, async () => {
    const { probeCodexWebHost } = await import("../lib/codex-web/settings.ts");
    let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the request; the response intentionally has no Content-Length or EOF.
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "DELETE") {
        res.end("{}");
      } else if (operation === "cancel" && req.url === "/host/v1/sessions") {
        res.end(JSON.stringify({ protocol: 1, session_id: "test", token: "cap", models: [] }));
      } else {
        const budget = operation === "cancel" ? 64 * 1024 : 256 * 1024;
        res.write('{"padding":"' + "é".repeat(budget / 2 + 1));
        started();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new CodexWebClient(origin);
    try {
      if (operation === "cancel") await client.connect("pair-secret", "/workspace");
      const pending = (operation === "pairing" ? client.connect("pair-secret", "/workspace")
        : operation === "health" ? probeCodexWebHost(origin) : client.cancel("turn-one"))
        .then(() => "accepted", error => error.message);
      await sent;
      const outcome = await Promise.race([pending, new Promise<string>(resolve => setTimeout(() => resolve("still waiting for EOF"), 250))]);
      assert.match(outcome, /exceeds.*size budget/, "the byte budget must stop streaming ingestion before EOF");
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

for (const phase of ["headers", "body"] as const) {
  test(`transport failure during ${phase} retires the accepted remote turn without replay`, async () => {
    let requests = 0;
    let cancelled!: () => void;
    const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Requests are accepted before the peer deliberately drops its transport.
      }
      if (req.url === "/host/v1/sessions") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ protocol: 1, session_id: "failed", token: "cap", models: [] }));
      } else if (req.url?.endsWith("/cancel")) {
        cancelled();
        res.end('{"state":"settled"}');
      } else if (req.method === "DELETE") {
        res.end("{}");
      } else {
        requests += 1;
        if (phase === "body") {
          res.writeHead(200, { "content-type": "text/event-stream", "content-length": "1000" });
          res.write("data: partial\n\n");
          setTimeout(() => res.destroy(), 10);
        } else {
          res.destroy();
        }
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const client = new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    try {
      await client.connect("pair-secret", "/workspace");
      await assert.rejects(async () => {
        const response = await client.request("failed-turn", {});
        await response.text();
      });
      const retired = await Promise.race([cancellation.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250))]);
      assert.equal(retired, true, "uncertain delivery must request scoped remote cancellation");
      await assert.rejects(client.request("failed-turn", {}), /uncertain/);
      assert.equal(requests, 1, "a lost transport must not replay the accepted request");
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
