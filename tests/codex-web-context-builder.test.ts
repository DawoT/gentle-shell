import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextBuilder, ContextBudgetError } from "../lib/codex-web/context-builder.ts";
import { ProjectMemory } from "../lib/codex-web/project-memory.ts";

test("ContextBuilder preserves Layer 1 Control intact and injects .agents/STATE.md", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ctx-builder-ctrl-"));
  try {
    const agentsDir = join(workspace, ".agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "STATE.md"), `# Goal: Migrate to Zero-Deps MCP\n- Constraint: No external npm dependencies\n- Pending: Audit gates`);

    const builder = new ContextBuilder({
      workspaceRoot: workspace,
      contextWindow: 64_000,
      maxOutputTokens: 8_000,
      targetInputTokens: 48_000,
    });

    const result = await builder.buildContext({
      systemPrompt: "You are an autonomous engineering assistant.",
      sessionId: "session-test-01",
      messages: [
        { role: "user", content: "What is our current objective?", timestamp: Date.now() },
      ],
    });

    assert.ok(result.messages.length > 0);
    const systemMsg = result.messages.find((m: any) => m.role === "system");
    assert.ok(systemMsg);
    assert.match(String(systemMsg.content), /You are an autonomous engineering assistant/);
    assert.match(String(systemMsg.content), /No external npm dependencies/);
    assert.match(String(systemMsg.content), /Audit gates/);
    assert.equal(result.budget.status, "within_target");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ContextBuilder compacts older recent work when exceeding 48,000 token target while preserving Control", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ctx-builder-budget-"));
  try {
    const agentsDir = join(workspace, ".agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "STATE.md"), `# Essential Rule: Preserved at all costs`);

    // Create a memory checkpoint in .agents/memory/
    const memory = await ProjectMemory.open(workspace, "session-test-02");
    await memory.saveCompaction({
      id: "entry-01",
      parentId: null,
      timestamp: "2026-09-27T18:00:00.000Z",
      summary: "Checkpoint 1: Setup completed",
      firstKeptEntryId: "entry-01",
      tokensBefore: 20000,
      reason: "manual",
      willRetry: false,
    });

    const builder = new ContextBuilder({
      workspaceRoot: workspace,
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      targetInputTokens: 48_000, // 48k target
    });

    // Build a message history exceeding 48k tokens (e.g. 55k tokens ~ 220,000 bytes)
    const largeContent = "data-token-fill ".repeat(15_000); // ~240,000 bytes -> ~60k tokens
    const messages = [
      { role: "user", content: "Initial request " + largeContent, timestamp: 1 },
      { role: "assistant", content: "Initial large reply " + largeContent, timestamp: 2 },
      { role: "user", content: "Latest user prompt: fix the tests", timestamp: 3 },
    ];

    const result = await builder.buildContext({
      systemPrompt: "System direct control directive.",
      sessionId: "session-test-02",
      messages,
    });

    // Control layer directive must be 100% intact
    const systemMsg = result.messages.find((m: any) => m.role === "system");
    assert.ok(systemMsg);
    assert.match(String(systemMsg.content), /Essential Rule: Preserved at all costs/);
    assert.match(String(systemMsg.content), /System direct control directive/);

    // Latest user turn must be preserved
    const lastUserMsg = result.messages[result.messages.length - 1];
    assert.equal(lastUserMsg.role, "user");
    assert.equal(lastUserMsg.content, "Latest user prompt: fix the tests");

    // Older huge messages must have been compacted into a summary checkpoint
    assert.ok(result.budget.estimated_input_tokens <= 48_000, `Expected <= 48000, got ${result.budget.estimated_input_tokens}`);
    assert.equal(result.wasCompacted, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("ContextBuilder throws ContextBudgetError when Control layer alone exceeds model capacity", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "ctx-builder-overflow-"));
  try {
    const agentsDir = join(workspace, ".agents");
    await mkdir(agentsDir, { recursive: true });
    // Huge STATE.md that exceeds total input capacity
    await writeFile(join(agentsDir, "STATE.md"), "X".repeat(200_000));

    const builder = new ContextBuilder({
      workspaceRoot: workspace,
      contextWindow: 10_000, // Small capacity
      maxOutputTokens: 2_000, // Capacity = 8,000 tokens ~ 32,000 bytes
      targetInputTokens: 6_000,
    });

    await assert.rejects(
      builder.buildContext({
        systemPrompt: "Control instructions",
        sessionId: "session-test-03",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      }),
      (err: any) => err instanceof ContextBudgetError && err.code === "context_budget_exceeded",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
