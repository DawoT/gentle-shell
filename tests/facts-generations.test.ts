import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FactsStore } from "../lib/facts/facts-store.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type FileFacts } from "../lib/facts/facts-types.ts";

function file(path: string, sha: string): FileFacts {
  return { path, sha, symbols: [], imports: [], exports: [] };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "facts-generations-"));
  const store = new FactsStore(directory);
  const database: FactsDatabase = {
    version: FACTS_DATABASE_VERSION,
    root: directory,
    updatedAt: 1,
    files: { "a.ts": file("a.ts", "a1"), "b.ts": file("b.ts", "b1") },
  };
  return { directory, store, database, data: join(directory, ".pi", "facts-data") };
}

test("Facts publishes immutable generations and writes only changed file objects", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const pointer = JSON.parse(await readFile(join(directory, ".pi", "facts.json"), "utf8"));
    assert.equal(pointer.format, "facts-pointer-v1");
    const objects = await readdir(join(data, "objects"));
    assert.equal(objects.length, 2);
    const before = await Promise.all(objects.map(async (name) => (await stat(join(data, "objects", name))).mtimeMs));
    const next = { ...database, updatedAt: 2, files: { ...database.files, "a.ts": file("a.ts", "a2") } };
    await store.save(next);
    assert.deepEqual(await store.load(), next);
    assert.deepEqual(await store.loadGeneration(pointer.generation), database);
    assert.equal((await readdir(join(data, "objects"))).length, 3);
    assert.deepEqual(await Promise.all(objects.map(async (name) => (await stat(join(data, "objects", name))).mtimeMs)), before);
    const current = JSON.parse(await readFile(join(directory, ".pi", "facts.json"), "utf8"));
    const manifest = JSON.parse(await readFile(join(data, "generations", `${current.generation}.json`), "utf8"));
    assert.equal(manifest.parent, pointer.generation);
    assert.deepEqual(Object.keys(manifest.upserts), ["a.ts"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts generations reconstruct deletions and reject corrupt immutable objects", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    await store.save({ ...database, updatedAt: 2, files: { "b.ts": database.files["b.ts"] } });
    assert.deepEqual(Object.keys((await store.load())!.files), ["b.ts"]);
    const objects = await readdir(join(data, "objects"));
    for (const name of objects) await writeFile(join(data, "objects", name), "{}");
    assert.equal(await store.load(), null);
    assert.equal(store.getLoadState(), "invalid");
    await assert.rejects(store.loadGeneration("../../outside"), /generation/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts checkpoints preserve old generations and canonical no-op publications", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    let oldest: string | undefined;
    for (let revision = 0; revision < 34; revision++) {
      await store.save({ ...database, updatedAt: revision, files: { "b.ts": file("b.ts", `b${revision}`) } });
      if (revision === 0) oldest = JSON.parse(await readFile(join(directory, ".pi", "facts.json"), "utf8")).generation;
      if (revision === 31) {
        const before = await readFile(join(directory, ".pi", "facts.json"), "utf8");
        await store.save({ files: { "b.ts": file("b.ts", `b${revision}`) }, updatedAt: revision, root: database.root, version: database.version });
        assert.equal(await readFile(join(directory, ".pi", "facts.json"), "utf8"), before);
      }
    }
    assert.equal((await store.load())!.files["b.ts"].sha, "b33");
    assert.equal((await new FactsStore(directory).loadGeneration(oldest!)).files["b.ts"].sha, "b0");
    const current = JSON.parse(await readFile(join(directory, ".pi", "facts.json"), "utf8"));
    const latest = JSON.parse(await readFile(join(data, "generations", `${current.generation}.json`), "utf8"));
    assert.equal(latest.depth, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts migrates a legacy cache only after successful publication", async () => {
  const { directory, store, database } = await fixture();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, ".pi"));
    const path = join(directory, ".pi", "facts.json");
    const legacy = JSON.stringify(database);
    await writeFile(path, legacy);
    assert.deepEqual(await store.load(), database);
    await assert.rejects(store.save(database, AbortSignal.abort()), { name: "AbortError" });
    assert.equal(await readFile(path, "utf8"), legacy);
    await store.save(database);
    assert.equal(JSON.parse(await readFile(path, "utf8")).format, "facts-pointer-v1");
    assert.deepEqual(await store.load(), database);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts bounds metadata chains by checkpointing before their byte budget is exhausted", async () => {
  const { directory, store, database } = await fixture();
  try {
    const metadata = { ...database, root: "x".repeat(34 * 1024 * 1024), files: {} };
    await store.save(metadata);
    await store.save({ ...metadata, updatedAt: 2 });
    assert.equal((await store.load())?.updatedAt, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ["objects", "manifest", "pointer"]) {
  test(`cancelled Facts publication after writing ${phase} preserves the prior generation`, async (t) => {
    const { directory, store, database } = await fixture();
    try {
      await store.save(database);
      const pointer = await readFile(join(directory, ".pi", "facts.json"), "utf8");
      const { open } = await import("node:fs/promises");
      const handle = await open(join(directory, "probe"), "w");
      const prototype = Object.getPrototypeOf(handle);
      const write = prototype.writeFile;
      await handle.close();
      const controller = new AbortController();
      let reached = false;
      t.mock.method(prototype, "writeFile", async function (data: string, options: unknown) {
        const result = await write.call(this, data, options);
        const matches = phase === "objects" ? data.includes('"sha":"new"')
          : phase === "manifest" ? data.includes('"format":"facts-generation-v1"')
          : data.includes('"format":"facts-pointer-v1"');
        if (matches) {
          reached = true;
          controller.abort();
        }
        return result;
      });
      await assert.rejects(store.save({ ...database, updatedAt: 2, files: { "a.ts": file("a.ts", "new") } }, controller.signal), { name: "AbortError" });
      assert.equal(reached, true);
      assert.equal(await readFile(join(directory, ".pi", "facts.json"), "utf8"), pointer);
      assert.deepEqual(await new FactsStore(directory).load(), database);
    } finally {
      t.mock.restoreAll();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("Facts reports a referenced missing manifest as corrupt rather than an absent cache", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const pointer = JSON.parse(await readFile(join(directory, ".pi", "facts.json"), "utf8"));
    await rm(join(data, "generations", `${pointer.generation}.json`));
    assert.equal(await store.load(), null);
    assert.equal(store.getLoadState(), "invalid");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts treats special path keys as ordinary entries across generations", async () => {
  const { directory, store, database } = await fixture();
  try {
    const files = Object.fromEntries(["__proto__", "constructor"].map((path) => [path, file(path, "special")]));
    await store.save({ ...database, files });
    assert.deepEqual(Object.keys((await store.load())!.files).sort(), ["__proto__", "constructor"]);
    await store.save({ ...database, updatedAt: 2, files: {} });
    assert.deepEqual((await store.load())!.files, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unchanged Facts save cannot report success over corrupt objects", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const [name] = await readdir(join(data, "objects"));
    await writeFile(join(data, "objects", name), "{}");
    await assert.rejects(store.save(database), /checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Facts accounts for all abandoned artifact bytes before concurrent publication", async () => {
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const pointer = await readFile(join(directory, ".pi", "facts.json"), "utf8");
    const { open } = await import("node:fs/promises");
    for (let index = 0; index < 3; index++) {
      const handle = await open(join(data, "objects", `orphan-${index}.tmp`), "w");
      try {
        await handle.truncate(100 * 1024 * 1024);
      } finally {
        await handle.close();
      }
    }
    await assert.rejects(store.save({ ...database, updatedAt: 2 }), /retention limit/);
    assert.equal(await readFile(join(directory, ".pi", "facts.json"), "utf8"), pointer);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention removes expired unreachable generations while preserving recent history and current chains", async () => {
  const { utimes } = await import("node:fs/promises");
  const { FactsGenerations } = await import("../lib/facts/facts-generations.ts");
  const { directory, store, database, data } = await fixture();
  try {
    for (let revision = 0; revision < 70; revision++) {
      await store.save({ ...database, updatedAt: revision, files: { "a.ts": file("a.ts", String(revision)) } });
    }
    const current = store.getGeneration()!;
    for (const kind of ["objects", "generations"]) {
      for (const name of await readdir(join(data, kind))) {
        const age = kind === "generations" ? JSON.parse(await readFile(join(data, kind, name), "utf8")).metadata.updatedAt * 1000 : 0;
        await utimes(join(data, kind, name), new Date(age), new Date(age));
      }
    }
    // Age ordering is deterministic; retain the current chain even when its mtime is old.
    const result = await new FactsGenerations(join(directory, ".pi")).collect();
    assert.ok(result.removed > 0);
    assert.equal(store.getGeneration(), current);
    assert.deepEqual((await store.load())?.files, { "a.ts": file("a.ts", "69") });
    // Retained history depends on mtime ordering; the active chain is unconditional.
    const retained = await readdir(join(data, "generations"));
    assert.ok(retained.length < 70);
    for (const name of retained) assert.ok(await store.loadGeneration(name.slice(0, -5)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication reclaims expired abandoned artifacts at the storage watermark", async () => {
  const { open, utimes } = await import("node:fs/promises");
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const orphan = join(data, "objects", `${"f".repeat(64)}.json.00000000-0000-0000-0000-000000000000.tmp`);
    const handle = await open(orphan, "w");
    await handle.truncate(200 * 1024 * 1024);
    await handle.close();
    await utimes(orphan, new Date(0), new Date(0));
    await store.save({ ...database, updatedAt: 2 });
    await assert.rejects(stat(orphan), { code: "ENOENT" });
    assert.equal((await store.load())?.updatedAt, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collection preserves recent or unknown artifacts and does not delete after corrupt marking or pre-abort", async () => {
  const { utimes } = await import("node:fs/promises");
  const { FactsGenerations } = await import("../lib/facts/facts-generations.ts");
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    const collector = new FactsGenerations(join(directory, ".pi"));
    const recent = join(data, "objects", `${"e".repeat(64)}.json`);
    const unknown = join(data, "objects", "user-file.txt");
    await writeFile(recent, "recent");
    await writeFile(unknown, "keep");
    await utimes(unknown, new Date(0), new Date(0));
    assert.equal((await collector.collect()).removed, 0);
    const expired = join(data, "objects", `${"d".repeat(64)}.json`);
    await writeFile(expired, "expired");
    await utimes(expired, new Date(0), new Date(0));
    await assert.rejects(collector.collect(AbortSignal.abort(new Error("stop"))), /stop/);
    assert.equal(await readFile(expired, "utf8"), "expired");
    await writeFile(join(data, "generations", `${store.getGeneration()}.json`), "{}");
    await assert.rejects(collector.collect(), /checksum/);
    assert.equal(await readFile(expired, "utf8"), "expired");
    assert.equal(await readFile(recent, "utf8"), "recent");
    assert.equal(await readFile(unknown, "utf8"), "keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public generation reads wait for a cache writer and nested store operations remain usable", async () => {
  const { directory, store, database } = await fixture();
  try {
    await store.save(database);
    const id = store.getGeneration()!;
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = new FactsStore(directory).withWriterLock(async () => {
      entered();
      await gate;
    });
    await ready;
    let completed = false;
    const reader = store.loadGeneration(id).then((value) => { completed = true; return value; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(completed, false);
    } finally {
      release();
      await writer;
      await reader;
    }
    await store.withWriterLock(async () => {
      assert.ok(await store.load());
      await store.save(database);
      assert.ok(await store.loadGeneration(id));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during collection preserves every retained generation", async (t) => {
  const { utimes } = await import("node:fs/promises");
  const { readdirSync } = await import("node:fs");
  const { FactsGenerations } = await import("../lib/facts/facts-generations.ts");
  const { directory, store, database, data } = await fixture();
  try {
    await store.save(database);
    for (const digit of ["c", "d", "e"]) {
      const path = join(data, "objects", `${digit.repeat(64)}.json`);
      await writeFile(path, "expired orphan");
      await utimes(path, new Date(0), new Date(0));
    }
    const count = readdirSync(join(data, "objects")).length;
    const controller = new AbortController();
    const check = controller.signal.throwIfAborted.bind(controller.signal);
    t.mock.method(controller.signal, "throwIfAborted", () => {
      if (readdirSync(join(data, "objects")).length < count) controller.abort(new Error("mid-sweep"));
      check();
    });
    await assert.rejects(new FactsGenerations(join(directory, ".pi")).collect(controller.signal), /mid-sweep/);
    assert.deepEqual(await store.load(), database);
    assert.deepEqual(await store.loadGeneration(store.getGeneration()!), database);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
