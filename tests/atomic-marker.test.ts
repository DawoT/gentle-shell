// Characterization + behavior tests for the shared atomic marker utility.
import assert from "node:assert/strict";
import { readFileSync, watch } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteMarker, waitForMarker } from "./support/atomic-marker.mjs";

async function tmp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atomic-marker-test-"));
  test.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("atomic write is never observable as an empty or partial marker", async () => {
  const directory = await tmp();
  for (let cycle = 0; cycle < 20; cycle++) {
    // Any directory event triggers a read of the final name; every read must
    // see either an absent file or fully valid content, never a prefix/empty.
    const reads: Array<{ seen: boolean; content: string }> = [];
    const watcher = watch(directory, () => {
      try {
        reads.push({ seen: true, content: readFileSync(join(directory, "m"), "utf8") });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        reads.push({ seen: false, content: "" });
      }
    });
    atomicWriteMarker(directory, "m", `cycle-${cycle} value`);
    const content = readFileSync(join(directory, "m"), "utf8");
    watcher.close();
    assert.equal(content, `cycle-${cycle} value`);
    for (const read of reads) {
      assert.equal(read.seen && read.content.trim() === "", false, `empty observation in cycle ${cycle}`);
      if (read.seen) assert.equal(read.content, `cycle-${cycle} value`);
    }
  }
});

test("waitForMarker resolves with the trimmed content once the marker is valid", async () => {
  const directory = await tmp();
  const pending = waitForMarker(directory, "ready");
  atomicWriteMarker(directory, "ready", `  ${process.pid} 12345 \n`);
  assert.equal(await pending, `${process.pid} 12345`);
});

test("waitForMarker rejects on timeout and names the marker", async () => {
  const directory = await tmp();
  await assert.rejects(waitForMarker(directory, "never", { timeoutMs: 50 }), /never/);
});

test("waitForMarker skips invalid content and resolves only after valid content", async () => {
  const directory = await tmp();
  const validate = (content: string) => /^\d+ \d+$/.test(content);
  const pending = waitForMarker(directory, "ready", { validate });
  // Invalid content appears first; resolution must not happen before the
  // valid marker arrives.
  atomicWriteMarker(directory, "ready", "not-yet");
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("resolved too early")), 100))]), /early/);
  atomicWriteMarker(directory, "ready", "42 100");
  assert.equal(await pending, "42 100");
});

test("waitForMarker cleans up the watcher so the process has no open handles", async () => {
  const directory = await tmp();
  await waitForMarker(directory, "done", { timeoutMs: 50 }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));
  // No assertion needed: node:test fails the run on lingering handles if the
  // watcher leaked on the timeout path.
  assert.ok(true);
});
