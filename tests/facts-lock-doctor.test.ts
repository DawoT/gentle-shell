import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyFactsLockDir, recoverFactsLockDir } from "../lib/facts/facts-lock-doctor.ts";

const CONTEXT = { boot: "01234567-89ab-cdef-0123-456789abcdef", host: "test-host", namespace: "pid:[1]" };

async function fixture(): Promise<{ directory: string; storageDir: string; lock: string }> {
  const directory = await mkdtemp(join(tmpdir(), "facts-doctor-"));
  const storageDir = join(directory, ".pi");
  const lock = join(storageDir, "facts.lock");
  await mkdir(lock, { recursive: true });
  return { directory, storageDir, lock };
}

async function writeOwner(lock: string, record: unknown, name = `owner-${randomUUID()}.json`) {
  await writeFile(join(lock, name), JSON.stringify(record));
  return name;
}

function ownerRecord(overrides: Record<string, unknown> = {}) {
  return { version: 1, pid: process.pid, context: CONTEXT, startedAt: Date.now(), ...overrides };
}

test("absent: no facts.lock directory classifies absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facts-doctor-"));
  try {
    const result = await classifyFactsLockDir(directory);
    assert.equal(result.classification, "absent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty-dir: empty lock directory classifies empty-dir", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "empty-dir");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid-live: record with alive pid and matching context", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord());
    const result = await classifyFactsLockDir(storageDir, CONTEXT);
    assert.equal(result.classification, "valid-live");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recoverable-dead: record whose pid is genuinely dead (ESRCH)", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(dead.status, 0);
    await writeOwner(lock, ownerRecord({ pid: dead.pid }));
    const result = await classifyFactsLockDir(storageDir, CONTEXT);
    assert.equal(result.classification, "recoverable-dead");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: exact 0-byte incident shape", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "");
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: unparseable JSON record", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "{");
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: oversized record (>4096 bytes)", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "x".repeat(4097));
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: bad owner record name", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify(ownerRecord()));
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: multiple entries", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord());
    await writeFile(join(lock, "unknown"), "x");
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: symlinked record", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    const target = join(directory, "target");
    await writeFile(target, JSON.stringify(ownerRecord()));
    await symlink(target, join(lock, `owner-${randomUUID()}.json`));
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: context mismatch with otherwise valid record", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord({ context: { ...CONTEXT, host: "other-host" } }));
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt-unknown: invalid pid", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord({ pid: -1 }));
    const result = await classifyFactsLockDir(storageDir);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid-unknown-liveness: valid record but context unavailable (report-only)", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord());
    const result = await classifyFactsLockDir(storageDir, undefined);
    assert.equal(result.classification, "valid-unknown-liveness");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("context unavailable + invalid pid still corrupt-unknown", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord({ pid: 0 }));
    const result = await classifyFactsLockDir(storageDir, undefined);
    assert.equal(result.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery removes recoverable-dead record and directory (unlink+rmdir)", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    const { spawnSync } = await import("node:child_process");
    const dead = spawnSync(process.execPath, ["-e", ""]);
    await writeOwner(lock, ownerRecord({ pid: dead.pid }));
    const result = await recoverFactsLockDir(storageDir);
    assert.equal(result.removed, true);
    await assert.rejects(readdir(lock), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery removes corrupt-unknown (0-byte incident shape)", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "");
    const result = await recoverFactsLockDir(storageDir);
    assert.equal(result.removed, true);
    await assert.rejects(readdir(lock), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery removes a facts.lock that exists as a regular file (live incident)", async () => {
  // Live dogfooding found this shape: facts.lock created as a FILE (not a
  // directory) must classify corrupt-unknown and recover by unlinking the
  // file — recovery's opendir used to crash with ENOTDIR instead.
  const { directory, storageDir } = await fixture();
  const lock = join(storageDir, "facts.lock");
  try {
    await rm(lock, { recursive: true, force: true });
    await writeFile(lock, "");
    const report = await classifyFactsLockDir(storageDir);
    assert.equal(report.classification, "corrupt-unknown");
    const result = await recoverFactsLockDir(storageDir);
    assert.equal(result.removed, true);
    await assert.rejects(async () => {
      await (await import("node:fs/promises")).stat(lock);
    }, { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery removes empty-dir", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    const result = await recoverFactsLockDir(storageDir);
    assert.equal(result.removed, true);
    await assert.rejects(readdir(lock), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery never touches valid-live or storage data", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord());
    await writeFile(join(storageDir, "facts.sqlite"), "data");
    const result = await recoverFactsLockDir(storageDir, CONTEXT);
    assert.equal(result.removed, false);
    const entries = await readdir(lock);
    assert.equal(entries.length, 1);
    assert.equal(await readdir(storageDir).then((e) => e.includes("facts.sqlite")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery never touches valid-unknown-liveness", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeOwner(lock, ownerRecord());
    const result = await recoverFactsLockDir(storageDir, undefined);
    assert.equal(result.removed, false);
    assert.equal((await readdir(lock)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recoverFactsLockDir on absent lock is a no-op", async () => {
  const directory = await mkdtemp(join(tmpdir(), "facts-doctor-"));
  try {
    const result = await recoverFactsLockDir(directory);
    assert.equal(result.removed, false);
    assert.equal(result.classification, "absent");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI report mode: exit 1 and JSON classifications for dirty lock", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "");
    let stdout = "";
    const code = (() => {
      try {
        stdout = execFileSync(process.execPath, ["--experimental-strip-types", join("bin", "gentle-facts-doctor.mjs"), storageDir, "--json"], { cwd: process.cwd(), encoding: "utf8" });
        return 0;
      } catch (error: any) {
        stdout = error.stdout ?? "";
        return error.status ?? -1;
      }
    })();
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.needsRecovery, true);
    const entry = parsed.results.find((r: any) => r.storageDir === storageDir);
    assert.equal(entry.classification, "corrupt-unknown");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI recovery mode: exit 0, removes lock, actions reported", async () => {
  const { directory, storageDir, lock } = await fixture();
  try {
    await writeFile(join(lock, `owner-${randomUUID()}.json`), "");
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", join("bin", "gentle-facts-doctor.mjs"), storageDir, "--recovery", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.needsRecovery, false);
    const entry = parsed.results.find((r: any) => r.storageDir === storageDir);
    assert.equal(entry.removed, true);
    await assert.rejects(readdir(lock), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
