import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CodexWebClient } from "../lib/codex-web/client.ts";

function state(session = "session_1") {
  return {
    session_id: session, turn_id: "turn_1", state: "idle", cancellation: null,
    request_sequence: 1, last_completed_sequence: 1, last_completed_response_id: "response_1",
    response_retained: true, pending_tool_calls: 1,
    scope: "bridge-http-and-browser-only", replay_allowed: false,
  };
}

async function fixture() {
  let mode = "valid";
  let sessions = 0;
  let reply: unknown;
  const seen: Array<{ method: string; url: string; authorization: unknown; sequence: unknown }> = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume requests before returning controlled protocol replies.
    }
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, sequence: req.headers["x-cgw-sequence"] });
    if (req.url === "/host/v1/sessions") {
      sessions += 1;
      res.end(JSON.stringify({ protocol: 1, session_id: `session_${sessions}`, token: `cap_${sessions}`, models: [] }));
    } else if (req.method === "GET") {
      if (mode === "unauthorized") {
        res.writeHead(401);
        res.end("{}");
      } else if (mode === "oversized") {
        res.writeHead(200);
        res.write("x".repeat(65537));
      } else if (mode === "stalled") {
        res.writeHead(200);
        res.write("{\"session_id\":");
      } else if (mode === "redirect") {
        res.writeHead(302, { location: "/other" });
        res.end();
      } else {
        res.end(JSON.stringify(reply ?? (mode === "extra" ? { ...state(`session_${sessions}`), token: "must-not-expose" } : state(`session_${sessions}`))));
      }
    } else if (req.url === "/host/v1/responses" && mode === "uncertain") {
      res.destroy();
    } else {
      res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    client: new CodexWebClient(`http://127.0.0.1:${(server.address() as { port: number }).port}`), seen,
    mode: (value: string) => { mode = value; },
    reply: (value: unknown) => { reply = value; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test("inspection uses exact capability without consuming sequence or clearing uncertain delivery", async () => {
  const api = await fixture();
  try {
    await api.client.connect("pair", "/workspace");
    api.mode("uncertain");
    await assert.rejects(api.client.request("turn_1", {}));
    api.mode("valid");
    assert.deepEqual(await api.client.inspectTurn("turn_1"), state());
    const inspection = api.seen.find(request => request.method === "GET")!;
    assert.equal(inspection.authorization, "Bearer cap_1");
    assert.equal(inspection.sequence, undefined);
    await assert.rejects(api.client.request("turn_1", {}), /web-bridge status/);
    await (await api.client.request("turn_2", {})).text();
    assert.equal(api.seen.filter(request => request.url === "/host/v1/responses").at(-1)?.sequence, "2");
  } finally {
    await api.client.close();
    await api.close();
  }
});

for (const mode of ["oversized", "extra", "redirect", "unauthorized"] as const) {
  test(`inspection rejects ${mode} control replies`, async () => {
    const api = await fixture();
    try {
      await api.client.connect("pair", "/workspace");
      api.mode(mode);
      await assert.rejects(api.client.inspectTurn("turn_1"));
      assert.equal(api.client.connected, mode !== "unauthorized");
    } finally {
      await api.client.close();
      await api.close();
    }
  });
}

for (const late of ["body", "unauthorized"] as const) {
  test(`late ${late} inspection cannot cross a reconnect generation`, async () => {
    const api = await fixture();
    const nativeFetch = globalThis.fetch;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    globalThis.fetch = async (input, init) => {
      if (init?.method === "GET") {
        ready();
        if (late === "unauthorized") {
          await released;
          return new Response("{}", { status: 401 });
        }
        return new Response(new ReadableStream({
          async start(controller) {
            await released;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(state())));
            controller.close();
          },
        }));
      }
      return nativeFetch(input, init);
    };
    try {
      await api.client.connect("pair", "/workspace");
      const inspection = api.client.inspectTurn("turn_1").then(() => "accepted", () => "rejected");
      await started;
      await api.client.connect("pair", "/workspace");
      release();
      assert.equal(await inspection, "rejected");
      assert.equal(api.client.connected, true);
      globalThis.fetch = nativeFetch;
      assert.deepEqual(await api.client.inspectTurn("turn_1"), state("session_2"));
      assert.equal(api.seen.filter(request => request.method === "DELETE").length, 1);
    } finally {
      release();
      globalThis.fetch = nativeFetch;
      await api.client.close();
      await api.close();
    }
  });
}

test("inspection enforces metadata field bounds and exact session identity", async () => {
  const api = await fixture();
  try {
    await api.client.connect("pair", "/workspace");
    for (const overrides of [
      { session_id: "foreign" }, { turn_id: "foreign" }, { state: "completed" },
      { cancellation: "success" }, { request_sequence: 0 }, { last_completed_sequence: -1 },
      { last_completed_response_id: 4 }, { response_retained: "true" },
      { pending_tool_calls: -1 }, { pending_tool_calls: 4097 }, { pending_tool_calls: 0.5 },
      { scope: "host-commands" }, { replay_allowed: true },
    ]) {
      api.reply({ ...state(), ...overrides });
      await assert.rejects(api.client.inspectTurn("turn_1"), /Invalid bridge turn status/);
    }
    api.reply({ ...state(), request_sequence: null, last_completed_sequence: null, last_completed_response_id: null, response_retained: false, pending_tool_calls: 0, state: "unknown" });
    assert.equal((await api.client.inspectTurn("turn_1")).state, "unknown");
  } finally {
    await api.client.close();
    await api.close();
  }
});

test("inspection deadline bounds a stalled JSON body", { timeout: 5000 }, async () => {
  const api = await fixture();
  try {
    await api.client.connect("pair", "/workspace");
    api.mode("stalled");
    await assert.rejects(api.client.inspectTurn("turn_1"));
    assert.equal(api.client.connected, true);
  } finally {
    await api.client.close();
    await api.close();
  }
});
