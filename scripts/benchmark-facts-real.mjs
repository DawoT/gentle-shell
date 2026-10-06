import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FactsService } from "../lib/facts/facts-service.ts";

// Real-repository Facts baseline: measures the tracked source shape of THIS
// repository against a disposable git-archive copy, so the live .pi cache,
// generation pointer and untracked user files are never read or mutated.
// Timings are observations on this machine; they are not a production SLA.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samples = Math.max(1, Number(process.env.FACTS_BENCH_SAMPLES ?? 7));
const burstCallers = Math.max(2, Number(process.env.FACTS_BENCH_BURST ?? 3));
const scenarios = { cold: [], warm: [], postEdit: [], burstWall: [], burstPerCall: [], autoRead: [] };
const phaseScenarios = { cold: [], warm: [], postEdit: [], burst: [], autoRead: [] };

const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  cpu: cpus()[0]?.model,
  corpusHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  corpusNote: "tracked files at HEAD via git archive; excludes untracked and ignored files",
  samples,
  burstCallers,
  scenarios: {},
};

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const rank = Math.min(sortedValues.length, Math.max(1, Math.ceil(fraction * sortedValues.length)));
  return sortedValues[rank - 1];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function timedSync(service, options) {
  const started = performance.now();
  const result = await service.sync(undefined, options);
  return { elapsedMs: performance.now() - started, result };
}

function phaseDelta(before, after) {
  const phases = {};
  for (const [phase, aggregate] of Object.entries(after.phases)) {
    const prior = before.phases[phase] ?? { count: 0, totalMs: 0 };
    phases[phase] = {
      count: aggregate.count - prior.count,
      totalMs: round(aggregate.totalMs - prior.totalMs),
    };
  }
  return phases;
}

async function measureScenario(service, name, run) {
  const before = service.getPhaseMetrics();
  const elapsedMs = await run();
  const after = service.getPhaseMetrics();
  phaseScenarios[name].push(phaseDelta(before, after));
  return elapsedMs;
}

const cwd = await mkdtemp(join(tmpdir(), "facts-bench-real-"));
try {
  const archive = execFileSync("git", ["archive", "HEAD"], { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", cwd], { input: archive });
  execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
  // The archive has no .git; index everything so the workspace scan sees one
  // clean commit instead of thousands of untracked files.
  execFileSync("git", ["add", "-A"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Facts Baseline", "-c", "user.email=baseline@example.invalid", "commit", "-m", "corpus"], { cwd, stdio: "ignore" });

  report.corpusFiles = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean).length;
  try {
    report.filesystemType = execFileSync("stat", ["-f", "-c", "%T", cwd], { encoding: "utf8" }).trim();
  } catch {
    report.filesystemType = "unknown";
  }

  const editTarget = join(cwd, "lib", "facts", "facts-codec.ts");
  const originalCodec = await readFile(editTarget, "utf8");

  for (let repetition = 0; repetition < samples; repetition++) {
    await rm(join(cwd, ".pi"), { recursive: true, force: true });
    globalThis.gc?.();
    const service = new FactsService(cwd);

    scenarios.cold.push(round(await measureScenario(service, "cold", async () => {
      const cold = await timedSync(service);
      assert.equal(cold.result.indexedCount > 0, true);
      return cold.elapsedMs;
    })));

    scenarios.warm.push(round(await measureScenario(service, "warm", async () => {
      const warm = await timedSync(service);
      assert.equal(warm.result.indexedCount, 0);
      return warm.elapsedMs;
    })));

    scenarios.burstWall.push(round(await measureScenario(service, "burst", async () => {
      const started = performance.now();
      const calls = Array.from({ length: burstCallers }, () => timedSync(service));
      const settled = await Promise.all(calls);
      for (const call of settled) {
        scenarios.burstPerCall.push(round(call.elapsedMs));
        assert.equal(call.result.indexedCount, 0);
      }
      return performance.now() - started;
    })));

    // Single-file edit keeps the incremental path honest: one modified source.
    await writeFile(editTarget, (await readFile(editTarget, "utf8")) + `// baseline edit ${repetition}\n`);
    scenarios.postEdit.push(round(await measureScenario(service, "postEdit", async () => {
      const edited = await timedSync(service);
      assert.equal(edited.result.indexedCount, 1);
      return edited.elapsedMs;
    })));
    // Restore the corpus so the next cold repetition indexes identical bytes.
    await writeFile(editTarget, originalCodec);

    // Sprint 1 gate: fast-path reads on the unchanged, freshly primed tree.
    const autoService = new FactsService(cwd, undefined, { fastPath: true });
    const primed = await autoService.sync(undefined, { mode: "auto" });
    assert.equal(primed.path, "full");
    scenarios.autoRead.push(round(await measureScenario(autoService, "autoRead", async () => {
      const read = await timedSync(autoService, { mode: "auto" });
      assert.equal(read.result.path, "fast");
      return read.elapsedMs;
    })));

    console.error(`facts-bench-real: repetition ${repetition + 1}/${samples} done`);
  }

  for (const [name, values] of Object.entries(scenarios)) {
    report.scenarios[name] = summarize(values);
  }
  report.phaseBreakdownMs = {};
  for (const [name, deltas] of Object.entries(phaseScenarios)) {
    const totals = {};
    for (const delta of deltas) {
      for (const [phase, aggregate] of Object.entries(delta)) {
        totals[phase] ??= { count: 0, totalMs: 0 };
        totals[phase].count += aggregate.count;
        totals[phase].totalMs = round(totals[phase].totalMs + aggregate.totalMs);
      }
    }
    report.phaseBreakdownMs[name] = totals;
  }
  report.burstPerCallSamples = samples;
  report.interpretation = {
    obs001: "warm and burst repetitions pay the full phase sequence on an unchanged tree; compare warm.p50 against cold.p50",
    obs003: `burst wall time for ${burstCallers} concurrent unchanged syncs versus warm p50 exposes the serialization stampede`,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
