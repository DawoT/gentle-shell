export interface ExecutionLeaseOptions {
  now?: () => number;
  /** A lease without heartbeats expires after this long and can be taken over. */
  leaseTtlMs?: number;
}

export interface ExecutionLeaseHandle {
  fingerprint: string;
  owner: string;
  acquiredAt: number;
  heartbeat(): void;
  release(): void;
}

export type LeaseAcquisition =
  | { state: "acquired"; lease: ExecutionLeaseHandle; tookOver?: boolean }
  | { state: "wait"; owner: string; expiresAt: number };

interface LeaseEntry {
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}

/**
 * In-process single-flight execution leases keyed by proof fingerprint: one
 * owner executes, equivalent callers wait for or subscribe to the same proof.
 * A lease without heartbeats expires after the TTL and can then be taken
 * over by a proven-lost-owner takeover; the takeover is recorded as
 * provenance. Cross-process leases are deliberately out of scope here - the
 * ledger is local-first, and a file-lock variant can layer on later without
 * changing this contract.
 */
export class ExecutionLeaseRegistry {
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly options: ExecutionLeaseOptions;

  constructor(options: ExecutionLeaseOptions = {}) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private ttl(): number {
    return this.options.leaseTtlMs ?? 30_000;
  }

  acquire(fingerprint: string, owner: string): LeaseAcquisition {
    const existing = this.leases.get(fingerprint);
    const now = this.now();
    if (existing && existing.expiresAt > now) {
      return { state: "wait", owner: existing.owner, expiresAt: existing.expiresAt };
    }
    const tookOver = existing !== undefined;
    const entry: LeaseEntry = { owner, acquiredAt: now, expiresAt: now + this.ttl() };
    this.leases.set(fingerprint, entry);
    const lease: ExecutionLeaseHandle = {
      fingerprint,
      owner,
      acquiredAt: now,
      heartbeat: () => {
        // Only the current holder may extend the lease; a stale handle whose
        // entry was taken over must not resurrect it.
        if (this.leases.get(fingerprint) === entry) entry.expiresAt = this.now() + this.ttl();
      },
      release: () => {
        if (this.leases.get(fingerprint) === entry) this.leases.delete(fingerprint);
      },
    };
    return { state: "acquired", lease, ...(tookOver ? { tookOver: true } : {}) };
  }
}
