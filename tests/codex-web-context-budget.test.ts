import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { inspectContextBudget } from "../lib/codex-web/context-budget.ts";

test("context budget distinguishes the quality target from the hard model capacity", () => {
  const context = normalizeContext({
    messages: [{ role: "user", content: "x".repeat(800), timestamp: 1 }],
  });
  const above = inspectContextBudget({
    context,
    contextWindow: 400,
    maxOutputTokens: 100,
    targetInputTokens: 100,
    now: () => 7,
  });
  assert.equal(above.observed_at, 7);
  assert.equal(above.status, "above_target");
  assert.equal(above.target_input_tokens, 100);
  assert.equal(above.input_capacity_tokens, 300);
  assert.ok(above.target_excess_tokens > 0);
  assert.ok(above.headroom_tokens > 0);

  const overflow = inspectContextBudget({
    context: normalizeContext({ messages: [{ role: "user", content: "x".repeat(2400), timestamp: 1 }] }),
    contextWindow: 400,
    maxOutputTokens: 100,
    targetInputTokens: 100,
  });
  assert.equal(overflow.status, "overflow");
  assert.equal(overflow.headroom_tokens, 0);
});

test("context budget rejects invalid targets instead of silently changing policy", () => {
  const context = normalizeContext({ messages: [] });
  for (const targetInputTokens of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => inspectContextBudget({
      context,
      contextWindow: 1000,
      maxOutputTokens: 100,
      targetInputTokens,
    }), /positive safe integer/);
  }
});
