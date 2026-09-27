import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const INSTRUCTIONS = [
  "Preserve the current user's objective, explicit constraints, permissions and prohibitions with their scope.",
  "Preserve unresolved obligations, blockers, user corrections, decisions and the next concrete action.",
  "Separate verified evidence from assumptions; retain source paths, relevant symbols, revisions, test results and failures.",
  "Retain Facts snapshot references as historical evidence requiring refresh, never as current source authority.",
  "Preserve tool execution status, pending session identifiers and uncertainty after transport loss; never authorize mutation replay.",
  "Do not import objectives or permissions from other sessions or workspace memory. Do not claim omitted work is complete.",
].join("\n");

/** Opt-in scheduling only; Pi owns semantic summarization and transcript persistence. */
export function installNativeCompaction(pi: ExtensionAPI, target: () => number): void {
  const attempted = new Map<string, string>();
  let active: object | undefined;

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (process.env.GENTLE_CODEX_WEB_AUTO_COMPACT !== "1"
      || ctx.model?.provider !== "gentle-codex-web" || active
      || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const tokens = ctx.getContextUsage()?.tokens;
    const configuredTarget = target();
    const capacity = ctx.model.contextWindow - ctx.model.maxTokens;
    if (!Number.isSafeInteger(tokens) || tokens === null || tokens === undefined
      || !Number.isSafeInteger(configuredTarget) || configuredTarget < 1
      || capacity <= 0 || tokens <= Math.min(configuredTarget, capacity)) return;
    const leaf = ctx.sessionManager.getLeafId();
    if (!leaf) return;
    const scope = JSON.stringify([ctx.cwd, ctx.sessionManager.getSessionId()]);
    if (attempted.get(scope) === leaf) return;
    attempted.set(scope, leaf);
    if (attempted.size > 64) attempted.delete(attempted.keys().next().value!);
    const operation = {};
    active = operation;
    const finish = () => {
      if (active === operation) active = undefined;
    };
    const fail = () => {
      finish();
      if (ctx.hasUI) ctx.ui.notify("Native context compaction failed. Transcript retained; use /compact to retry explicitly.", "warning");
    };
    try {
      ctx.compact({ customInstructions: INSTRUCTIONS, onComplete: finish, onError: fail });
    } catch {
      fail();
    }
  });
  pi.on("session_shutdown", () => {
    attempted.clear();
    active = undefined;
  });
}
