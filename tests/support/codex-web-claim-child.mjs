import { writeFile } from "node:fs/promises";
import { ToolReceipts } from "../../lib/codex-web/tool-receipts.ts";

const [cwd, callId, effectFile] = process.argv.slice(2);
const receipts = new ToolReceipts("shared-session", cwd, `${cwd}/session.jsonl`);
try {
  await receipts.admit(callId, "bash", { command: "effect" });
  if (effectFile) await writeFile(effectFile, "executed\n", { flag: "wx" });
  process.send?.({ state: "admitted" });
  setInterval(() => {}, 1000);
} catch (error) {
  process.send?.({ state: "blocked", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
