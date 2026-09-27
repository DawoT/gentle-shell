import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFactsFile } from "../lib/facts/facts-limits.ts";

test("bounded reads reject FIFOs instead of waiting indefinitely for source bytes", {
  skip: process.platform === "win32" ? "POSIX FIFO fixture" : false,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "facts-fifo-"));
  let writer;
  try {
    const path = join(dir, "source.ts");
    execFileSync("mkfifo", [path]);
    writer = await open(path, constants.O_RDWR | constants.O_NONBLOCK);
    const pending = readFactsFile(path, 1024);
    const timer = setTimeout(() => void writer.close(), 100);
    try {
      await assert.rejects(pending, /regular file/);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await writer?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded reads do not allocate large chunks for tiny regular files", async (t) => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "facts-small-read-"));
  try {
    const path = join(directory, "small.json");
    await writeFile(path, "small");
    const allocate = Buffer.alloc;
    let allocated = 0;
    t.mock.method(Buffer, "alloc", (size: number, ...args: any[]) => {
      allocated += size;
      return allocate(size, ...args);
    });
    assert.equal((await readFactsFile(path, 64 * 1024 * 1024)).toString(), "small");
    assert.ok(allocated <= 8192, `tiny artifact allocated ${allocated} bytes in read buffers`);
  } finally {
    t.mock.restoreAll();
    await rm(directory, { recursive: true, force: true });
  }
});
