import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("gentle-pi/package.json"));
const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.ok(installed.optionalDependencies.typescript, "TypeScript must be an optional runtime parser");
assert.ok(require.resolve("typescript").startsWith(process.cwd()), "TypeScript must resolve inside the isolated installation");
const cwd = join(process.cwd(), "workspace");
const agentDir = process.env.GENTLE_PI_AGENT_HOME;
await mkdir(cwd, { recursive: true });
await mkdir(agentDir, { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd });
await writeFile(join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@11.1.1", scripts: { test: "node --test" } }));
await writeFile(join(cwd, "source.ts"), "export const double = (value: number): number => value * 2;\n");
await writeFile(join(cwd, "consumer.ts"), "import { double } from './source.js';\n");
await writeFile(join(cwd, "api.py"), "def python_api(value: int) -> int:\n  return value\n");
await writeFile(join(cwd, "api.go"), "package api\nfunc GoAPI(value int) int { return value }\n");
execFileSync("git", ["add", "."], { cwd });
execFileSync("git", ["-c", "user.name=Facts Test", "-c", "user.email=facts@example.invalid", "commit", "-m", "pinned fixture"], { cwd });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const errors = [];
let modelCalls = 0;
let runtime;
try {
  runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
      resourceLoaderOptions: {
        additionalExtensionPaths: [join(packageRoot, "extensions", "gentle-facts.ts")],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "builtin" });
    return { ...created, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")) });
  runtime.session.agent.streamFunction = () => {
    modelCalls++;
    throw new Error("This probe must not invoke a model");
  };
  await runtime.session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
  const tools = runtime.session.agent.state.tools;
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["facts_commit", "facts_dependents", "facts_history", "facts_query", "facts_status"]);
  const execute = (name, args, signal) => tools.find((tool) => tool.name === name).execute("probe", args, signal);
  const initial = await execute("facts_query", { name: "double" });
  assert.match(initial.content[0].text, /value: number/);
  const dependents = await execute("facts_dependents", { target: "source.ts" });
  assert.match(dependents.content[0].text, /consumer.ts/);
  await writeFile(join(cwd, "source.ts"), "export const double = (value: bigint): bigint => value * 2n;\n");
  const edited = await execute("facts_query", { name: "double" });
  assert.match(edited.content[0].text, /value: bigint/);
  assert.doesNotMatch(edited.content[0].text, /value: number/);
  const pinned = await execute("facts_commit", { revision: commit, name: "double" });
  assert.equal(pinned.details.status, "committed");
  assert.equal(pinned.details.commit, commit);
  assert.match(pinned.content[0].text, /value: number/);
  assert.doesNotMatch(pinned.content[0].text, /bigint/);
  const status = await execute("facts_status", {});
  assert.equal(status.details.status, "ready");
  assert.ok(status.details.diagnostics.lastSuccessfulSyncAt > 0);
  for (const name of ["python_api", "GoAPI"]) {
    const result = await execute("facts_query", { name });
    assert.match(result.content[0].text, new RegExp(name));
  }
  assert.ok(runtime.session.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "gentle-facts-snapshot-v1"));
  await rm(join(cwd, ".git"), { recursive: true, force: true });
  const historical = await execute("facts_history", { name: "python_api" });
  assert.equal(historical.details.status, "historical");
  assert.match(historical.content[0].text, /python_api/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute("facts_query", { name: "double" }, controller.signal), { name: "AbortError" });
  await runtime.dispose();
  runtime = undefined;
  assert.deepEqual(errors, []);
  assert.equal(modelCalls, 0);
  console.log(JSON.stringify({ status: "passed", packageVersion: installed.version, sdkVersion: "0.87.1", tools: names, productionInstall: true, realSession: true, externalEditRefresh: true, cancellation: true, python: true, go: true, transcriptHistory: true, commitMode: true, modelCalls }));
} finally {
  await runtime?.dispose();
}
