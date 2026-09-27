import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FactsHistory } from "../lib/facts/facts-history.ts";

test("history restores a verified snapshot without a working tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-history-"));
  try {
    const sessionFile = join(dir, "session.jsonl");
    await writeFile(sessionFile, "");
    const history = new FactsHistory(sessionFile);
    const db = { version: "1.2.0", root: "/deleted/project", updatedAt: 42, files: {} };
    const receipt = await history.save(db, []);
    assert.equal(receipt.root, db.root);
    assert.equal(receipt.observedAt, 42);
    const restored = await new FactsHistory(sessionFile).load(receipt, db.root);
    assert.deepEqual(restored.database, db);
    assert.deepEqual(restored.edges, []);
    await assert.rejects(history.load(receipt, "/different/project"), /root/);
    await assert.rejects(history.load({ ...receipt, digest: "../../outside" }, db.root), /receipt/);
    const path = join(dir, "facts-snapshots", receipt.digest + ".json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.database.updatedAt = 99;
    await writeFile(path, JSON.stringify(saved));
    await assert.rejects(history.load(receipt, db.root), /digest/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent identical history publications remain readable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-history-race-"));
  try {
    const path = join(dir, "session.jsonl");
    const database = { version: "1.2.0", root: dir, updatedAt: 1, files: {} };
    const receipts = await Promise.all(Array.from({ length: 8 }, () => new FactsHistory(path).save(database, [])));
    assert.equal(new Set(receipts.map((receipt) => receipt.digest)).size, 1);
    for (const receipt of receipts) assert.deepEqual((await new FactsHistory(path).load(receipt, dir)).database, database);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
