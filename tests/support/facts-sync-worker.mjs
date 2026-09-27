import { FactsService } from "../../lib/facts/facts-service.ts";
import { FactsStore } from "../../lib/facts/facts-store.ts";

process.once("message", async ({ cwd, hold }) => {
  if (hold) {
    const save = FactsStore.prototype.save;
    FactsStore.prototype.save = async function (database) {
      process.send({ status: "publishing" });
      await new Promise((resolve) => process.once("message", resolve));
      return save.call(this, database);
    };
  }
  try {
    await new FactsService(cwd).sync();
    process.send({ status: "done" });
  } catch (error) {
    process.send({ status: "error", message: error.message });
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
});
process.send({ status: "ready" });
