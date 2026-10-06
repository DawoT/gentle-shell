import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FactsHistory, type FactsHistoryReceipt } from "./facts-history.ts";
import { displayLanguage } from "./facts-languages.ts";
import { pageFacts, paginationProperties, symbolRow } from "./facts-response.ts";
import type { FactsService } from "./facts-service.ts";

const ENTRY_TYPE = "gentle-facts-snapshot-v1";

// Content-addressed shortcut: the receipt digest is a pure function of the
// database and resolution edges, and an immutable generation ID identifies
// exactly that content. While the generation is unchanged the receipt can be
// reused without canonicalizing and hashing the whole database again; the
// content-address verification stays on the first write and on every load.
const receiptMemo = new WeakMap<FactsService, { generation: string; receipt: FactsHistoryReceipt }>();

function latestReceipt(ctx: ExtensionContext): FactsHistoryReceipt | undefined {
  const branch = ctx.sessionManager?.getBranch() ?? [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === "custom" && entry.customType === ENTRY_TYPE) return entry.data as FactsHistoryReceipt;
  }
  return undefined;
}

export async function recordFactsHistory(pi: ExtensionAPI, ctx: ExtensionContext, service: FactsService, signal?: AbortSignal): Promise<FactsHistoryReceipt | undefined> {
  const sessionFile = ctx.sessionManager?.getSessionFile();
  const database = service.getDatabase();
  if (!sessionFile || !database) return undefined;
  const generation = service.getGeneration();
  const memo = generation ? receiptMemo.get(service) : undefined;
  if (memo && memo.generation === generation) {
    if (latestReceipt(ctx)?.digest !== memo.receipt.digest) pi.appendEntry(ENTRY_TYPE, memo.receipt);
    return memo.receipt;
  }
  const started = performance.now();
  try {
    const receipt = await new FactsHistory(sessionFile).save(database, service.getResolutionEdges(), signal);
    if (latestReceipt(ctx)?.digest !== receipt.digest) pi.appendEntry(ENTRY_TYPE, receipt);
    if (generation) receiptMemo.set(service, { generation, receipt });
    return receipt;
  } finally {
    service.recordPhaseMetric("history_save", performance.now() - started);
  }
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
        ? entries.flatMap(([file, facts]) => facts.symbols.filter((symbol) => symbol.name.toLowerCase() === params.name.toLowerCase()).map((symbol) => symbolRow(file, symbol)))
        : entries.map(([file, facts]) => `${file}: ${facts.symbols.length} symbols (${displayLanguage(file)})`);
      const page = pageFacts(rows, params, (row) => row);
      return {
        content: [{ type: "text", text: `Historical Facts — observed ${new Date(receipt.observedAt).toISOString()}\nRoot: ${receipt.root}\nSnapshot: ${receipt.digest}\nSnapshot evidence as of ${new Date(receipt.observedAt).toISOString()}; not live working-tree truth.\n\n${page.text || "No matching facts."}` }],
        details: { status: "historical", digest: receipt.digest, observedAt: receipt.observedAt, ...page.details },
      };
    },
  });
}
