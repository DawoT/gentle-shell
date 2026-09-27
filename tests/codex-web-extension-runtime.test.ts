import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("installed Pi loads the bridge extension, registers its model and revokes its session on shutdown", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-runtime-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "source.ts"), "export function double(value: number): number { return value * 2; }\n");
  execFileSync("git", ["add", "source.ts"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Runtime Test", "-c", "user.email=runtime@example.invalid", "commit", "-m", "fixture"], { cwd: root });
  const methods: string[] = [];
  const requests: any[] = [];
  const pairingScopes: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    methods.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") res.end(JSON.stringify({ hostProtocol: 1 }));
    else if (req.url === "/host/v1/sessions") {
      assert.equal(req.headers.authorization, "Bearer runtime-pairing");
      pairingScopes.push(JSON.parse(body).recovery_scope);
      res.end(JSON.stringify({ protocol: 1, session_id: "runtime", token: "runtime-cap", models: [
        { id: "chatgpt-web/runtime", name: "Runtime Web", reasoning: true, contextWindow: 10000, maxTokens: 1000 },
      ] }));
    } else if (req.url === "/host/v1/responses") {
      requests.push(JSON.parse(body));
      const round = requests.length;
      const item = round < 4
        ? { type: "function_call", id: `fc_${round}`, call_id: `call_${round}`,
          name: round === 1 ? "facts_query" : round === 2 ? "context_status" : "bash",
          arguments: round === 1 ? '{"name":"double"}' : round === 2 ? "{}" : '{"command":"printf denied > denied"}', status: "completed" }
        : { type: "message", id: "msg_done", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Verified symbols and respected denial.", annotations: [] }] };
      res.setHeader("content-type", "text/event-stream");
      const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: "response.created", response: { id: `resp_${round}` } });
      emit({ type: "response.output_item.added", output_index: 0, item });
      emit({ type: "response.output_item.done", output_index: 0, item });
      emit({ type: "response.completed", response: { id: `resp_${round}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    } else if (req.url === "/host/v1/sessions/runtime/recovery") {
      assert.equal(req.headers.authorization, "Bearer runtime-cap");
      res.end(JSON.stringify({
        scope: "bridge-model-only", turn_id: "turn-one", state: "model-completed", cancellation: null,
        last_completed_sequence: 3, last_completed_response_id: "resp_3", replay_allowed: false,
      }));
    } else if (req.method === "GET" && req.url?.startsWith("/host/v1/sessions/runtime/turns/")) {
      assert.equal(req.headers.authorization, "Bearer runtime-cap");
      res.end(JSON.stringify({
        session_id: "runtime", turn_id: decodeURIComponent(req.url.split("/").at(-1)!),
        state: "idle", cancellation: null, request_sequence: 3, last_completed_sequence: 3,
        last_completed_response_id: "resp_3", response_retained: true, pending_tool_calls: 0,
        scope: "bridge-http-and-browser-only", replay_allowed: false,
      }));
    } else res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const names = ["GENTLE_CODEX_WEB_URL", "GENTLE_CODEX_WEB_TOKEN", "GENTLE_CODEX_WEB_CONTEXT_TARGET_TOKENS", "CODEX_CHATGPT_WEB_HOME", "GENTLE_CODEX_WEB"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.GENTLE_CODEX_WEB_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.GENTLE_CODEX_WEB_TOKEN = "runtime-pairing";
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "empty-home");
  delete process.env.GENTLE_CODEX_WEB;
  delete process.env.GENTLE_CODEX_WEB_CONTEXT_TARGET_TOKENS;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  const extensionPath = join(root, "bridge-tools.ts");
  const extensionUrl = (name: string) => JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "extensions", `${name}.ts`)).href);
  writeFileSync(extensionPath, `
import bridge from ${extensionUrl("gentle-codex-web")};
import facts from ${extensionUrl("gentle-facts")};
export default function (pi) {
  bridge(pi);
  facts(pi);
  pi.on("tool_call", event => event.toolName === "bash" ? { block: true, reason: "runtime fixture denies bash" } : undefined);
}
`);
  let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false,
    });
    runtime = await createAgentSessionRuntime(async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd, agentDir: root, modelRuntime,
        settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [extensionPath],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["facts_query", "context_status", "bash"] })), services, diagnostics: services.diagnostics };
    }, { cwd: root, agentDir: root, sessionManager: SessionManager.create(root, join(root, "sessions")) });
    await runtime.session.bindExtensions({ mode: "print" });
    assert.ok(modelRuntime.getAvailableSnapshot().some(model => model.provider === "gentle-codex-web" && model.id === "chatgpt-web/runtime"));
    assert.equal(runtime.session.messages.length, 0);
    const model = modelRuntime.getModel("gentle-codex-web", "chatgpt-web/runtime");
    assert.ok(model);
    await runtime.session.setModel(model);
    await runtime.session.prompt("/web-bridge status");
    assert.equal(methods.filter(method => method.startsWith("GET /host/v1/sessions/")).length, 0);
    await runtime.session.prompt("Inspect double and verify the permission boundary.");
    assert.equal(requests.length, 4);
    const factsOutput = requests[1].input.find((item: any) => item.type === "function_call_output" && item.call_id === "call_1");
    assert.match(JSON.stringify(factsOutput), /value: number/);
    const contextOutput = requests[2].input.find((item: any) => item.type === "function_call_output" && item.call_id === "call_2");
    assert.match(JSON.stringify(contextOutput), /within_target/);
    assert.match(JSON.stringify(contextOutput), /target_input_tokens/);
    assert.doesNotMatch(JSON.stringify(contextOutput), /Inspect double/);
    const denial = requests[3].input.find((item: any) => item.type === "function_call_output" && item.call_id === "call_3");
    assert.match(JSON.stringify(denial), /runtime fixture denies bash/);
    assert.equal(existsSync(join(root, "denied")), false);
    const recoveryRoot = join(root, "sessions", "web-recovery");
    const scopes = readdirSync(recoveryRoot);
    assert.equal(scopes.length, 1);
    assert.deepEqual(pairingScopes, scopes);
    const receiptFiles = readdirSync(join(recoveryRoot, scopes[0]));
    assert.equal(receiptFiles.filter(name => name.endsWith(".claim.json")).length, 12);
    assert.equal(receiptFiles.filter(name => name.endsWith(".result.json")).length, 2);
    for (const name of receiptFiles.filter(name => name.endsWith(".json"))) {
      assert.equal(readFileSync(join(recoveryRoot, scopes[0], name), "utf8").includes("printf denied"), false);
    }
    await runtime.session.prompt("/web-bridge status");
    assert.equal(methods.filter(method => method.startsWith("GET /host/v1/sessions/runtime/turns/")).length, 1);
    await runtime.session.prompt("/web-bridge recovery");
    assert.equal(methods.filter(method => method === "GET /host/v1/sessions/runtime/recovery").length, 1);
    assert.equal(requests.length, 4, "explicit status command must not submit another model round");
    await runtime.dispose();
    runtime = undefined;
    assert.ok(methods.includes("DELETE /host/v1/sessions/runtime"));
    assert.equal(modelRuntime.getAvailableSnapshot().some(model => model.provider === "gentle-codex-web"), false);
  } finally {
    await runtime?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
