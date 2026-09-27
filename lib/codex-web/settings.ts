import { readBoundedJson } from "./http-json.ts";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loopbackOrigin } from "./client.ts";

export async function readCodexWebSettings(env = process.env): Promise<{
  origin: string;
  pairingToken: string;
  contextTargetTokens: number;
} | undefined> {
  if (env.GENTLE_CODEX_WEB === "0") return undefined;
  let config: Record<string, unknown> = {};
  const configuredHome = env.CODEX_CHATGPT_WEB_HOME?.trim() || join(homedir(), ".codex-chatgpt-web");
  const home = configuredHome.startsWith("~/") ? join(homedir(), configuredHome.slice(2)) : resolve(configuredHome);
  try {
    const path = join(home, "config.json");
    if ((await stat(path)).size > 1024 * 1024) throw new Error("Bridge configuration exceeds its size budget");
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read local bridge configuration");
  }
  const pairingToken = env.GENTLE_CODEX_WEB_TOKEN || config.controlToken;
  if (typeof pairingToken !== "string" || !pairingToken.trim()) return undefined;
  const port = config.port ?? 17841;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid local bridge port");
  const configuredTarget = env.GENTLE_CODEX_WEB_CONTEXT_TARGET_TOKENS ?? config.contextTargetTokens ?? 48_000;
  const contextTargetTokens = typeof configuredTarget === "string" && /^[1-9][0-9]*$/.test(configuredTarget)
    ? Number(configuredTarget)
    : configuredTarget;
  if (!Number.isSafeInteger(contextTargetTokens) || Number(contextTargetTokens) < 1) {
    throw new Error("ChatGPT Web context target must be a positive safe integer");
  }
  const origin = loopbackOrigin(env.GENTLE_CODEX_WEB_URL || `http://127.0.0.1:${port}`);
  return { origin, pairingToken, contextTargetTokens: Number(contextTargetTokens) };
}

export async function probeCodexWebHost(origin: string): Promise<boolean> {
  const response = await fetch(`${loopbackOrigin(origin)}/healthz`, {
    redirect: "error",
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) return false;
  const body = await readBoundedJson(response, 256 * 1024, "Bridge health reply");
  return !!body && typeof body === "object" && "hostProtocol" in body && body.hostProtocol === 1;
}
