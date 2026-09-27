import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.env.PI_HOST_PROBE_WORKSPACE;
const agentDir = process.env.PI_HOST_PROBE_AGENT_DIR;
assert.ok(cwd && agentDir);
const extensionPath = join(agentDir, "probe.ts");
const url = name => JSON.stringify(new URL(`../../extensions/${name}.ts`, import.meta.url).href);
await writeFile(extensionPath, `
import bridge from ${url("gentle-codex-web")};
import facts from ${url("gentle-facts")};
import quietTools from ${url("quiet-tools")};
export default function (pi) {
  quietTools(pi);
  bridge(pi);
  facts(pi);
  pi.on("tool_call", event => event.toolName === "bash" && event.input.command.includes("denied") ? { block: true, reason: "host probe denied command" } : undefined);
}
`);
const models = await ModelRuntime.create({
  authPath: join(agentDir, "auth.json"), modelsPath: null,
  modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
});
const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [extensionPath],
    },
  });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["facts_query", "bash"] })), services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) });
try {
  await runtime.session.bindExtensions({ mode: "print" });
  const model = models.getModels("gentle-codex-web")[0];
  assert.ok(model, "host handshake must register a real route");
  await runtime.session.setModel(model);
  await runtime.session.prompt("Inspect double and respect host permissions.");
  const results = runtime.session.messages.filter(message => message.role === "toolResult");
  assert.equal(results.length, 2, JSON.stringify(runtime.session.messages.filter(message => message.role === "assistant")));
  assert.match(JSON.stringify(results[0]), /value: number/);
  assert.match(JSON.stringify(results[1]), /host probe denied command/);
  assert.equal(results[1].isError, true);
  await assert.rejects(readFile(join(cwd, "denied")), { code: "ENOENT" });
  const final = runtime.session.messages.findLast(message => message.role === "assistant");
  assert.match(JSON.stringify(final), /Host protocol verified/);
  await runtime.session.prompt("/web-bridge status");
  await runtime.session.prompt("Execute the permitted command.");
  assert.equal(await readFile(join(cwd, "allowed"), "utf8"), "allowed");
  const pending = runtime.session.prompt("Run a cancellable command.");
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await readFile(join(cwd, "ready"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  await runtime.session.abort();
  await pending.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 1200));
  await assert.rejects(readFile(join(cwd, "late")), { code: "ENOENT" });
  // Give the independent HTTP cancellation acknowledgement time to settle.
  await new Promise(resolve => setTimeout(resolve, 100));
  await runtime.session.prompt("/web-bridge status");
  await runtime.session.prompt("Continue after cancelling the previous command.");
  assert.match(JSON.stringify(runtime.session.messages.findLast(message => message.role === "assistant")), /Host protocol verified/);
  await runtime.session.prompt("/web-bridge status");
  await runtime.session.prompt("/web-bridge disconnect");
  assert.equal(models.getModels("gentle-codex-web").length, 0);
  await runtime.session.prompt("/web-bridge connect");
  const reconnected = models.getModels("gentle-codex-web")[0];
  assert.ok(reconnected, "explicit reconnect must register a fresh provider");
  await runtime.session.setModel(reconnected);
  await runtime.session.prompt("Inspect double again after reconnecting.");
  assert.match(JSON.stringify(runtime.session.messages.findLast(message => message.role === "assistant")), /Host protocol verified/);
  await runtime.session.prompt("/web-bridge status");
  await runtime.session.prompt("/web-bridge recovery");
  console.log("Pi host probe: facts, permissions, successful command, tool cancellation and reconnect passed");
} finally {
  await runtime.dispose();
}
