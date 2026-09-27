import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { createCodexWebProvider } from "../../lib/codex-web/provider.ts";

const [origin, cwd, sessionFile] = process.argv.slice(2);
const provider = await createCodexWebProvider({
  origin,
  pairingToken: "pair",
  cwd,
  sessionId: "pi-session",
  sessionFile,
});
try {
  const model = {
    ...provider.config.models[0],
    provider: "gentle-codex-web",
    api: "openai-responses",
    baseUrl: provider.config.baseUrl,
  };
  await provider.config.streamSimple(model, normalizeContext({
    messages: [{ role: "user", content: "Run once", timestamp: 1 }],
  })).result();
} finally {
  await provider.close();
}
