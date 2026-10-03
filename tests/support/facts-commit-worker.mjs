// Cross-process characterization worker for commit-cache writer locking.
// Protocol (node IPC, no filesystem markers):
// - worker sends { status: "ready" } once message handling is registered;
// - parent sends { cwd, revision, hold? } to start indexFactsCommit;
// - with hold, the worker pauses inside the lock just before the cache save
//   (status "publishing") and waits for a { release: true } message;
// - parent may send { abort: true } to cancel the in-flight call;
// - terminal statuses: { status: "done", commit, generation } or
//   { status: "error", name, message }.
import { FactsStore } from "../../lib/facts/facts-store.ts";
import { indexFactsCommit } from "../../lib/facts/facts-commit.ts";

const originalSave = FactsStore.prototype.save;
let controller;

async function run({ cwd, revision, hold }) {
  controller = new AbortController();
  if (hold) {
    FactsStore.prototype.save = async function (database, signal) {
      process.send({ status: "publishing" });
      await new Promise((resolve) => {
        const onMessage = ({ release }) => {
          if (!release) return;
          process.removeListener("message", onMessage);
          resolve();
        };
        process.on("message", onMessage);
      });
      return originalSave.call(this, database, signal);
    };
  }
  try {
    const result = await indexFactsCommit(cwd, revision, controller.signal);
    process.send({ status: "done", commit: result.commit, generation: result.generation });
  } catch (error) {
    process.send({ status: "error", name: error.name, message: error.message });
    process.exitCode = 1;
  } finally {
    FactsStore.prototype.save = originalSave;
    process.disconnect();
  }
}

process.on("message", (message) => {
  if (message.abort) {
    controller?.abort();
    return;
  }
  if (message.cwd !== undefined) void run(message);
});
process.send({ status: "ready" });
