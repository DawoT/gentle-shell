import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactsStore } from "../lib/facts/facts-store.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { FactsPhaseMetrics } from "../lib/facts/facts-phase-metrics.ts";
import { recordFactsHistory } from "../lib/facts/facts-history-extension.ts";

test("FactsPhaseMetrics aggregates counts and durations as plain cloneable data", () => {
  const metrics = new FactsPhaseMetrics();
  metrics.recordRefresh();
  metrics.record("git_scan", 5);
  metrics.record("git_scan", 2);

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.refreshTotal, 1);
  assert.deepEqual(snapshot.phases.git_scan, { count: 2, totalMs: 7, maxMs: 5 });
  assert.equal(snapshot.phases.cache_load, undefined);

  assert.deepEqual(structuredClone(snapshot), snapshot);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("sync records per-phase aggregates without changing sync behavior", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));

    const service = new FactsService(dir);
    const first = await service.sync();
    assert.equal(first.indexedCount, 1);

    const snapshot = service.getPhaseMetrics();
    assert.equal(snapshot.refreshTotal, 1);
    for (const phase of [
      "git_scan",
      "cache_load",
      "source_index",
      "manifest",
      "module_resolution",
      "snapshot_validation",
      "cache_save",
    ] as const) {
      const aggregate = snapshot.phases[phase];
      assert.ok(aggregate, `missing phase metrics for ${phase}`);
      assert.equal(aggregate.count, 1);
      assert.ok(Number.isFinite(aggregate.totalMs) && aggregate.totalMs >= 0, `${phase} totalMs`);
      assert.ok(aggregate.maxMs >= 0 && aggregate.maxMs <= aggregate.totalMs, `${phase} maxMs`);
    }

    const second = await service.sync();
    assert.equal(second.indexedCount, 0);
    assert.equal(second.cachedCount, 1);

    const after = service.getPhaseMetrics();
    assert.equal(after.refreshTotal, 2);
    assert.equal(after.phases.git_scan?.count, 2);
    // An unchanged sync converges without republishing the generation.
    assert.equal(after.phases.cache_save?.count, 1);
  } finally {
    await cleanup();
  }
});

test("overlapping syncs record one queue wait per refresh", async (t) => {
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
    const service = new FactsService(dir);
    const older = service.sync();
    await entered.promise;
    const newer = service.sync();
    release.resolve();
    await Promise.all([older, newer]);

    const snapshot = service.getPhaseMetrics();
    assert.equal(snapshot.refreshTotal, 2);
    assert.equal(snapshot.phases.queue_wait?.count, 2);
    assert.ok((snapshot.phases.queue_wait?.maxMs ?? -1) >= 0);
  } finally {
    release.resolve();
    await cleanup();
  }
});

test("query lookups record query_lookup aggregates", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir);
    await service.sync();
    service.querySymbols({ name: "value" });
    service.queryDependencyEvidence("source.ts");

    const snapshot = service.getPhaseMetrics();
    assert.equal(snapshot.phases.query_lookup?.count, 2);
  } finally {
    await cleanup();
  }
});

test("an injected metrics sink receives service records", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const injected = new FactsPhaseMetrics();
    const service = new FactsService(dir, undefined, { metrics: injected });
    await service.sync();
    service.querySymbols({ name: "value" });

    const snapshot = injected.snapshot();
    assert.equal(snapshot.refreshTotal, 1);
    assert.equal(snapshot.phases.git_scan?.count, 1);
    assert.equal(service.getPhaseMetrics().refreshTotal, 1);
  } finally {
    await cleanup();
  }
});

test("history recording records history_save into the service metrics", async () => {
  const { dir, cleanup } = await createFixture();
  try {
    await writeFile(join(dir, "source.ts"), "export const value = 1;\n");
    const service = new FactsService(dir);
    await service.sync();

    const sessionFile = join(dir, "session.jsonl");
    const pi = { appendEntry() {} };
    const ctx = {
      sessionManager: {
        getBranch: () => [],
        getSessionFile: () => sessionFile,
      },
    };
    const receipt = await recordFactsHistory(pi as never, ctx as never, service);
    assert.ok(receipt);

    const snapshot = service.getPhaseMetrics();
    assert.equal(snapshot.phases.history_save?.count, 1);
    assert.ok((snapshot.phases.history_save?.totalMs ?? -1) >= 0);
  } finally {
    await cleanup();
  }
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "facts-phase-metrics-test-"));
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
