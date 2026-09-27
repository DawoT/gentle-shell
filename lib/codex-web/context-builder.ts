import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectContextBudget, type ContextBudgetSnapshot } from "./context-budget.ts";
import { ProjectMemory } from "./project-memory.ts";

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

export interface EnrichedCheckpoint {
  version: 1;
  id: string;
  sessionId: string;
  branch?: string;
  workspaceRevision?: string;
  timestamp: string;
  summary: string;
  tokensBefore: number;
  uncertainties?: string[];
  pendingObligations?: string[];
  compactedEntryIds?: string[];
}

export interface BuildContextResult {
  messages: Array<Record<string, unknown>>;
  budget: ContextBudgetSnapshot;
  wasCompacted: boolean;
  checkpoint?: EnrichedCheckpoint;
}

const DEFAULT_TARGET_INPUT_TOKENS = 48_000;

export class ContextBuilder {
  private readonly workspaceRoot: string;
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number;
  private readonly targetInputTokens: number;
  private readonly smartContext: boolean;

  constructor(options: ContextBuilderOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.contextWindow = options.contextWindow;
    this.maxOutputTokens = options.maxOutputTokens;
    this.targetInputTokens = options.targetInputTokens ?? DEFAULT_TARGET_INPUT_TOKENS;
    this.smartContext = options.smartContext ?? (process.env.GENTLE_CODEX_WEB_SMART_CONTEXT !== "0");
  }

  async buildContext(options: BuildContextOptions): Promise<BuildContextResult> {
    const inputCapacity = Math.max(1, this.contextWindow - this.maxOutputTokens);

    // Layer 1: Control (Sacrosanct - Never Truncated)
    const stateMdPath = join(this.workspaceRoot, ".agents", "STATE.md");
    const stateContent = await readFile(stateMdPath, "utf8").catch(() => "");
    let fullSystemPrompt = options.systemPrompt;
    if (stateContent.trim()) {
      fullSystemPrompt += `\n\n[CONTROL OBJECTIVE & CONSTRAINTS]\n${stateContent.trim()}`;
    }

    const controlBytes = Buffer.byteLength(fullSystemPrompt, "utf8");
    const controlTokens = Math.ceil(controlBytes / 4);
    if (controlTokens > inputCapacity) {
      throw new ContextBudgetError(
        `Control layer directives (${controlTokens} tokens) exceed hard model input capacity (${inputCapacity} tokens)`
      );
    }

    const systemMessage: Record<string, unknown> = {
      role: "system",
      content: fullSystemPrompt,
    };

    const initialMessages = [systemMessage, ...options.messages];
    const initialBudget = inspectContextBudget({
      context: { messages: initialMessages as any } as any,
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      targetInputTokens: this.targetInputTokens,
    });

    // If within target or smart context disabled, return initial
    if (!this.smartContext || initialBudget.estimated_input_tokens <= this.targetInputTokens) {
      return {
        messages: initialMessages,
        budget: initialBudget,
        wasCompacted: false,
      };
    }

    // Compaction triggered: Preserve Layer 1 (Control) + Latest Recent Turn
    const messagesToProcess = [...options.messages];
    // Keep at least the last user prompt and its direct context
    let splitIndex = Math.max(0, messagesToProcess.length - 2);
    // Find the latest user message boundary
    for (let i = messagesToProcess.length - 1; i >= 0; i--) {
      if (messagesToProcess[i].role === "user") {
        splitIndex = i;
        break;
      }
    }

    const olderMessages = messagesToProcess.slice(0, splitIndex);
    const recentMessages = messagesToProcess.slice(splitIndex);

    // Generate enriched summary from older messages
    const summaryLines: string[] = [];
    for (const msg of olderMessages) {
      const role = String(msg.role ?? "unknown");
      const content = String(msg.content ?? "");
      const snippet = content.length > 200 ? content.slice(0, 200) + "..." : content;
      summaryLines.push(`[${role}] ${snippet}`);
    }

    const summaryText = summaryLines.slice(0, 10).join("\n") || "Historical dialogue compacted.";
    const memory = await ProjectMemory.open(this.workspaceRoot, options.sessionId);
    const checkpointId = `compact-${Date.now().toString(16)}`;

    const memoryRef = await memory.saveCompaction({
      id: checkpointId,
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: summaryText,
      firstKeptEntryId: String(recentMessages[0]?.id ?? "recent-turn"),
      tokensBefore: initialBudget.estimated_input_tokens,
      reason: "threshold",
      willRetry: false,
      ...(options.factsReceipt ? { factsReceipt: options.factsReceipt } : {}),
    });

    const enrichedCheckpoint: EnrichedCheckpoint = {
      version: 1,
      id: memoryRef.id,
      sessionId: options.sessionId,
      branch: options.branch,
      workspaceRevision: options.workspaceRevision,
      timestamp: new Date().toISOString(),
      summary: summaryText,
      tokensBefore: initialBudget.estimated_input_tokens,
      uncertainties: options.uncertainties,
      pendingObligations: options.pendingObligations,
      compactedEntryIds: olderMessages.map((m, idx) => String(m.id ?? `entry-${idx}`)),
    };

    const compactedHistoryEnvelope: Record<string, unknown> = {
      role: "user",
      content: `[COMPACTED CONTEXT CHECKPOINT: ${memoryRef.id}]\nSummary:\n${summaryText}`,
    };
    const compactionAck: Record<string, unknown> = {
      role: "assistant",
      content: "Understood compacted historical context. Ready for next instruction.",
    };

    const compactedMessages = [
      systemMessage,
      compactedHistoryEnvelope,
      compactionAck,
      ...recentMessages,
    ];

    const finalBudget = inspectContextBudget({
      context: { messages: compactedMessages as any } as any,
      contextWindow: this.contextWindow,
      maxOutputTokens: this.maxOutputTokens,
      targetInputTokens: this.targetInputTokens,
    });

    return {
      messages: compactedMessages,
      budget: finalBudget,
      wasCompacted: true,
      checkpoint: enrichedCheckpoint,
    };
  }
}
