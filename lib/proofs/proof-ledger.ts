import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export type ProofStatus = "running" | "passed" | "failed" | "stale" | "expired" | "invalidated" | "aborted";
export type SideEffectClass = "pure_validation" | "reproducible_build" | "local_mutation" | "external_side_effect";
export type ConfidenceClass = "hermetic_static" | "hermetic_unit" | "controlled_integration" | "controlled_local_e2e" | "remote_or_nondeterministic";

export interface ProofRecord {
  proofVersion: 1;
  seq: number;
  fingerprint: string;
  status: ProofStatus;
  confidence: ConfidenceClass;
  sideEffects: SideEffectClass;
  inputsDigest: string;
  startedAt: number;
  agent?: string;
  finishedAt?: number;
  exitCode?: number;
  durationMs?: number;
  /** Digests only: raw command output is never proof material. */
  outputDigests?: { stdout: string; stderr: string };
  invalidationReason?: string;
}

export interface ProofStartInput {
  fingerprint: string;
  inputsDigest: string;
  confidence: ConfidenceClass;
  sideEffects: SideEffectClass;
  agent?: string;
}

const PROOF_VERSION = 1;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const OUTPUT_DIGEST = /^[a-f0-9]{64}$/;

/** Forward-only lifecycle for the current view; a re-run publishes a new immutable artifact. */
const TRANSITIONS: Record<ProofStatus, ProofStatus[]> = {
  running: ["passed", "failed", "aborted"],
  passed: ["stale", "expired", "invalidated"],
  failed: ["stale", "invalidated"],
  stale: [],
  expired: [],
  invalidated: [],
  aborted: [],
};

const RAW_OUTPUT_KEYS = new Set(["stdout", "stderr", "output", "logs"]);

export class ProofLifecycleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProofLifecycleError";
  }
}

/**
 * Local, content-addressed Execution Proof Ledger. Every completed execution
 * publishes ONE immutable numbered artifact under records/<fingerprint>/; the
 * replaceable current.json pointer selects the latest view and carries
 * lifecycle annotations (stale/expired/invalidated). Records carry digests
 * and bounded references only; raw command output is rejected as proof
 * material. Single-flight per fingerprint is the caller's responsibility
 * (the execution lease), so concurrent starts for one fingerprint are
 * intentionally not supported here.
 */
export class ProofLedger {
  private readonly root: string;

  constructor(root: string) {
    this.root = join(root, "records");
  }

  /** Registers an execution and assigns its immutable artifact sequence number. */
  async start(input: ProofStartInput): Promise<ProofRecord> {
    if (!FINGERPRINT.test(input.fingerprint)) throw new Error("Invalid proof fingerprint");
    if (!FINGERPRINT.test(input.inputsDigest)) throw new Error("Invalid proof inputs digest");
    const seq = await this.nextSeq(input.fingerprint);
    return {
      proofVersion: PROOF_VERSION,
      seq,
      fingerprint: input.fingerprint,
      status: "running",
      confidence: input.confidence,
      sideEffects: input.sideEffects,
      inputsDigest: input.inputsDigest,
      startedAt: Date.now(),
      ...(input.agent ? { agent: input.agent } : {}),
    };
  }

  /**
   * Publishes the immutable artifact for a completed run and updates the
   * current view. The running record lives with the caller (the execution
   * lease); the disk only ever holds published views.
   */
  async finish(record: ProofRecord, patch: { status: Extract<ProofStatus, "passed" | "failed" | "aborted">; exitCode?: number; durationMs?: number; outputDigests?: { stdout: string; stderr: string } }): Promise<ProofRecord> {
    const raw = Object.keys(patch).find((key) => RAW_OUTPUT_KEYS.has(key));
    if (raw) throw new Error(`Raw output ("${raw}") is not proof material; store outputDigests only`);
    if (record.proofVersion !== PROOF_VERSION || !FINGERPRINT.test(record.fingerprint) || record.status !== "running") {
      throw new ProofLifecycleError("finish() requires a running proof record created by start()");
    }
    const current = await this.readPointer(record.fingerprint);
    if (current && current.seq >= record.seq) {
      throw new ProofLifecycleError(`Proof run ${record.seq} was already published or superseded by run ${current.seq}`);
    }
    const finished: ProofRecord = {
      ...record,
      status: patch.status,
      finishedAt: Date.now(),
      ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
      ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
      ...(patch.outputDigests ? { outputDigests: validateOutputDigests(patch.outputDigests) } : {}),
    };
    await publishArtifact(this.root, record.fingerprint, record.seq, JSON.stringify(finished));
    return finished;
  }

  /** Annotates the current view; the published artifact stays untouched. */
  async transition(fingerprint: string, status: Extract<ProofStatus, "stale" | "expired" | "invalidated">, invalidationReason?: string): Promise<ProofRecord> {
    const record = await this.loadCurrent(fingerprint);
    if (!TRANSITIONS[record.status]?.includes(status)) {
      throw new ProofLifecycleError(`Invalid proof lifecycle transition ${record.status} -> ${status}`);
    }
    const annotated: ProofRecord = {
      ...record,
      status,
      ...(invalidationReason !== undefined ? { invalidationReason } : {}),
    };
    await this.writePointer(fingerprint, JSON.stringify(annotated));
    return annotated;
  }

  async current(fingerprint: string): Promise<ProofRecord | null> {
    return await this.readPointer(fingerprint);
  }

  private async readPointer(fingerprint: string): Promise<ProofRecord | null> {
    if (!FINGERPRINT.test(fingerprint)) throw new Error("Invalid proof fingerprint");
    let text: string;
    try {
      text = (await readFile(join(this.root, fingerprint, "current.json"))).toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const record = JSON.parse(text) as ProofRecord;
    if (record.fingerprint !== fingerprint) throw new Error("Proof record fingerprint mismatch");
    return record;
  }

  private async loadCurrent(fingerprint: string): Promise<ProofRecord> {
    const record = await this.readPointer(fingerprint);
    if (!record) throw new ProofLifecycleError(`No published proof view for fingerprint ${fingerprint}`);
    return record;
  }

  private async writePointer(fingerprint: string, text: string): Promise<void> {
    const pointer = join(this.root, fingerprint, "current.json");
    const temporary = `${pointer}.${process.pid}.tmp`;
    await atomicWrite(temporary, pointer, text);
  }

  private async nextSeq(fingerprint: string): Promise<number> {
    try {
      const entries = await readdir(join(this.root, fingerprint));
      const numbers = entries.filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5)));
      return numbers.length ? Math.max(...numbers) + 1 : 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
      throw error;
    }
  }
}

function validateOutputDigests(digests: { stdout?: string; stderr?: string }): { stdout: string; stderr: string } {
  for (const part of ["stdout", "stderr"] as const) {
    if (digests[part] === undefined || !OUTPUT_DIGEST.test(digests[part])) {
      throw new Error(`Proof output digest for ${part} must be a sha256 hex digest`);
    }
  }
  return digests as { stdout: string; stderr: string };
}

async function publishArtifact(root: string, fingerprint: string, seq: number, text: string): Promise<void> {
  const directory = join(root, fingerprint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const artifact = join(directory, `${seq}.json`);
  const temporary = `${artifact}.${process.pid}.tmp`;
  await atomicWrite(temporary, artifact, text);
  const pointer = join(directory, "current.json");
  const pointerTemporary = `${pointer}.${process.pid}.tmp`;
  await atomicWrite(pointerTemporary, pointer, text);
}

async function atomicWrite(temporary: string, target: string, text: string): Promise<void> {
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    try {
      await handle.close();
    } catch {
      // already closed
    }
    throw error;
  }
}
