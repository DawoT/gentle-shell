import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { indexFactsCommit } from "./facts-commit.ts";
import { analyzeFactsImpact } from "./facts-impact.ts";
import { pageFacts, paginationProperties } from "./facts-response.ts";

export function registerFactsImpact(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "facts_impact",
    label: "Facts Impact",
    description: "Compare two committed versions and list potential file consumers from both literal-import graphs. Not a function call graph, runtime risk verdict, or analysis of uncommitted edits. Repeat full commit IDs for pagination.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["base", "candidate"],
      properties: {
        base: { type: "string", minLength: 1, maxLength: 1024, description: "Base local Git revision." },
        candidate: { type: "string", minLength: 1, maxLength: 1024, description: "Candidate local Git revision." },
        transitive: { type: "boolean", description: "Include indirect consumers (default true)." },
        offset: paginationProperties.offset,
        limit: paginationProperties.limit,
      },
    },
    execute: async (_id: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      pageFacts([], params, (row: string) => row);
      for (const revision of [params.base, params.candidate]) {
        if (typeof revision !== "string" || !revision || revision.length > 1024 || /[\x00-\x1f]/.test(revision)) {
          throw new Error("Facts impact requires valid base and candidate revisions");
        }
      }
      if (params.transitive !== undefined && typeof params.transitive !== "boolean") throw new Error("Invalid Facts impact transitive option");
      const base = await indexFactsCommit(ctx.cwd, params.base, signal);
      const candidate = await indexFactsCommit(ctx.cwd, params.candidate, signal);
      signal?.throwIfAborted();
      const impact = analyzeFactsImpact(base.database, candidate.database, { transitive: params.transitive });
      const rows = [
        ...impact.changedSources.map((entry) => `Source ${entry.change}: ${JSON.stringify(entry.file)}`),
        ...impact.resolutionChangedImporters.map((file) => `Import resolution changed: ${JSON.stringify(file)}`),
        ...impact.consumers.map((entry) => `Potential consumer [${entry.side}]: ${JSON.stringify(entry.file)}; depth ${entry.depth}; via ${JSON.stringify(entry.via)}; origin ${JSON.stringify(entry.origin)}`),
      ];
      const page = pageFacts(rows, params, (row) => row);
      return {
        content: [{ type: "text", text: [
          `Facts impact: ${base.commit} -> ${candidate.commit}`,
          "Potential file dependents only. Depth is the shortest path from a changed source or changed-resolution importer; seeds are listed separately.",
          "Not function-level impact, runtime risk, or review approval. Zero resolved consumers does not prove zero impact.",
          `Coverage (base/candidate): ${impact.coverage.base.resolvedImports}/${impact.coverage.candidate.resolvedImports} resolved imports; ${impact.coverage.base.unresolvedImports}/${impact.coverage.candidate.unresolvedImports} unresolved.`,
          `Omitted symlinks/submodules: ${base.omitted.length}/${candidate.omitted.length}. Non-source assets and runtime/dynamic dependencies are outside this analysis.`,
          "Current checkout edits are excluded. Use the returned full commit IDs for subsequent pages.",
          page.text || (rows.length ? "No rows at this offset; the comparison contains changes. Restart with offset=0." : "No indexed source or import-resolution changes detected."),
        ].join("\n\n") }],
        details: {
          status: "committed-comparison",
          assessment: impact.assessment,
          baseCommit: base.commit,
          candidateCommit: candidate.commit,
          baseGeneration: base.generation,
          candidateGeneration: candidate.generation,
          changedSourceCount: impact.changedSources.length,
          resolutionChangedImporterCount: impact.resolutionChangedImporters.length,
          consumerCount: impact.consumers.length,
          uniqueConsumerCount: new Set(impact.consumers.map((entry) => entry.file)).size,
          coverage: impact.coverage,
          omitted: { base: base.omitted.length, candidate: candidate.omitted.length },
          transitive: impact.transitive,
          ...page.details,
        },
      };
    },
  });
}
