import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexNativeProvider } from "../lib/codex-native/provider.ts";

export default function registerCodexNativeExtension(pi: Pick<ExtensionAPI, "registerProvider">, env: NodeJS.ProcessEnv = process.env): void {
	if (env.GENTLE_CODEX_NATIVE !== "1") return;
	const provider = createCodexNativeProvider({ env });
	pi.registerProvider(provider);
}
