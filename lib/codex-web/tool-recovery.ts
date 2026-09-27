import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ToolReceipts, type ToolClaim } from "./tool-receipts.ts";
import { createHash } from "node:crypto";

export function installToolRecovery(pi: ExtensionAPI) {
  const journals = new Map<string, ToolReceipts>();
  const active = new Map<string, { journal: ToolReceipts; claim: ToolClaim }>();

  function activeKey(scope: string, callId: string): string {
    return `${scope}:${callId}`;
  }

  function journal(ctx: ExtensionContext): ToolReceipts {
    const next = new ToolReceipts(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager.getSessionFile());
    const existing = journals.get(next.scope);
    if (existing) return existing;
    if (journals.size >= 16) throw new Error("Bridge recovery session capacity reached; execution blocked");
    journals.set(next.scope, next);
    return next;
  }

  pi.on("tool_call", async (event, ctx) => {
    if (ctx.model?.provider !== "gentle-codex-web") return;
    try {
      const receipts = journal(ctx);
      const key = activeKey(receipts.scope, event.toolCallId);
      if (active.has(key)) throw new Error("Tool call is already active; do not replay it");
      const claim = await receipts.admit(event.toolCallId, event.toolName, event.input);
      active.set(key, { journal: receipts, claim });
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Recovery admission failed; tool execution blocked" };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const scope = new ToolReceipts(ctx.sessionManager.getSessionId(), ctx.cwd, ctx.sessionManager.getSessionFile()).scope;
    const key = activeKey(scope, event.toolCallId);
    const admitted = active.get(key);
    if (!admitted) return;
    active.delete(key);
    try {
      await admitted.journal.settle(admitted.claim, event.content, event.isError);
    } catch {
      const warning = "Tool execution already returned, but its recovery receipt could not be persisted. Verify effects before starting another call; do not replay this call.";
      if (ctx.hasUI) ctx.ui.notify(warning, "error");
      return { isError: true, content: [...event.content, { type: "text" as const, text: warning }] };
    }
  });

  return async (ctx: ExtensionContext): Promise<string> => {
    const receipts = journal(ctx);
    const result = await receipts.list();
    return [
      `Tool recovery: ${receipts.directory ? "persistent" : "memory only"}`,
      ...result.receipts.map(receipt => {
        const reference = createHash("sha256").update(receipt.claim.callId).digest("hex").slice(0, 12);
        return `${reference}: ${receipt.claim.tool} · ${receipt.state}${receipt.isError ? " (error observed)" : ""}`;
      }),
      ...(result.truncated ? ["Receipt listing truncated (10 receipts / 64 directory entries)."] : []),
      ...(result.interruptedAdmission ? ["Admission lock present: active or interrupted writer; no automatic removal."] : []),
      "Result observed is not proof of external effects or transcript completion. No automatic replay or unlock.",
    ].join("\n");
  };
}
