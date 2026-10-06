import { createHash, createHmac } from "node:crypto";

export interface ProofCommand {
  argv: string[];
  cwd: string;
  taskKind: string;
  selection?: string[];
}

export interface ProofRepository {
  treeDigest: string;
  factsGeneration?: string;
  manifestDigest?: string;
  configDigests?: string[];
}

export interface ProofToolchain {
  runtime: string;
  runtimeVersion: string;
  runner?: string;
  runnerVersion?: string;
  os: string;
  arch: string;
}

export interface ProofEnvironment {
  declared: Record<string, string>;
  /** Value-sensitive variables; only an HMAC digest is ever persisted. */
  sensitive: Record<string, string>;
  hmacKey: string;
}

export interface ProofFingerprintInput {
  command: ProofCommand;
  repository: ProofRepository;
  toolchain: ProofToolchain;
  environment: ProofEnvironment;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function requireText(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Proof fingerprint input missing required dimension: ${label}`);
  }
}

/**
 * Canonicalize and validate every required input dimension. A missing
 * dimension throws: an incomplete fingerprint must never exist, because reuse
 * decisions can only be as strong as the inputs they cover. Sensitive
 * environment values are replaced by an HMAC digest of their value; neither
 * the values nor the key are part of the canonical output.
 */
export function canonicalProofInputsForStorage(input: ProofFingerprintInput): Record<string, unknown> {
  requireText(input.command?.cwd, "command.cwd");
  requireText(input.command?.taskKind, "command.taskKind");
  if (!Array.isArray(input.command?.argv) || input.command.argv.length === 0 || input.command.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error("Proof fingerprint input missing required dimension: command.argv");
  }
  requireText(input.repository?.treeDigest, "repository.treeDigest");
  requireText(input.toolchain?.runtime, "toolchain.runtime");
  requireText(input.toolchain?.runtimeVersion, "toolchain.runtimeVersion");
  requireText(input.toolchain?.os, "toolchain.os");
  requireText(input.toolchain?.arch, "toolchain.arch");

  const sensitive = Object.fromEntries(Object.entries(input.environment.sensitive ?? {}).map(([name, value]) => [
    name, createHmac("sha256", input.environment.hmacKey).update(value).digest("hex"),
  ]));
  return canonical({
    command: input.command,
    repository: input.repository,
    toolchain: input.toolchain,
    environment: { declared: input.environment.declared ?? {}, sensitiveHmac: sensitive },
  }) as Record<string, unknown>;
}

/** Content digest of the canonical, validated input set. */
export function proofInputsDigest(input: ProofFingerprintInput): string {
  return digest(JSON.stringify(canonicalProofInputsForStorage(input)));
}

/** The canonical execution identity a proof is addressed by. */
export function computeProofFingerprint(input: ProofFingerprintInput): string {
  return proofInputsDigest(input);
}
