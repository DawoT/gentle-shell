import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";
import { runSuiteWithProofs } from "../lib/proofs/proof-runner.ts";
import { runTestSuite } from "../scripts/run-test-suite.mjs";
import type { TestInventoryEntry } from "../lib/proofs/proof-invalidation.ts";

const SHA = (n: number) => `sha-${n}`;

function inventory(): TestInventoryEntry[] {
  return [
    { name: "math.test.ts", fingerprint: "f1".padEnd(64, "0"), coverage: { files: { "math.ts": SHA(1) } }, confidence: "hermetic_unit", sideEffects: "pure_validation" },
    { name: "ui.test.ts", fingerprint: "f2".padEnd(64, "0"), coverage: { files: { "widget.ts": SHA(9) } }, confidence: "hermetic_unit", sideEffects: "pure_validation" },
  ];
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofs-runner-"));
  const ledger = new ProofLedger(join(dir, "proofs"));
  return {
    dir,
    ledger,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function baseOptions(ledger: ProofLedger, overrides: Record<string, unknown> = {}) {
  const inv = inventory();
  const executed: string[] = [];
  return {
    inv,
    executed,
    options: {
      ledger,
      inventory: inv,
      fingerprintFor: (entry: TestInventoryEntry) => ({ fingerprint: entry.fingerprint, inputsDigest: "d".repeat(64) }),
      coverageFor: (entry: TestInventoryEntry) => entry.coverage,
      currentFileDigests: { "math.ts": SHA(1), "widget.ts": SHA(9) },
      reaches: (changed: string, covered: string) => changed === "widget.ts" && covered === "widget.ts",
      changedFiles: [] as string[],
      runTest: async (entry: TestInventoryEntry) => {
        executed.push(entry.name);
        return { passed: true, exitCode: 0, durationMs: 10 };
      },
      agent: "proof-runner-test",
      allowUnreachableReuse: true,
      ...overrides,
    },
  };
}

test("the first run executes everything and publishes proofs", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const { options } = baseOptions(ledger);
    const result = await runSuiteWithProofs(options);
    assert.equal(result.green, true);
    assert.equal(result.executed.length, 2);
    assert.equal(result.reused.length, 0);
    assert.equal(result.unaccounted.length, 0);
    assert.equal((await ledger.current(options.inventory[0].fingerprint))?.status, "passed");
  } finally {
    await cleanup();
  }
});

test("an unchanged second run reuses everything without executing", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    assert.equal(first.executed.length, 2);

    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 0, "the runner never executed");
    assert.equal(result.reused.length, 2);
    assert.equal(result.green, true);
    assert.ok(result.reused[0].seq >= 1, "reuse explains which published proof it relied on");
  } finally {
    await cleanup();
  }
});

test("an affected test executes while the unaffected one is reused", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);

    const second = baseOptions(ledger, { changedFiles: ["widget.ts"] });
    const result = await runSuiteWithProofs(second.options);
    assert.deepEqual(second.executed, ["ui.test.ts"], "only the affected test executes");
    assert.deepEqual(result.reused.map((item) => item.name), ["math.test.ts"]);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("a failing executed test turns the suite red and never blocks its own rerun", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger, {
      runTest: async (entry: TestInventoryEntry) => entry.name === "ui.test.ts" ? { passed: false, exitCode: 1, durationMs: 3 } : { passed: true, exitCode: 0, durationMs: 10 },
    });
    const red = await runSuiteWithProofs(first.options);
    assert.equal(red.green, false, "a failed executed constituent cannot compose green");
    assert.equal((await ledger.current("f2".padEnd(64, "0")))?.status, "failed");

    // A cached failure is evidence: the next run executes the test again.
    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    assert.deepEqual(second.executed.includes("ui.test.ts"), true);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("stage independence: a throwing runner fails its own test only", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const { options } = baseOptions(ledger, {
      runTest: async (entry: TestInventoryEntry) => {
        if (entry.name === "ui.test.ts") throw new Error("runner crashed");
        return { passed: true, exitCode: 0, durationMs: 10 };
      },
    });
    const result = await runSuiteWithProofs(options);
    assert.equal(result.green, false);
    assert.equal(result.executed.length, 2);
    assert.equal(result.executed.find((item) => item.name === "ui.test.ts")?.passed, false);
    assert.equal(result.executed.find((item) => item.name === "math.test.ts")?.passed, true);
    assert.equal(result.unaccounted.length, 0);
  } finally {
    await cleanup();
  }
});

test("forceRun bypasses reuse and publishes fresh evidence", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    const seqBefore = (await ledger.current("f1".padEnd(64, "0")))?.seq;

    const second = baseOptions(ledger, { forceRun: true });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 2, "force-run executes even with valid proofs");
    assert.equal(result.reused.length, 0);
    const seqAfter = (await ledger.current("f1".padEnd(64, "0")))?.seq;
    assert.equal((seqAfter ?? 0) > (seqBefore ?? 0), true, "fresh evidence is published");
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

test("noCache neither reuses nor publishes", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    const before = await ledger.current("f1".padEnd(64, "0"));

    const second = baseOptions(ledger, { noCache: true });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(second.executed.length, 2);
    assert.equal(result.reused.length, 0);
    const after = await ledger.current("f1".padEnd(64, "0"));
    assert.equal(after?.seq, before?.seq, "the ledger view stayed untouched");
    assert.deepEqual(after, before);
  } finally {
    await cleanup();
  }
});

test("a policy-rejected proof surfaces its explanation in the executed entry", async () => {
  const { dir, ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);
    // Turn the published math proof into a non-hermetic one on disk.
    const forged = JSON.stringify({ ...JSON.parse(JSON.stringify(await ledger.current("f1".padEnd(64, "0")))), confidence: "controlled_integration" });
    await (await import("node:fs/promises")).writeFile(join(dir, "proofs", "records", "f1".padEnd(64, "0"), "current.json"), forged);

    const second = baseOptions(ledger);
    const result = await runSuiteWithProofs(second.options);
    const math = result.executed.find((item) => item.name === "math.test.ts");
    assert.equal(math?.passed, true);
    assert.match(math?.reason ?? "", /controlled_integration|hermeticity/i);
  } finally {
    await cleanup();
  }
});

test("the proof-aware runner publishes deterministic repo-relative V8 coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "proofs-v8-coverage-"));
  const ledgerRoot = join(root, "ledger");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "node_modules", "fixture-pkg"), { recursive: true });
    await writeFile(join(root, "src", "helper.mjs"), "export const answer = 42;\n");
    await writeFile(join(root, "scripts", "run-test-suite.mjs"), "export const runnerMarker = true;\n");
    await writeFile(join(root, "node_modules", "fixture-pkg", "index.mjs"), "export const ignored = true;\n");
    await writeFile(
      join(root, "tests", "sample.test.mjs"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { answer as first } from "../src/helper.mjs?first";',
        'import { answer as second } from "../src/helper.mjs?second";',
        'import { ignored } from "../node_modules/fixture-pkg/index.mjs";',
        'import { runnerMarker } from "../scripts/run-test-suite.mjs";',
        'test("fixture", () => { assert.equal(first + second, 84); assert.equal(ignored, true); assert.equal(runnerMarker, true); });',
        "",
      ].join("\n"),
    );

    const stage = {
      name: "coverage-stage",
      command: `env -u NODE_TEST_CONTEXT node --test ${JSON.stringify(join(root, "tests", "sample.test.mjs"))}`,
    };
    await runTestSuite([stage], {
      write: () => {},
      proofs: { ledgerRoot, treeDigest: "7".repeat(64), repoRoot: root },
    });

    const recordsRoot = join(ledgerRoot, "records");
    const fingerprints = (await readdir(recordsRoot)).sort();
    assert.equal(fingerprints.length, 1);
    const current = JSON.parse(
      await readFile(join(recordsRoot, fingerprints[0]!, "current.json"), "utf8"),
    );
    assert.deepEqual(current.runtimeObservation, {
      kind: "v8-coverage",
      files: ["src/helper.mjs", "tests/sample.test.mjs"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown reachability triggers the conservative fallback across the suite", async () => {
  const { ledger, cleanup } = await fixture();
  try {
    const first = baseOptions(ledger);
    await runSuiteWithProofs(first.options);

    const second = baseOptions(ledger, {
      changedFiles: ["mystery.ts"],
      reaches: () => "unknown" as const,
    });
    const result = await runSuiteWithProofs(second.options);
    assert.equal(result.fallback, true);
    assert.equal(result.reused.length, 0, "fallback executes instead of reusing");
    assert.equal(result.executed.length, 2);
    assert.equal(result.green, true);
  } finally {
    await cleanup();
  }
});

async function perFileStageFixture() {
  const root = await mkdtemp(join(tmpdir(), "proofs-per-file-"));
  const ledgerRoot = join(root, "ledger");
  const stage = {
    name: "unit-tests",
    command: "node --experimental-strip-types --test tests/*.test.ts",
  };
  const files = ["alpha", "beta"] as const;
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  for (const name of files) {
    await writeFile(join(root, "tests", `${name}.test.ts`), `import \"../src/${name}.ts\";\n`);
    await writeFile(join(root, "src", `${name}.ts`), `export const ${name} = true;\n`);
  }

  const executions: string[] = [];
  const runStageImpl = async (executedStage: { name: string; command: string }) => {
    executions.push(executedStage.command);
    const coverageDir = process.env.NODE_V8_COVERAGE;
    if (coverageDir) {
      const covered = ["alpha", "beta", "gamma"].filter((name) => executedStage.command.includes(`tests/${name}.test.ts`));
      const selected = covered.length > 0 ? covered : files;
      await writeFile(
        join(coverageDir, `coverage-${executions.length}.json`),
        JSON.stringify({
          result: selected.flatMap((name) => [
            { url: pathToFileURL(join(root, "tests", `${name}.test.ts`)).href },
            { url: pathToFileURL(join(root, "src", `${name}.ts`)).href },
          ]),
        }),
      );
    }
    return { name: executedStage.name, code: 0 };
  };

  return {
    root,
    ledgerRoot,
    stage,
    executions,
    runStageImpl,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function runtimeCoverageSets(ledgerRoot: string) {
  const recordsRoot = join(ledgerRoot, "records");
  const fingerprints = await readdir(recordsRoot);
  const sets: string[][] = [];
  for (const fingerprint of fingerprints) {
    const current = JSON.parse(await readFile(join(recordsRoot, fingerprint, "current.json"), "utf8"));
    if (current.runtimeObservation?.kind === "v8-coverage") {
      sets.push([...current.runtimeObservation.files].sort());
    }
  }
  return sets;
}

test("run-test-suite enumerates unit-test files into independent selection items", async () => {
  const fx = await perFileStageFixture();
  try {
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "1".repeat(64), repoRoot: fx.root },
    });

    assert.equal(fx.executions.length, 2);
    assert.deepEqual(
      fx.executions.map((command) => command.match(/tests\/(alpha|beta)\.test\.ts/)?.[1]).sort(),
      ["alpha", "beta"],
    );
  } finally {
    await fx.cleanup();
  }
});

test("per-file coverage is isolated and attributed only to that test file", async () => {
  const fx = await perFileStageFixture();
  try {
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "2".repeat(64), repoRoot: fx.root },
    });

    const coverageSets = await runtimeCoverageSets(fx.ledgerRoot);
    const isolated = coverageSets.filter((files) => files.length === 2);
    assert.ok(isolated.some((files) => files.join("|") === "src/alpha.ts|tests/alpha.test.ts"));
    assert.ok(isolated.some((files) => files.join("|") === "src/beta.ts|tests/beta.test.ts"));
  } finally {
    await fx.cleanup();
  }
});

test("unit-test stage executes only selected files when selection is trustworthy", async () => {
  const fx = await perFileStageFixture();
  try {
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "3".repeat(64), repoRoot: fx.root },
    });
    fx.executions.length = 0;
    await writeFile(join(fx.root, "tests", "gamma.test.ts"), 'import "../src/gamma.ts";\n');
    await writeFile(join(fx.root, "src", "gamma.ts"), "export const gamma = true;\n");

    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "4".repeat(64), repoRoot: fx.root },
    });

    assert.equal(fx.executions.length, 1);
    assert.match(fx.executions[0]!, /tests\/gamma\.test\.ts/);
    assert.doesNotMatch(fx.executions[0]!, /tests\/alpha\.test\.ts|tests\/beta\.test\.ts|tests\/\*\.test\.ts/);
  } finally {
    await fx.cleanup();
  }
});

test("committed changes still select granularly through coverage digest drift", async () => {
  const fx = await perFileStageFixture();
  try {
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "7".repeat(64), repoRoot: fx.root },
    });
    fx.executions.length = 0;
    await writeFile(join(fx.root, "tests", "gamma.test.ts"), 'import "../src/gamma.ts";\n');
    await writeFile(join(fx.root, "src", "gamma.ts"), "export const gamma = false;\n");

    // Real-CLI shape: Facts reachability is provided and the working tree is
    // clean (the change is committed), so there are no explicit changed
    // files. The per-file coverage snapshots are the change detector.
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: {
        ledgerRoot: fx.ledgerRoot,
        treeDigest: "8".repeat(64),
        repoRoot: fx.root,
        changedFiles: [],
        reaches: (changedFile: string, coveredFile: string) => changedFile === coveredFile,
      },
    });

    assert.equal(fx.executions.length, 1);
    assert.match(fx.executions[0]!, /tests\/gamma\.test\.ts/);
    assert.doesNotMatch(fx.executions[0]!, /tests\/\*\.test\.ts/);
  } finally {
    await fx.cleanup();
  }
});

test("unit-test selection falls back to full stage on incomplete coverage", async () => {
  const fx = await perFileStageFixture();
  try {
    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "5".repeat(64), repoRoot: fx.root },
    });
    const initialCoverageSets = await runtimeCoverageSets(fx.ledgerRoot);
    assert.ok(initialCoverageSets.length >= 2, "setup must produce independent per-file coverage before fallback");
    const recordsRoot = join(fx.ledgerRoot, "records");
    const fingerprints = await readdir(recordsRoot);
    for (const fingerprint of fingerprints) {
      const currentPath = join(recordsRoot, fingerprint, "current.json");
      const current = JSON.parse(await readFile(currentPath, "utf8"));
      if (current.runtimeObservation?.kind === "v8-coverage" && current.runtimeObservation.files?.length === 2) {
        delete current.runtimeObservation;
        await writeFile(currentPath, JSON.stringify(current));
        break;
      }
    }
    fx.executions.length = 0;

    await runTestSuite([fx.stage], {
      runStageImpl: fx.runStageImpl,
      write: () => {},
      proofs: { ledgerRoot: fx.ledgerRoot, treeDigest: "6".repeat(64), repoRoot: fx.root },
    });

    assert.deepEqual(fx.executions, [fx.stage.command]);
  } finally {
    await fx.cleanup();
  }
});
