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
