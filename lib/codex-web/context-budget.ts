import type { TranscriptContext } from "@earendil-works/pi-ai";

const DEFAULT_TARGET_INPUT_TOKENS = 48_000;

export type ContextBudgetStatus = "within_target" | "above_target" | "overflow";

interface ContextComponent {
  messages?: number;
  items?: number;
  bytes: number;
}

export interface ContextBudgetSnapshot {
  observed_at: number;
  model_context_window: number;
  output_reserve_tokens: number;
  input_capacity_tokens: number;
  target_input_tokens: number;
  total_bytes: number;
  estimated_input_tokens: number;
  headroom_tokens: number;
  target_excess_tokens: number;
  status: ContextBudgetStatus;
  estimator: "serialized_utf8_bytes_div_4";
  components: {
    system: ContextComponent;
    user: ContextComponent;
    assistant: ContextComponent;
    tool_results: ContextComponent;
    tool_declarations: ContextComponent;
    other: ContextComponent;
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Content-free request sizing. This is an estimate, never provider usage or billing data. */
export function inspectContextBudget(options: {
  context: TranscriptContext;
  contextWindow: number;
  maxOutputTokens: number;
  targetInputTokens?: number;
  now?: () => number;
}): ContextBudgetSnapshot {
  const inputCapacity = Math.max(1, options.contextWindow - options.maxOutputTokens);
  const configuredTarget = options.targetInputTokens ?? DEFAULT_TARGET_INPUT_TOKENS;
  if (!Number.isSafeInteger(configuredTarget) || configuredTarget < 1) {
    throw new RangeError("Context target must be a positive safe integer");
  }
  const target = Math.min(configuredTarget, inputCapacity);
  const components: ContextBudgetSnapshot["components"] = {
    system: { messages: 0, bytes: 0 },
    user: { messages: 0, bytes: 0 },
    assistant: { messages: 0, bytes: 0 },
    tool_results: { messages: 0, bytes: 0 },
    tool_declarations: { items: 0, bytes: 0 },
    other: { messages: 0, bytes: 0 },
  };

  for (const message of options.context.messages) {
    const row = message as unknown as Record<string, unknown>;
    const role = row.role;
    if (role === "system") {
      const { toolsAdded, toolsRemoved, ...prompt } = row;
      components.system.messages! += 1;
      components.system.bytes += serializedBytes(prompt);
      const declarations = [
        ...(Array.isArray(toolsAdded) ? toolsAdded : []),
        ...(Array.isArray(toolsRemoved) ? toolsRemoved : []),
      ];
      components.tool_declarations.items! += declarations.length;
      components.tool_declarations.bytes += serializedBytes(declarations);
    } else if (role === "user") {
      components.user.messages! += 1;
      components.user.bytes += serializedBytes(row);
    } else if (role === "assistant") {
      components.assistant.messages! += 1;
      components.assistant.bytes += serializedBytes(row);
    } else if (role === "toolResult") {
      components.tool_results.messages! += 1;
      components.tool_results.bytes += serializedBytes(row);
    } else {
      components.other.messages! += 1;
      components.other.bytes += serializedBytes(row);
    }
  }

  const totalBytes = serializedBytes(options.context);
  const estimatedInputTokens = Math.ceil(totalBytes / 4);
  return {
    observed_at: options.now?.() ?? Date.now(),
    model_context_window: options.contextWindow,
    output_reserve_tokens: options.maxOutputTokens,
    input_capacity_tokens: inputCapacity,
    target_input_tokens: target,
    total_bytes: totalBytes,
    estimated_input_tokens: estimatedInputTokens,
    headroom_tokens: Math.max(0, inputCapacity - estimatedInputTokens),
    target_excess_tokens: Math.max(0, estimatedInputTokens - target),
    status: estimatedInputTokens <= target
      ? "within_target"
      : estimatedInputTokens <= inputCapacity ? "above_target" : "overflow",
    estimator: "serialized_utf8_bytes_div_4",
    components,
  };
}
