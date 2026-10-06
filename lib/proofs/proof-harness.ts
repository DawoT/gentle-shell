import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeProofFingerprint, proofInputsDigest } from "./proof-fingerprint.ts";
import type { ProofLedger } from "./proof-ledger.ts";

const execFileAsync = promisify(execFile);

export interface HarnessStage {
  name: string;
  command: string;
}

export interface StageProofLayerOptions {
  ledger: ProofLedger;
  treeDigest: string;
  agent?: string;
}

export interface StageExecutionDecision {
  execute: boolean;
  reason: string;
}

function stageInput(stage: HarnessStage, treeDigest: string) {
  return {
    command: { argv: [stage.command], cwd: ".", taskKind: "test-suite-stage", selection: [stage.name] },
    repository: { treeDigest },
    toolchain: { runtime: "node", runtimeVersion: process.version, os: process.platform, arch: process.arch },
    environment: { declared: {}, sensitive: {}, hmacKey: "stage-proof-layer" },
  };
}

/**
 * Stage-level proof layer for the sequential test-suite harness. A stage's
 * proof fingerprint covers its exact command plus the repository tree digest,
 * so any source, manifest or configuration change produces a different
 * fingerprint and re-executes the stage; an unchanged tree reuses the
 * published proof. Failed stages are evidence and always re-execute.
 */
export function createStageProofLayer(options: StageProofLayerOptions) {
  const { ledger, treeDigest } = options;
  return {
    async shouldExecute(stage: HarnessStage): Promise<StageExecutionDecision> {
      const input = stageInput(stage, treeDigest);
      const fingerprint = computeProofFingerprint(input);
      const proof = await ledger.current(fingerprint);
      if (!proof) return { execute: true, reason: "no published proof for this stage and tree" };
      if (proof.status !== "passed") return { execute: true, reason: `the previous stage proof is ${proof.status}; execute` };
      return { execute: false, reason: `reused stage proof ${fingerprint.slice(0, 12)} (seq ${proof.seq})` };
    },
    async recordResult(stage: HarnessStage, code: number): Promise<void> {
      const input = stageInput(stage, treeDigest);
      const fingerprint = computeProofFingerprint(input);
      const record = await ledger.start({
        fingerprint,
        inputsDigest: proofInputsDigest(input),
        confidence: "hermetic_static",
        sideEffects: "pure_validation",
        ...(options.agent ? { agent: options.agent } : {}),
      });
      await ledger.finish(record, { status: code === 0 ? "passed" : "failed", exitCode: code });
    },
  };
}

/**
 * Cheap deterministic repository tree digest: HEAD commit plus a digest of
 * the working-tree status. Clean tree -> stable digest; any tracked or
 * untracked change moves it.
 */
export async function computeTreeDigest(root: string): Promise<string> {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root, maxBuffer: 1024 * 1024 }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: root, maxBuffer: 1024 * 1024 }),
  ]);
  return createHash("sha256").update(`${head.stdout.trim()}\u0000${status.stdout}\u0000`).digest("hex");
}
