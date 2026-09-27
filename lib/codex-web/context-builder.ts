import { inspectContextBudget, type ContextBudgetSnapshot } from "./context-budget.ts";

export class ContextBudgetError extends Error {
  readonly code = "context_budget_exceeded" as const;

  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export interface ContextBuilderOptions {
  workspaceRoot: string;
  contextWindow: number;
  maxOutputTokens: number;
  targetInputTokens?: number;
  /** Request native compaction when above target; never permits lossy truncation. */
  smartContext?: boolean;
}

export interface BuildContextOptions {
  systemPrompt: string;
  sessionId: string;
  messages: Array<Record<string, unknown>>;
  factsReceipt?: { digest: string; root: string; observedAt: number };
  branch?: string;
  workspaceRevision?: string;
  uncertainties?: string[];
  pendingObligations?: string[];
}

export interface BuildContextResult {
  messages: Array<Record<string, unknown>>;
  budget: ContextBudgetSnapshot;
  wasCompacted: false;
  compactionRequired: boolean;
}

/**
 * Plans context without inventing a summary or changing transcript authority.
 * Pi owns semantic compaction and its durable transcript entry. This planner
 * requests it; a byte estimate cannot certify a summary's completeness.
 */
export class ContextBuilder {
  private readonly options: ContextBuilderOptions;

  constructor(options: ContextBuilderOptions) {
    this.options = { ...options };
  }

  async buildContext(options: BuildContextOptions): Promise<BuildContextResult> {
    const messages = [
      { role: "system", content: options.systemPrompt },
      ...structuredClone(options.messages),
    ];
    const budget = inspectContextBudget({
      context: { messages } as Parameters<typeof inspectContextBudget>[0]["context"],
      contextWindow: this.options.contextWindow,
      maxOutputTokens: this.options.maxOutputTokens,
      targetInputTokens: this.options.targetInputTokens,
    });
    if (budget.status === "overflow") {
      throw new ContextBudgetError(
        "Estimated transcript size exceeds input capacity; complete native compaction before admission",
      );
    }
    return {
      messages,
      budget,
      wasCompacted: false,
      compactionRequired: budget.status === "above_target" && this.options.smartContext !== false,
    };
  }
}
