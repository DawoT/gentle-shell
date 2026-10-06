import { ProofLedger, type ProofRecord, type ProofStatus } from "./proof-ledger.ts";
import { decideProofReuse } from "./proof-policy.ts";
import { ExecutionLeaseRegistry } from "./proof-lease.ts";
import { selectMinimumTestSet, type Reachability, type TestInventoryEntry } from "./proof-invalidation.ts";

export interface ProofAwareRunOptions {
  ledger: ProofLedger;
  inventory: TestInventoryEntry[];
  fingerprintFor: (entry: TestInventoryEntry) => { fingerprint: string; inputsDigest: string };
  currentFileDigests: Record<string, string>;
  reaches: (changedFile: string, coveredFile: string) => Reachability;
  changedFiles: string[];
  runTest: (entry: TestInventoryEntry) => Promise<{ passed: boolean; exitCode?: number; durationMs?: number; outputDigests?: { stdout: string; stderr: string } }>;
  agent?: string;
  /** Bypass reuse for every entry, but publish fresh evidence. */
  forceRun?: boolean;
  /** Neither reuse nor publish; plain execution. */
  noCache?: boolean;
  allowUnreachableReuse?: boolean;
  now?: () => number;
}

export interface ExecutedEntry {
  name: string;
  status: ProofStatus | "executed";
  passed: boolean;
  reason: string;
  durationMs?: number;
}

export interface ProofAwareRunResult {
  green: boolean;
  reused: { name: string; seq: number; reason: string }[];
  executed: ExecutedEntry[];
  /** Entries the engine could not account for; green is impossible while non-empty. */
  unaccounted: string[];
  fallback: boolean;
}

/**
 * Proof-aware suite runner (gaps GF-P2-001 + GF-P2-008): selects the minimum
 * set through layered invalidation, reuses valid hermetic proofs, executes
 * everything else under the single-flight lease, and publishes evidence.
 * Stage independence is preserved: one throwing or failing stage never
 * suppresses another. green is true only when every inventory entry is
 * accounted for by a reused passed proof or a fresh passed execution - a
 * suite verdict can never be composed from stale constituents.
 */
export async function runSuiteWithProofs(options: ProofAwareRunOptions): Promise<ProofAwareRunResult> {
  const proofViews = new Map<string, ProofRecord | null>();
  for (const entry of options.inventory) {
    proofViews.set(entry.name, options.noCache ? null : await options.ledger.current(options.fingerprintFor(entry).fingerprint));
  }
  // The reuse policy gates every candidate before invalidation runs: a proof
  // rejected by policy (status, side effects, confidence) is dropped here and
  // its explanation kept for the executed reason.
  const policyRejections = new Map<string, string>();
  const selection = selectMinimumTestSet({
    inventory: options.inventory,
    proofFor: (entry) => {
      const proof = proofViews.get(entry.name) ?? null;
      if (!proof) return null;
      const verdict = decideProofReuse(options.fingerprintFor(entry).fingerprint, proof, { now: options.now });
      if (verdict.decision !== "reuse") {
        policyRejections.set(entry.name, verdict.reason);
        return null;
      }
      return proof;
    },
    currentFileDigests: options.currentFileDigests,
    reaches: options.reaches,
    changedFiles: options.changedFiles,
    allowUnreachableReuse: options.allowUnreachableReuse,
  });
  if (options.forceRun) {
    for (const item of selection.reuse) {
      selection.execute.push({ name: item.name, reason: "force-run bypassed reuse; executing for fresh evidence." });
    }
    selection.reuse.length = 0;
  }

  const leases = new ExecutionLeaseRegistry({ now: options.now });
  const reused = selection.reuse.map((item) => ({ name: item.name, seq: item.proof!.seq, reason: item.reason }));
  const executed: ExecutedEntry[] = [];
  for (const item of selection.execute) {
    const entry = options.inventory.find((candidate) => candidate.name === item.name);
    if (!entry) continue;
    if (options.noCache) {
      executed.push(await executePlain(entry, item.reason, options));
      continue;
    }
    const { fingerprint, inputsDigest } = options.fingerprintFor(entry);
    const acquisition = leases.acquire(fingerprint, options.agent ?? "proof-runner");
    // Sequential execution cannot contend; a wait here would mean a duplicate
    // fingerprint inside one inventory, which single-flight resolves by
    // executing without publishing through this lease.
    const lease = acquisition.state === "acquired" ? acquisition.lease : undefined;
    const record = await options.ledger.start({
      fingerprint,
      inputsDigest,
      confidence: entry.confidence,
      sideEffects: entry.sideEffects,
      ...(options.agent ? { agent: options.agent } : {}),
    });
    try {
      const result = await options.runTest(entry);
      const finished = await options.ledger.finish(record, {
        status: result.passed ? "passed" : "failed",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(result.outputDigests ? { outputDigests: result.outputDigests } : {}),
      });
      executed.push({
        name: entry.name,
        status: finished.status,
        passed: result.passed,
        reason: policyRejections.get(entry.name) ?? item.reason,
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      });
    } catch (error) {
      // Stage independence: the crashed stage is recorded as aborted evidence
      // and the remaining stages still run.
      await options.ledger.finish(record, { status: "aborted" });
      executed.push({ name: entry.name, status: "aborted", passed: false, reason: `Runner error: ${(error as Error).message}` });
    } finally {
      lease?.release();
    }
  }

  const accounted = new Set([...reused.map((item) => item.name), ...executed.map((item) => item.name)]);
  const unaccounted = options.inventory.map((entry) => entry.name).filter((name) => !accounted.has(name));
  const green = unaccounted.length === 0 && executed.every((item) => item.passed);
  return { green, reused, executed, unaccounted, fallback: selection.fallback };
}

async function executePlain(entry: TestInventoryEntry, reason: string, options: ProofAwareRunOptions): Promise<ExecutedEntry> {
  try {
    const result = await options.runTest(entry);
    return {
      name: entry.name,
      status: "executed",
      passed: result.passed,
      reason,
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    };
  } catch (error) {
    return { name: entry.name, status: "aborted", passed: false, reason: `Runner error: ${(error as Error).message}` };
  }
}
