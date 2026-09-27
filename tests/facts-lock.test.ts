import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FactsStore } from "../lib/facts/facts-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "facts-lock-"));
  const store = new FactsStore(directory);
  const lock = join(directory, ".pi", "facts.lock");
  let record: any;
  await store.withWriterLock(async () => {
    const [name] = await readdir(lock);
    record = JSON.parse(await readFile(join(lock, name), "utf8"));
  });
  return { directory, store, lock, record };
}

for (const scenario of ["live", "unknown-boot", "unknown-host", "unknown-namespace", "invalid-pid", "legacy", "partial", "empty", "extra", "symlink"]) {
  test(`Facts lock preserves ${scenario} ownership and supports cancelling the wait`, async () => {
    const { directory, store, lock, record } = await fixture();
    try {
      await mkdir(lock);
      const name = `owner-${randomUUID()}.json`;
      const ownerPath = join(lock, scenario === "legacy" ? "owner.json" : name);
      if (scenario.startsWith("unknown-")) {
        const field = scenario.slice("unknown-".length);
        record.context = { ...record.context, [field]: "unknown" };
        record.pid = 2147483647;
      }
      if (scenario === "extra" || scenario === "symlink") record.pid = 2147483647;
      if (scenario === "invalid-pid") record.pid = -1;
      if (scenario === "extra") await writeFile(join(lock, "unknown"), "preserve");
      if (scenario === "symlink") {
        const target = join(directory, "target");
        await writeFile(target, JSON.stringify(record));
        await symlink(target, ownerPath);
      } else if (scenario !== "empty") {
        await writeFile(ownerPath, scenario === "partial" ? "{" : JSON.stringify(record));
      }
      const before = await readdir(lock);
      let entered = false;
      await assert.rejects(store.withWriterLock(async () => {
        entered = true;
      }, AbortSignal.timeout(100)), { name: "AbortError" });
      assert.equal(entered, false);
      assert.deepEqual(await readdir(lock), before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Facts writer cleanup does not remove a replacement owner's lock", async () => {
  const { directory, store, lock, record } = await fixture();
  try {
    const replacement = `owner-${randomUUID()}.json`;
    await store.withWriterLock(async () => {
      await rm(lock, { recursive: true });
      await mkdir(lock);
      await writeFile(join(lock, replacement), JSON.stringify(record));
    });
    assert.deepEqual(await readdir(lock), [replacement]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
