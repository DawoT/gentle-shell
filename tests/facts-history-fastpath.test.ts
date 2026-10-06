import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsService } from "../lib/facts/facts-service.ts";
import { FactsHistory } from "../lib/facts/facts-history.ts";
import { recordFactsHistory } from "../lib/facts/facts-history-extension.ts";

const sessionDirs: string[] = [];
after(async () => {
  for (const d of sessionDirs) await rm(d, { recursive: true, force: true });
});

function sessionContext(dir: string) {
  // Transcripts live outside the indexed workspace, like production sessions,
  // in a per-run temp directory so snapshot residue never accumulates.
  const sessionDir = mkdtempSync(join(tmpdir(), "facts-history-session-"));
  sessionDirs.push(sessionDir);
  const sessionFile = join(sessionDir, "session.jsonl");
  const branch: any[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
  };
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getSessionFile: () => sessionFile,
    },
  };
  return { pi, ctx };
}

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-history-fastpath-"));
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

test("history recording reuses the receipt while the generation is unchanged", async (t) => {
  const { dir, cleanup } = await createFixture();
  const saveOrig = FactsHistory.prototype.save;
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });

    const save = t.mock.method(FactsHistory.prototype, "save", async function (database, edges, signal) {
      return saveOrig.call(this, database, edges, signal);
    });
    const { pi, ctx } = sessionContext(dir);
    const first = await recordFactsHistory(pi as never, ctx as never, service);
    assert.ok(first);
    const second = await recordFactsHistory(pi as never, ctx as never, service);
    assert.deepEqual(second, first);
    assert.equal(save.mock.callCount(), 1, "the unchanged generation must not be canonicalized again");
  } finally {
    await cleanup();
  }
});

test("a newly published generation records a fresh receipt", async (t) => {
  const { dir, cleanup } = await createFixture();
  const saveOrig = FactsHistory.prototype.save;
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });

    const save = t.mock.method(FactsHistory.prototype, "save", async function (database, edges, signal) {
      return saveOrig.call(this, database, edges, signal);
    });
    const { pi, ctx } = sessionContext(dir);
    const first = await recordFactsHistory(pi as never, ctx as never, service);
    assert.ok(first);

    await writeFile(join(dir, "source.ts"), "export const value = 2;\n");
    await service.sync(undefined, { mode: "auto" });
    const second = await recordFactsHistory(pi as never, ctx as never, service);
    assert.ok(second);
    assert.equal(save.mock.callCount(), 2, "the new generation must be serialized and hashed");
    assert.notEqual(second.digest, first.digest);
  } finally {
    await cleanup();
  }
});

test("an unchanged generation after a forced full sync also reuses the receipt", async (t) => {
  const { dir, cleanup } = await createFixture();
  const saveOrig = FactsHistory.prototype.save;
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });

    const save = t.mock.method(FactsHistory.prototype, "save", async function (database, edges, signal) {
      return saveOrig.call(this, database, edges, signal);
    });
    const { pi, ctx } = sessionContext(dir);
    const first = await recordFactsHistory(pi as never, ctx as never, service);
    assert.ok(first);

    // Reconciliation on an unchanged tree: full sync, same generation.
    await service.sync(undefined, { mode: "full" });
    const second = await recordFactsHistory(pi as never, ctx as never, service);
    assert.deepEqual(second, first);
    assert.equal(save.mock.callCount(), 1);
  } finally {
    await cleanup();
  }
});
