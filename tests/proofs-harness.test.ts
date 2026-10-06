import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStageProofLayer, computeTreeDigest } from "../lib/proofs/proof-harness.ts";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";
import { runTestSuite } from "../scripts/run-test-suite.mjs";

const STAGES = [
  { name: "unit-tests", command: "node --test tests/*.test.ts" },
  { name: "provider-contract", command: "pnpm run check:provider-contract" },
];

async function gitFixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofs-harness-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("computeTreeDigest is stable for an unchanged tree and moves with changes", async () => {
  const { dir, cleanup } = await gitFixture();
  try {
    await writeFile2(join(dir, "source.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    const before = await computeTreeDigest(dir);
    assert.match(before, /^[a-f0-9]{64}$/);
    assert.equal(await computeTreeDigest(dir), before, "unchanged tree: identical digest");

    await writeFile2(join(dir, "source.ts"), "export const value = 2;\n");
    assert.notEqual(await computeTreeDigest(dir), before, "dirty working tree: different digest");
  } finally {
    await cleanup();
  }
});

test("stage proofs reuse unchanged stages and re-execute after a tree change", async () => {
  const { dir, cleanup } = await gitFixture();
  try {
    const ledger = new ProofLedger(join(dir, "proofs"));
    const treeDigest = "a".repeat(64);

    const first = createStageProofLayer({ ledger, treeDigest, agent: "harness" });
    const d1 = await first.shouldExecute(STAGES[0]);
    assert.equal(d1.execute, true);
    await first.recordResult(STAGES[0], 0);
    await first.recordResult(STAGES[1], 0);
    assert.match(d1.reason.length > 0 ? d1.reason : "", /^/);

    const second = createStageProofLayer({ ledger, treeDigest });
    const d2 = await second.shouldExecute(STAGES[0]);
    assert.equal(d2.execute, false, "unchanged tree and command: the stage proof is reused");
    assert.match(d2.reason, /reused|proof/i);

    const changed = createStageProofLayer({ ledger, treeDigest: "b".repeat(64) });
    const d3 = await changed.shouldExecute(STAGES[0]);
    assert.equal(d3.execute, true, "a tree change must re-execute the stage");
  } finally {
    await cleanup();
  }
});

test("a failed stage re-executes on the next run (evidence, never a block)", async () => {
  const { dir, cleanup } = await gitFixture();
  try {
    const ledger = new ProofLedger(join(dir, "proofs"));
    const treeDigest = "a".repeat(64);
    const first = createStageProofLayer({ ledger, treeDigest });
    await first.shouldExecute(STAGES[0]);
    await first.recordResult(STAGES[0], 1);

    const second = createStageProofLayer({ ledger, treeDigest });
    const decision = await second.shouldExecute(STAGES[0]);
    assert.equal(decision.execute, true, "a cached failure must never block execution");
  } finally {
    await cleanup();
  }
});

test("runTestSuite with proofs surfaces reused-vs-executed per stage", async () => {
  const { dir, cleanup } = await gitFixture();
  try {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    const runStageImpl = async (stage: { name: string }) => ({ name: stage.name, code: 0 });
    const proofs = { ledgerRoot: join(dir, "proofs"), treeDigest: "a".repeat(64) };

    await runTestSuite(STAGES, { runStageImpl, write, proofs });
    assert.equal(lines.filter((line) => line.startsWith("PASS")).length, 2, "first run: every stage executes");

    const secondLines: string[] = [];
    await runTestSuite(STAGES, { runStageImpl, write: (line) => secondLines.push(line), proofs });
    assert.equal(secondLines.filter((line) => line.startsWith("REUSED [")).length, 2, "second run: every stage is reused");
    assert.equal(secondLines.filter((line) => line.startsWith("REUSED  ")).length, 2, "the summary surfaces reused stages too");
    assert.match(secondLines.join("\n"), /all stages passed/);
  } finally {
    await cleanup();
  }
});

async function writeFile2(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content);
}
