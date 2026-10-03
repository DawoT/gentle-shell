import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexNativeProvider } from "../lib/codex-native/provider.ts";

// Registration is unconditional so the experimental models are visible in
// model selectors. Activation stays gated: the provider refuses credential
// resolution and completion attempts unless GENTLE_CODEX_NATIVE=1 is set
// (see lib/codex-native/provider.ts), and gentle-agents refuses codex-native
// child selection without the same flag.
export default function registerCodexNativeExtension(pi: Pick<ExtensionAPI, "registerProvider">, env: NodeJS.ProcessEnv = process.env): void {
	const provider = createCodexNativeProvider({ env });
	pi.registerProvider(provider);
}
