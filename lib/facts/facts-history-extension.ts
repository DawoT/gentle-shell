import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FactsHistory, type FactsHistoryReceipt } from "./facts-history.ts";
import { pageFacts, paginationProperties } from "./facts-response.ts";
import type { FactsService } from "./facts-service.ts";

const ENTRY_TYPE = "gentle-facts-snapshot-v1";

function latestReceipt(ctx: ExtensionContext): FactsHistoryReceipt | undefined {
  const branch = ctx.sessionManager?.getBranch() ?? [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return entry.data as FactsHistoryReceipt;
  }
  return undefined;
}

export async function recordFactsHistory(pi: ExtensionAPI, ctx: ExtensionContext, service: FactsService, signal?: AbortSignal): Promise<void> {
  const sessionFile = ctx.sessionManager?.getSessionFile();
  const database = service.getDatabase();
  if (!sessionFile || !database) return;
  const receipt = await new FactsHistory(sessionFile).save(database, service.getResolutionEdges(), signal);
  if (latestReceipt(ctx)?.digest !== receipt.digest) pi.appendEntry(ENTRY_TYPE, receipt);
}

export function registerFactsHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "facts_history",
    label: "Facts History",
    description: "Read the last verified Facts snapshot on the current transcript branch without Git or source reads. Historical evidence only; not current working-tree truth.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", maxLength: 1024, description: "Optional exact symbol name to inspect in the historical snapshot." },
        offset: paginationProperties.offset,
        limit: paginationProperties.limit,
      },
    },
    execute: async (_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      const receipt = latestReceipt(ctx);
      const sessionFile = ctx.sessionManager?.getSessionFile();
      if (!receipt || !sessionFile) {
        return { content: [{ type: "text", text: "No Facts snapshot is attached to this transcript branch." }], details: { status: "unavailable" } };
      }
      const snapshot = await new FactsHistory(sessionFile).load(receipt, receipt.root, signal);
      const entries = Object.entries(snapshot.database.files).sort(([a], [b]) => a.localeCompare(b, "en"));
      const rows = params.name
        ? entries.flatMap(([file, facts]) => facts.symbols.filter((symbol) => symbol.name.toLowerCase() === params.name.toLowerCase()).map((symbol) => `${file}:${symbol.startLine}\n${symbol.signature}`))
        : entries.map(([file, facts]) => `${file}: ${facts.symbols.length} symbols (${facts.language ?? "typescript"})`);
      const page = pageFacts(rows, params, (row) => row);
      return {
        content: [{ type: "text", text: `Historical Facts — observed ${new Date(receipt.observedAt).toISOString()}\nRoot: ${receipt.root}\nSnapshot: ${receipt.digest}\nNot synchronized with the current working tree.\n\n${page.text || "No matching facts."}` }],
        details: { status: "historical", digest: receipt.digest, observedAt: receipt.observedAt, ...page.details },
      };
    },
  });
}
