import { analyzeFactsTrees } from "./facts/facts-impact.ts";
import { CandidateViewError, injectReviewCandidateView, type CandidateView, type CandidateViewRegistry } from "./review-candidate-view.ts";

type Evidence = Awaited<ReturnType<typeof analyzeFactsTrees>>;

function summary(evidence: Evidence): string {
  const { impact } = evidence;
  const lines = [
    "Facts impact (advisory, potential file dependents only): this does not expand review scope or authorize reading ambient files. Zero resolved consumers does not prove zero impact; this is not a function call graph or approval.",
    `Base tree: ${evidence.baseTree}; candidate tree: ${evidence.candidateTree}.`,
    `Changed sources: ${impact.changedSources.length}; resolution-change seeds: ${impact.resolutionChangedImporters.length}; consumer observations: ${impact.consumers.length}.`,
    `Unresolved imports (base/candidate): ${impact.coverage.base.unresolvedImports}/${impact.coverage.candidate.unresolvedImports}; omitted symlinks/submodules: ${evidence.omitted.base.length}/${evidence.omitted.candidate.length}. Dynamic/external dependencies remain outside coverage.`,
  ];
  let shown = 0;
  for (const entry of impact.consumers) {
    const line = `Potential consumer [${entry.side}, depth ${entry.depth}]: ${JSON.stringify(entry.file)} via ${JSON.stringify(entry.via)}.`;
    if (shown >= 5 || Buffer.byteLength([...lines, line].join("\n")) > 1100) break;
    lines.push(line);
    shown++;
  }
  if (shown < impact.consumers.length) lines.push(`Consumer list truncated: ${shown}/${impact.consumers.length} observations shown.`);
  return lines.join("\n");
}

function identity(view: CandidateView): string {
  return JSON.stringify([view.token, view.root, view.contributorRoot, view.baseTree, view.candidateTree, view.paths, view.modes, view.gitlinks, view.deletedPaths]);
}

/** Controller-only adapter. Analyzer options are host dependencies, never tool input. */
export async function injectReviewFactsImpact(
  input: unknown,
  registry: CandidateViewRegistry | null,
  options: { analyze?: typeof analyzeFactsTrees; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const mutable = input as Record<string, unknown>;
  const inputIdentity = JSON.stringify(mutable);
  const original = { ...mutable };
  const prepared = { ...original };
  const view = injectReviewCandidateView(prepared, registry);
  if (!view) return false;
  options.signal?.throwIfAborted();
  const lineage = registry!.currentLineageId();
  const binding = identity(view);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Facts review analysis deadline exceeded")), 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  let advisory = "Facts impact unavailable: analysis failed or exceeded its limits. No impact conclusion is implied; review authorization and scope are unchanged.";
  try {
    const evidence = await (options.analyze ?? analyzeFactsTrees)(view.contributorRoot, view.baseTree, view.candidateTree, { signal });
    signal.throwIfAborted();
    if (evidence.baseTree !== view.baseTree || evidence.candidateTree !== view.candidateTree) throw new Error("Facts review tree identity mismatch");
    advisory = summary(evidence);
  } catch {
    options.signal?.throwIfAborted();
  } finally {
    clearTimeout(timer);
  }
  options.signal?.throwIfAborted();
  if (JSON.stringify(mutable) !== inputIdentity) throw new CandidateViewError("review dispatch input changed during Facts analysis");
  const final = { ...original };
  const verified = injectReviewCandidateView(final, registry, advisory);
  if (!verified || registry!.currentLineageId() !== lineage || identity(verified) !== binding) {
    throw new CandidateViewError("review candidate binding changed during Facts analysis");
  }
  mutable.task = final.task;
  return true;
}
