import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FactsService } from "../lib/facts/facts-service.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = createHash("sha256");
const sourcePaths = (await readdir(join(root, "lib", "facts")))
  .filter((name) => name.endsWith(".ts"))
  .map((name) => `lib/facts/${name}`);
sourcePaths.push("extensions/gentle-facts.ts");
for (const path of sourcePaths.sort()) {
  hash.update(path);
  hash.update(await readFile(join(root, path)));
}
const report = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  cpu: cpus()[0]?.model,
  sourceSha256: hash.digest("hex"),
  samplesPerSize: 3,
  note: "Synthetic repositories; timings are observations, not a production SLA. Memory is sampled after each phase; process peak RSS includes previous phases.",
  repositories: [],
};

function source(index, revision = 0) {
  return [
    index > 0 ? `import type { Record${index - 1} } from './module-${index - 1}.js';` : "",
    `export interface Record${index} { id: string; amount: number; revision: ${revision}; }`,
    `/** Calculate a total after filtering invalid amounts. */`,
    `export function total${index}(rows: Record${index}[]): number {`,
    "  return rows.reduce((sum, row) => sum + Math.max(0, row.amount), 0);",
    "}",
    `export const identity${index} = <T>(value: T): T => value;`,
    "",
  ].join("\n");
}

async function measure(service) {
  globalThis.gc?.();
  const started = performance.now();
  const result = await service.sync();
  const elapsedMs = performance.now() - started;
  const memory = process.memoryUsage();
  return {
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024 * 100) / 100,
    rssMiB: Math.round(memory.rss / 1024 / 1024 * 100) / 100,
    processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 100) / 100,
    ...result,
  };
}

for (const fileCount of [25, 250, 2500]) {
  const cwd = await mkdtemp(join(tmpdir(), "facts-benchmark-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
    await writeFile(join(cwd, ".gitignore"), ".pi/\n");
    await mkdir(join(cwd, "src"));
    let sourceBytes = 0;
    for (let i = 0; i < fileCount; i++) {
      const text = source(i);
      sourceBytes += Buffer.byteLength(text);
      await writeFile(join(cwd, "src", `module-${i}.ts`), text);
    }
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "user.name=Facts Benchmark", "-c", "user.email=facts@example.invalid", "commit", "-m", "fixture"], { cwd, stdio: "ignore" });
    const samples = [];
    for (let repetition = 0; repetition < report.samplesPerSize; repetition++) {
      await writeFile(join(cwd, "src", "module-0.ts"), source(0));
      await rm(join(cwd, ".pi"), { recursive: true, force: true });
      const service = new FactsService(cwd);
      const cold = await measure(service);
      const warm = await measure(service);
      await writeFile(join(cwd, "src", "module-0.ts"), source(0, repetition + 1));
      const incremental = await measure(service);
      assert.equal(cold.indexedCount, fileCount);
      assert.equal(warm.indexedCount, 0);
      assert.equal(warm.cachedCount, fileCount);
      assert.equal(incremental.indexedCount, 1);
      assert.equal(service.querySymbol("total0").length, 1);
      samples.push({ cold, warm, incremental });
    }
    report.repositories.push({ fileCount, sourceBytes, samples });
    console.error(`facts-benchmark: completed ${fileCount} source files`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report, null, 2));
