import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsStore } from "../lib/facts/facts-store.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { WorkspaceEpoch } from "../lib/facts/facts-workspace-epoch.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("WorkspaceEpoch tracks dirty state, revisions and ignores cache writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-epoch-"));
  try {
    const epoch = new WorkspaceEpoch(dir);
    epoch.start();
    try {
      // No full sync has cleaned the epoch yet: conservative start.
      assert.equal(epoch.isClean(), false);
      epoch.markClean();
      assert.equal(epoch.isClean(), true);

      const before = epoch.revision;
      epoch.markDirty("manual");
      assert.equal(epoch.isClean(), false);
      assert.equal(epoch.revision, before + 1);
      epoch.markClean();

      // External working-tree edits are observed through the watcher.
      await writeFile(join(dir, "source.ts"), "export const a = 1;\n");
      await waitFor(() => !epoch.isClean());
      epoch.markClean();

      // Writes inside the Facts cache and Git metadata are not workspace changes.
      await mkdir(join(dir, ".pi"), { recursive: true });
      await mkdir(join(dir, ".git"), { recursive: true });
      await writeFile(join(dir, ".pi", "facts.json"), "{}");
      await writeFile(join(dir, ".git", "index"), "x");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(epoch.isClean(), true);
    } finally {
      epoch.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(join(dir, "after-close.ts"), "export const b = 2;\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(epoch.isClean(), true, "closed watcher must not observe changes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed watcher keeps the epoch dirty forever", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-epoch-fail-"));
  try {
    // Start the watcher on a root that no longer exists: watch fails for real.
    await rm(dir, { recursive: true, force: true });
    const epoch = new WorkspaceEpoch(dir);
    epoch.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    epoch.markClean();
    assert.equal(epoch.isClean(), false, "no fast path without a live watcher");
    epoch.markClean(epoch.revision);
    assert.equal(epoch.isClean(), false);
  } finally {
    // The directory is already gone; nothing to remove.
  }
});

test("auto sync serves a clean workspace without rescanning", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true });

    const first = await service.sync(undefined, { mode: "auto" });
    assert.equal(first.path, "full");
    assert.equal(first.indexedCount, 1);

    const second = await service.sync(undefined, { mode: "auto" });
    assert.equal(second.path, "fast");
    assert.equal(second.indexedCount, 0);
    assert.equal(second.cachedCount, 1);

    const metrics = service.getPhaseMetrics();
    assert.equal(metrics.refreshTotal, 2);
    assert.equal(metrics.phases.git_scan?.count, 1, "fast path must not rescan");
    assert.ok((metrics.phases.fast_path?.count ?? 0) >= 1);
  } finally {
    await cleanup();
  }
});

test("default sync stays a full conservative refresh", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true });
    await service.sync();
    await service.sync();
    const metrics = service.getPhaseMetrics();
    assert.equal(metrics.refreshTotal, 2);
    assert.equal(metrics.phases.git_scan?.count, 2);
    assert.equal(metrics.phases.fast_path?.count ?? 0, 0);
  } finally {
    await cleanup();
  }
});

test("fast path disabled makes auto behave like full", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir);
    const first = await service.sync(undefined, { mode: "auto" });
    const second = await service.sync(undefined, { mode: "auto" });
    assert.equal(first.path, "full");
    assert.equal(second.path, "full");
    const metrics = service.getPhaseMetrics();
    assert.equal(metrics.phases.git_scan?.count, 2);
  } finally {
    await cleanup();
  }
});

test("a marked-dirty workspace forces the next auto refresh to rescan", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });
    await service.sync(undefined, { mode: "auto" });

    await writeFile(join(dir, "added.ts"), "export const added = true;\n");
    service.markWorkspaceDirty("manual");
    const third = await service.sync(undefined, { mode: "auto" });
    assert.equal(third.path, "full");
    assert.equal(third.indexedCount, 1);
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 2);

    const fourth = await service.sync(undefined, { mode: "auto" });
    assert.equal(fourth.path, "fast");
  } finally {
    await cleanup();
  }
});

test("an external generation publication invalidates the fast path", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync(undefined, { mode: "auto" });
    await service.sync(undefined, { mode: "auto" });

    // Another process indexes the changed workspace and publishes a new pointer.
    await writeFile(join(dir, "other.ts"), "export const other = true;\n");
    const external = await new FactsService(dir).sync();
    assert.equal(external.indexedCount, 1);

    const next = await service.sync(undefined, { mode: "auto" });
    assert.equal(next.path, "full", "a moved pointer must force the conservative path");
    // The conservative resync consumes the externally published generation.
    assert.equal(next.cachedCount, 2);
    assert.deepEqual(service.querySymbol("other").map((result) => result.file), ["other.ts"]);
  } finally {
    await cleanup();
  }
});

test("periodic reconciliation forces a full sync after the configured budget", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false, reconcileEvery: 2 });
    await service.sync(undefined, { mode: "auto" });
    assert.equal((await service.sync(undefined, { mode: "auto" })).path, "fast");
    assert.equal((await service.sync(undefined, { mode: "auto" })).path, "fast");
    const fourth = await service.sync(undefined, { mode: "auto" });
    assert.equal(fourth.path, "full", "budget exhausted: reconcile");
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 2);
  } finally {
    await cleanup();
  }
});

test("auto callers join an in-flight refresh for the same epoch", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    const owner = service.sync(undefined, { mode: "auto" });
    await entered.promise;
    const joiner = service.sync(undefined, { mode: "auto" });
    release.resolve();
    const [ownerResult, joinerResult] = await Promise.all([owner, joiner]);
    assert.equal(ownerResult.path, "full");
    assert.equal(joinerResult, ownerResult, "joiner shares the in-flight result");
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 1, "one refresh, not two");
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("a change observed during a flight prevents joining it", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    const owner = service.sync(undefined, { mode: "auto" });
    await entered.promise;
    service.markWorkspaceDirty("mid-flight");
    const latecomer = service.sync(undefined, { mode: "auto" });
    release.resolve();
    const [ownerResult, latecomerResult] = await Promise.all([owner, latecomer]);
    assert.equal(ownerResult.path, "full");
    assert.equal(latecomerResult.path, "full");
    assert.notEqual(latecomerResult, ownerResult);
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 2, "latecomer ran its own refresh");
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("full-mode callers never join a flight", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    const owner = service.sync(undefined, { mode: "auto" });
    await entered.promise;
    const full = service.sync();
    release.resolve();
    const [ownerResult, fullResult] = await Promise.all([owner, full]);
    assert.equal(fullResult.path, "full");
    assert.notEqual(fullResult, ownerResult);
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 2);
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("an aborted joiner does not disturb the shared flight", async (t) => {
  const { dir, cleanup } = await createFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const save = FactsStore.prototype.save;
  let first = true;
  t.mock.method(FactsStore.prototype, "save", async function (database) {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
    return save.call(this, database);
  });
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    const owner = service.sync(undefined, { mode: "auto" });
    await entered.promise;
    const controller = new AbortController();
    const joiner = service.sync(controller.signal, { mode: "auto" });
    controller.abort();
    release.resolve();
    const [ownerResult, joinerResult] = await Promise.all([owner, joiner]);
    assert.equal(ownerResult.path, "full");
    assert.equal(joinerResult, ownerResult);
    assert.equal(service.getPhaseMetrics().phases.git_scan?.count, 1);
  } finally {
    release.resolve();
    await cleanup();
  }
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-fast-path-test-"));
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
