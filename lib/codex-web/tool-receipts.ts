import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface ToolClaim {
  version: 1;
  scope: string;
  callId: string;
  tool: string;
  inputDigest: string;
  nonce: string;
  admittedAt: number;
}

interface Settlement {
  version: 1;
  nonce: string;
  resultDigest: string;
  isError: boolean;
  observedAt: number;
}

export interface ToolReceipt {
  claim: ToolClaim;
  state: "admitted" | "result-observed";
  isError?: boolean;
}

/** Immutable admission and result observations. Never replays results or unlocks a claim. */
export class ToolReceipts {
  readonly scope: string;
  readonly directory?: string;
  private readonly memory = new Map<string, ToolReceipt>();

  constructor(sessionId: string, cwd: string, sessionFile?: string) {
    this.scope = digest([sessionId, resolve(cwd), sessionFile ? resolve(sessionFile) : null]);
    if (sessionFile) this.directory = join(dirname(resolve(sessionFile)), "web-recovery", this.scope);
  }

  async admit(callId: string, tool: string, input: unknown): Promise<ToolClaim> {
    if (!callId || callId.length > 2048 || !/^[A-Za-z0-9_-]{1,128}$/.test(tool)) {
      throw new Error("Invalid recovery tool identity");
    }
    const claim: ToolClaim = {
      version: 1,
      scope: this.scope,
      callId,
      tool,
      inputDigest: digest(input),
      nonce: randomUUID(),
      admittedAt: Date.now(),
    };
    if (!this.directory) {
      if (this.memory.has(callId)) throw new Error("Tool call already admitted; inspect /web-bridge recovery. Do not replay it.");
      if (this.memory.size >= 4096) throw new Error("Recovery receipt capacity reached");
      this.memory.set(callId, { claim, state: "admitted" });
      return claim;
    }
    await this.prepareDirectory(true);
    const lock = join(this.directory, ".admission-lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Error("Recovery admission is busy or interrupted; execution blocked. Inspect /web-bridge recovery.");
    }
    try {
      let count = 0;
      let scanned = 0;
      const entries = await opendir(this.directory);
      for await (const entry of entries) {
        scanned += 1;
        if (scanned > 8192) throw new Error("Recovery directory scan limit reached");
        if (entry.name.endsWith(".claim.json")) count += 1;
        if (count >= 4096) throw new Error("Recovery receipt capacity reached");
      }
      if (await this.exists(this.path(callId, "claim"))) {
        throw new Error("Tool call already admitted; inspect /web-bridge recovery. Do not replay it.");
      }
      if (await this.exists(this.path(callId, "result"))) {
        throw new Error("Orphan recovery result exists; execution blocked");
      }
      try {
        await this.publish(this.path(callId, "claim"), claim);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("Tool call already admitted; inspect /web-bridge recovery. Do not replay it.");
        }
        throw error;
      }
      return claim;
    } finally {
      await rmdir(lock);
    }
  }

  async settle(claim: ToolClaim, content: unknown, isError: boolean): Promise<void> {
    if (claim.scope !== this.scope) throw new Error("Recovery claim scope changed");
    const settlement: Settlement = {
      version: 1,
      nonce: claim.nonce,
      resultDigest: digest(content),
      isError,
      observedAt: Date.now(),
    };
    const current = await this.inspect(claim.callId);
    if (!current || current.claim.nonce !== claim.nonce || current.state !== "admitted") {
      throw new Error("Recovery claim ownership changed or result was already observed");
    }
    if (!this.directory) {
      this.memory.set(claim.callId, { claim, state: "result-observed", isError });
    } else {
      await this.publish(this.path(claim.callId, "result"), settlement);
    }
  }

  async inspect(callId: string): Promise<ToolReceipt | undefined> {
    if (!this.directory) return this.memory.get(callId);
    await this.prepareDirectory(false);
    const claim = await this.read(this.path(callId, "claim")) as ToolClaim | undefined;
    if (!claim) return undefined;
    if (claim.version !== 1 || claim.scope !== this.scope || claim.callId !== callId
      || typeof claim.tool !== "string" || typeof claim.nonce !== "string"
      || !/^[a-f0-9]{64}$/.test(claim.inputDigest) || !Number.isSafeInteger(claim.admittedAt)) {
      throw new Error("Invalid recovery claim; execution remains blocked");
    }
    const result = await this.read(this.path(callId, "result")) as Settlement | undefined;
    if (!result) return { claim, state: "admitted" };
    if (result.version !== 1 || result.nonce !== claim.nonce || typeof result.isError !== "boolean"
      || !/^[a-f0-9]{64}$/.test(result.resultDigest) || !Number.isSafeInteger(result.observedAt)) {
      throw new Error("Invalid recovery result; execution remains blocked");
    }
    return { claim, state: "result-observed", isError: result.isError };
  }

  async list(): Promise<{ receipts: ToolReceipt[]; truncated: boolean; interruptedAdmission: boolean }> {
    if (!this.directory) {
      return { receipts: [...this.memory.values()].slice(0, 10), truncated: this.memory.size > 10, interruptedAdmission: false };
    }
    const receipts: ToolReceipt[] = [];
    let scanned = 0;
    let interruptedAdmission = false;
    let truncated = false;
    try {
      await this.prepareDirectory(false);
      const entries = await opendir(this.directory);
      for await (const entry of entries) {
        scanned += 1;
        if (entry.name === ".admission-lock") interruptedAdmission = true;
        if (entry.name.endsWith(".claim.json")) {
          if (receipts.length === 10) {
            truncated = true;
            break;
          }
          const claim = await this.read(join(this.directory, entry.name)) as ToolClaim;
          const receipt = await this.inspect(claim.callId);
          if (receipt) receipts.push(receipt);
        }
        if (scanned >= 64) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { receipts, truncated, interruptedAdmission };
  }

  private path(callId: string, kind: "claim" | "result"): string {
    return join(this.directory!, `${digest(callId)}.${kind}.json`);
  }

  private async prepareDirectory(create: boolean): Promise<void> {
    const sessionDirectory = dirname(dirname(this.directory!));
    const parent = await lstat(sessionDirectory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw new Error("Recovery session directory is not a regular directory");
    }
    for (const path of [dirname(this.directory!), this.directory!]) {
      if (create) {
        try {
          await mkdir(path, { mode: 0o700 });
          if (process.platform !== "win32") await this.syncDirectory(dirname(path));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
        throw new Error("Recovery storage is not a private owned directory");
      }
    }
  }

  private async publish(path: string, value: unknown): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > 8192) throw new Error("Recovery receipt exceeds its size budget");
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    if (process.platform !== "win32") await this.syncDirectory(this.directory!);
  }

  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async read(path: string): Promise<unknown | undefined> {
    let file;
    try {
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 8192) throw new Error("Invalid recovery receipt file");
      const bytes = Buffer.alloc(8193);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 8192) throw new Error("Recovery receipt exceeds its size budget");
      return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    } finally {
      await file?.close();
    }
  }
}
