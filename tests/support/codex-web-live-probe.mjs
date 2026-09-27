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
  assert.ok(model);
  await runtime.session.setModel(model);
  await runtime.session.prompt("Reply exactly PI_WEB_OK. Do not use tools.");
  const result = runtime.session.messages.findLast(message => message.role === "assistant");
  assert.equal(result?.stopReason, "stop", JSON.stringify(result));
  const output = result.content.filter(part => part.type === "text").map(part => part.text).join("");
  assert.equal(output.replaceAll("\\_", "_"), "PI_WEB_OK");
  assert.equal(runtime.session.messages.filter(message => message.role === "toolResult").length, 0);
  await runtime.session.prompt("/web-bridge recovery");
  console.log(JSON.stringify({ status: "passed", output, model: model.id, usage: result.usage }));
} finally {
  await runtime.dispose();
}
