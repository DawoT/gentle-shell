import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commitMatchesWorkingTree, indexFactsCommit } from "./facts-commit.ts";
import { displayLanguage } from "./facts-languages.ts";
import { pageFacts, paginationProperties, symbolRow } from "./facts-response.ts";

export function registerFactsCommit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "facts_commit",
    label: "Facts Commit",
    description: "Index a Git commit without changing the checkout. Read committed symbols and declared commands; results are not current working-tree evidence. Use the returned full commit ID for repeatable pagination.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["revision"],
      properties: {
        revision: { type: "string", minLength: 1, maxLength: 1024, description: "Local Git commit ID, tag or revision to resolve once." },
        name: { type: "string", minLength: 1, maxLength: 1024, description: "Optional exact symbol name (case-insensitive)." },
        offset: paginationProperties.offset,
        limit: paginationProperties.limit,
      },
    },
    execute: async (_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      if (params.name !== undefined && (typeof params.name !== "string" || !params.name || params.name.length > 1024)) {
        throw new Error("Invalid committed symbol name");
      }
      pageFacts([], params, (row: string) => row);
      const result = await indexFactsCommit(ctx.cwd, params.revision, signal);
      const synchronization = await commitMatchesWorkingTree(ctx.cwd, result.commit, signal)
        ? "Committed facts match the current working tree (HEAD, clean)."
        : `Snapshot evidence from commit ${result.commit}; working-tree edits after indexing are not included.`;
      const entries = Object.entries(result.database.files).sort(([a], [b]) => a.localeCompare(b, "en"));
      const rows = params.name
        ? entries.flatMap(([file, facts]) => facts.symbols.filter((symbol) => symbol.name.toLowerCase() === params.name.toLowerCase())
          .map((symbol) => symbolRow(file, symbol)))
        : entries.map(([file, facts]) => `${file}: ${facts.symbols.length} symbols (${displayLanguage(file)})`);
      const page = pageFacts(rows, params, (row) => row);
      const receipts = result.database.receipts;
      const commands = [receipts?.testCommand, receipts?.buildCommand, receipts?.lintCommand].filter(Boolean).join(", ") || "none declared";
      return {
        content: [{ type: "text", text: `Committed Facts — ${result.commit}\nGeneration: ${result.generation}\nCommit timestamp: ${new Date(result.database.updatedAt).toISOString()}\n${synchronization}\nDeclared package commands (${receipts?.commandCwd ?? "."}): ${commands}\nScope: supported sources and JSON metadata; external configuration/dependencies excluded.\nOmitted symlinks/submodules: ${result.omitted.length}\n\n${page.text || "No matching facts."}` }],
        details: {
          status: "committed",
          commit: result.commit,
          generation: result.generation,
          omittedCount: result.omitted.length,
          omitted: result.omitted.slice(0, 50),
          ...page.details,
        },
      };
    },
  });
}
