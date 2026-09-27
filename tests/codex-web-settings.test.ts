import assert from "node:assert/strict";
import test from "node:test";
import { readCodexWebSettings } from "../lib/codex-web/settings.ts";

test("bridge context target is explicit configuration with a safe default", async () => {
  const base = {
    GENTLE_CODEX_WEB_TOKEN: "pair",
    GENTLE_CODEX_WEB_URL: "http://127.0.0.1:17841",
    CODEX_CHATGPT_WEB_HOME: "/definitely/missing/context-settings",
  };
  assert.equal((await readCodexWebSettings(base))?.contextTargetTokens, 48_000);
  assert.equal((await readCodexWebSettings({
    ...base,
    GENTLE_CODEX_WEB_CONTEXT_TARGET_TOKENS: "32000",
  }))?.contextTargetTokens, 32_000);
  await assert.rejects(readCodexWebSettings({
    ...base,
    GENTLE_CODEX_WEB_CONTEXT_TARGET_TOKENS: "3.5",
  }), /positive safe integer/);
});
