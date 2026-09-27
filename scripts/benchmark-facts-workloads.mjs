import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, hostname, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FactsService } from "../lib/facts/facts-service.ts";
import { MAX_SOURCE_BYTES } from "../lib/facts/facts-limits.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = fileURLToPath(import.meta.url);
const workloads = ["large-files", "dense-exports", "monorepo-aliases", "mass-edits", "python", "go", "receipt-heavy", "sparse-many-files"];
const round = value => Math.round(value * 1000) / 1000;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function fixture(name) {
  const files = new Map();
  const mutations = new Map();
  let expectedSymbols;
  let changedFiles;
  let query;
  let freshSignature;
  const ts = (index, type = "number") => `export function calculate${index}(value: ${type}): ${type} {\n  return value;\n}\n`;
  switch (name) {
    case "large-files":
      expectedSymbols = 4;
      changedFiles = 1;
      query = "calculate0";
      for (let index = 0; index < 4; index += 1) {
        const padding = `/*\n${"Large documentation line without declarations.\n".repeat(13000)}*/\n`;
        const source = padding + ts(index);
        assert.ok(Buffer.byteLength(source) < MAX_SOURCE_BYTES);
        files.set(`src/module${index}.ts`, source);
        if (index === 0) mutations.set(`src/module${index}.ts`, padding + ts(index, "string"));
      }
      freshSignature = "string";
      break;
    case "dense-exports":
      expectedSymbols = 960;
      changedFiles = 1;
      query = "calculate0";
      for (let file = 0; file < 12; file += 1) {
        const source = Array.from({ length: 80 }, (_, index) => ts(file * 80 + index)).join("\n");
        files.set(`src/dense${file}.ts`, source);
        if (file === 0) mutations.set("src/dense0.ts", source.replace(ts(0), ts(0, "string")));
      }
      freshSignature = "string";
      break;
    case "monorepo-aliases":
      expectedSymbols = 16;
      changedFiles = 1;
      query = "calculate0";
      files.set("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["packages/lib_*/index.ts"] } } }, null, 2));
      for (let index = 0; index < 8; index += 1) {
        files.set(`packages/lib_${index}/index.ts`, ts(index));
        files.set(`packages/app_${index}/index.ts`, `import { calculate${index} } from '@lib/${index}';\nexport function consume${index}(value: number): number {\n  return calculate${index}(value);\n}\n`);
        files.set(`packages/lib_${index}/package.json`, JSON.stringify({ name: `@lib/${index}`, private: true }));
        files.set(`packages/app_${index}/package.json`, JSON.stringify({ name: `app-${index}`, private: true }));
      }
      mutations.set("packages/lib_0/index.ts", ts(0, "string"));
      freshSignature = "string";
      break;
    case "mass-edits":
      expectedSymbols = 96;
      changedFiles = 96;
      query = "calculate0";
      for (let index = 0; index < 96; index += 1) {
        files.set(`src/module${index}.ts`, ts(index));
        mutations.set(`src/module${index}.ts`, ts(index, "string"));
      }
      freshSignature = "string";
      break;
    case "python":
      expectedSymbols = 24;
      changedFiles = 1;
      query = "calculate0";
      for (let index = 0; index < 24; index += 1) {
        files.set(`src/module${index}.py`, `def calculate${index}(value: int) -> int:\n  return value\n`);
      }
      mutations.set("src/module0.py", "def calculate0(value: str) -> str:\n  return value\n");
      freshSignature = "str";
      break;
    case "go":
      expectedSymbols = 24;
      changedFiles = 1;
      query = "Calculate0";
      files.set("go.mod", "module benchmark.invalid/workloads\n\ngo 1.22\n");
      for (let index = 0; index < 24; index += 1) {
        files.set(`src/module${index}.go`, `package fixture\n\nfunc Calculate${index}(value int) int {\n  return value\n}\n`);
      }
      mutations.set("src/module0.go", "package fixture\n\nfunc Calculate0(value string) string {\n  return value\n}\n");
      freshSignature = "string";
      break;
    case "receipt-heavy": {
      expectedSymbols = 24;
      changedFiles = 0;
      query = "calculate0";
      const manifest = {
        name: "receipt-benchmark", private: true, packageManager: "pnpm@11.0.0",
        scripts: { test: "node --test", build: "tsc", lint: "eslint src" },
        dependencies: Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`fixture-package-${index}`, "1.0.0"])),
      };
      files.set("package.json", JSON.stringify(manifest, null, 2));
      mutations.set("package.json", JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, "fixture-new-dependency": "2.0.0" } }, null, 2));
      for (let index = 0; index < 24; index += 1) {
        files.set(`src/module${index}.ts`, ts(index));
      }
      break;
    }
    case "sparse-many-files":
      expectedSymbols = 8;
      changedFiles = 1;
      query = "calculate0";
      for (let index = 0; index < 512; index += 1) {
        files.set(`src/module${index}.ts`, index < 8 ? ts(index) : "// This module intentionally exports no declarations.\n");
      }
      mutations.set("src/module0.ts", ts(0, "string"));
      freshSignature = "string";
      break;
    default:
      throw new Error(`Unknown benchmark workload: ${name}`);
  }
  return { files, mutations, expectedSymbols, changedFiles, query, freshSignature };
}

async function writeFiles(cwd, files) {
  for (const [path, content] of files) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), content);
  }
}

async function measure(service, description, phase, signal) {
  const beforeCpu = process.cpuUsage();
  const started = performance.now();
  const sync = await service.sync(signal);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(beforeCpu);
  const memory = process.memoryUsage();
  const queryStarted = performance.now();
  const answer = service.querySymbol(description.query);
  const queryElapsedMs = performance.now() - queryStarted;
  assert.equal(answer.length, 1, `${phase}: named query must return exactly one declaration`);
  assert.equal(service.querySymbols({}).length, description.expectedSymbols, `${phase}: independent fixture symbol count`);
  if (phase === "changed" && description.freshSignature) {
    assert.ok(answer[0].symbol.signature.includes(description.freshSignature), "changed query must expose the revised argument/return contract");
    if (description.changedFiles === 96) {
      for (let index = 0; index < 96; index += 1) {
        assert.ok(service.querySymbol(`calculate${index}`)[0].symbol.signature.includes("string"), "every edited declaration must refresh");
      }
    }
  }
  const diagnostics = service.getDiagnostics();
  assert.equal(diagnostics.status, "ready");
  return {
    elapsedMs: round(elapsedMs), queryElapsedMs: round(queryElapsedMs),
    processCpuUserMs: round(cpu.user / 1000), processCpuSystemMs: round(cpu.system / 1000),
    processHeapUsedMiB: round(memory.heapUsed / 1024 ** 2), processRssMiB: round(memory.rss / 1024 ** 2),
    processPeakRssMiB: round(process.resourceUsage().maxRSS / 1024),
    sync, symbolCount: description.expectedSymbols,
    queryResponseBytes: Buffer.byteLength(JSON.stringify(answer)), diagnostics,
  };
}

async function sample(name, ownedRoot) {
  const description = fixture(name);
  const cwd = ownedRoot ?? await mkdtemp(join(tmpdir(), "facts-workload-owned-"));
  try {
    await writeFiles(cwd, description.files);
    await writeFile(join(cwd, ".gitignore"), ".pi/\n");
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore", timeout: 10000 });
    execFileSync("git", ["add", "."], { cwd, stdio: "ignore", timeout: 10000 });
    execFileSync("git", ["-c", "user.name=Facts Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-m", "owned fixture"], { cwd, stdio: "ignore", timeout: 10000 });
    const sourceFiles = [...description.files].filter(([path]) => /\.(ts|py|go)$/.test(path));
    const service = new FactsService(cwd);
    const signal = AbortSignal.timeout(45000);
    const cold = await measure(service, description, "cold", signal);
    const warm = await measure(service, description, "warm", signal);
    assert.equal(cold.sync.indexedCount, sourceFiles.length);
    assert.equal(warm.sync.indexedCount, 0);
    assert.equal(warm.sync.cachedCount, sourceFiles.length);
    if (name === "monorepo-aliases") {
      assert.ok(service.queryDependents("packages/lib_0/index.ts").includes("packages/app_0/index.ts"), "tsconfig path alias must resolve the consumer");
    }
    if (name === "receipt-heavy") {
      assert.equal(Object.keys(service.getReceipts().dependencies).length, 5000);
      assert.equal(service.getReceipts().testCommand, "pnpm test");
    }
    await writeFiles(cwd, description.mutations);
    const changed = await measure(service, description, "changed", signal);
    assert.equal(changed.sync.indexedCount, description.changedFiles);
    if (name === "receipt-heavy") assert.equal(service.getReceipts().dependencies["fixture-new-dependency"], "2.0.0");
    return {
      fixture: {
        sourceFileCount: sourceFiles.length, trackedFixtureFileCount: description.files.size + 1,
        expectedSymbolCount: description.expectedSymbols, changedSourceFiles: description.changedFiles,
        sourceBytes: sourceFiles.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0),
        fixtureBytes: [...description.files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0),
      }, cold, warm, changed,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function childSample(name) {
  const ownedRoot = await mkdtemp(join(tmpdir(), "facts-workload-owned-"));
  try {
    return await new Promise((resolveSample, rejectSample) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", script, "--sample", name], {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { ...process.env, FACTS_WORKLOAD_ROOT: ownedRoot },
      });
      let output = "";
      let errors = "";
      const timer = setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else {
          child.kill("SIGKILL");
        }
      }, 60000);
      child.stdout.on("data", chunk => {
        output += chunk;
      });
      child.stderr.on("data", chunk => {
        errors += chunk;
      });
      child.once("error", error => {
        clearTimeout(timer);
        rejectSample(error);
      });
      child.once("close", code => {
        clearTimeout(timer);
        if (code !== 0) rejectSample(new Error(`${name} benchmark child failed (${code}): ${errors}`));
        else {
          try {
            resolveSample(JSON.parse(output));
          } catch (error) {
            rejectSample(error);
          }
        }
      });
    });
  } finally {
    await rm(ownedRoot, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--sample") {
  console.log(JSON.stringify(await sample(process.argv[3], process.send ? process.env.FACTS_WORKLOAD_ROOT : undefined)));
  process.disconnect?.();
} else {
  const hash = createHash("sha256");
  const paths = (await readdir(join(root, "lib/facts"))).filter(name => name.endsWith(".ts")).map(name => `lib/facts/${name}`);
  paths.push(...(await readdir(join(root, "runtime"))).filter(name => name.startsWith("facts-") && name.endsWith(".mjs")).map(name => `runtime/${name}`));
  paths.push("package.json", "pnpm-lock.yaml", "lib/facts/parsers/python_facts.py", "lib/facts/parsers/go_facts.go", "scripts/benchmark-facts-workloads.mjs");
  for (const path of paths.sort()) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  const version = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 10000, cwd: root }).trim();
  const report = {
    generatedAt: new Date().toISOString(), command: "node --experimental-strip-types scripts/benchmark-facts-workloads.mjs --output docs/evidence/gentle-facts-workloads-benchmark.json",
    node: process.version, python: version("python3", ["--version"]), go: version("go", ["version"]), git: version("git", ["--version"]),
    platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    hostDigest: createHash("sha256").update(`${hostname()}|${process.platform}|${process.arch}|${cpus()[0]?.model}|${totalmem()}`).digest("hex"),
    headCommit: version("git", ["rev-parse", "HEAD"]), sourceSha256: hash.digest("hex"), sourcePaths: paths.sort(), samplesPerWorkload: 3,
    methodology: {
      fixtures: "Generated owned Git repositories, not observations from customer projects. Each sample uses a fresh child process and temp repository; its real FactsService/parser worker handles all three phases.",
      cold: "No disk cache; parser process/worker initialization included. OS filesystem cache is uncontrolled.",
      warm: "Same child and service after unchanged sync; no claim of zero I/O.",
      changed: "Same child after fixture mutation; source signatures, aliases and receipt freshness asserted where applicable.",
      memoryCpu: "Current Node process CPU/RSS observations exclude separate Python, Go and Git subprocess CPU/memory. RSS includes Node worker threads/runtime; heapUsed measures the current isolate. Nothing is attributable solely to Facts. Process peak RSS accumulates across phases within that sample.",
      deadlines: "Each sample has a 45-second sync cancellation signal and a 60-second parent watchdog. POSIX watchdog targets the owned process group; Windows watchdog terminates only the direct child. Parent removes its owned temporary repository after child settlement.",
      bytes: "sourceBytes and JSON queryResponseBytes are bytes, not billed tokens. No model calls, token savings, cost savings, throughput SLA or production latency claims.",
    },
    workloads: [],
  };
  for (const name of workloads) {
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      samples.push(await childSample(name));
      console.error(`facts-workloads: ${name} sample ${index + 1}/3 passed`);
    }
    const phases = Object.fromEntries(["cold", "warm", "changed"].map(phase => [phase, {
      medianElapsedMs: median(samples.map(sample => sample[phase].elapsedMs)),
      medianQueryElapsedMs: median(samples.map(sample => sample[phase].queryElapsedMs)),
      medianProcessRssMiB: median(samples.map(sample => sample[phase].processRssMiB)),
      medianProcessCpuUserMs: median(samples.map(sample => sample[phase].processCpuUserMs)),
      medianProcessCpuSystemMs: median(samples.map(sample => sample[phase].processCpuSystemMs)),
    }]));
    report.workloads.push({ name, fixture: samples[0].fixture, phases, samples });
  }
  const outputIndex = process.argv.indexOf("--output");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputIndex >= 0) {
    const output = resolve(process.argv[outputIndex + 1]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    console.error(`facts-workloads: wrote ${output}`);
  } else {
    process.stdout.write(json);
  }
}
