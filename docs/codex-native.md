# Opt into experimental Codex Native

Codex Native is disabled by default. It delegates Responses streaming to Pi and sends Codex credentials to a **trusted local service**, not a sandbox. Enable it only if you trust the process listening on the configured loopback endpoint and authorize credential use.

## Quick path

1. Independently provision and verify a trusted Responses-compatible local daemon. This package does not install, start, or verify one.
2. Start the parent Pi process with `GENTLE_CODEX_NATIVE=1`. Only the exact value `1` enables registration and use. Disabled child selection fails with an actionable opt-in error instead of activating the provider.
3. Select a `codex-native` model only after independently confirming daemon support. The child receives the active gate through the existing child environment and loads `extensions/codex-native.ts` before RPC model activation.

Registration and catalog access do not read credentials or contact the daemon. Once enabled, authentication resolution or inference can read `CODEX_HOME/auth.json`, falling back to `~/.codex/auth.json`. The package does not refresh or write these credentials. Tokens, API keys and account IDs are validated as strings before trimming; file and JSON diagnostics do not echo file content or underlying parser errors.

## Endpoint and transport contract

The default endpoint is `http://127.0.0.1:17841/v1`. Programmatic `baseUrl` overrides must use HTTP(S) with literal `localhost`, `127.0.0.1`, or `[::1]`; userinfo, remote hosts, aliases and other protocols are rejected before authentication. Requests must remain on the configured origin. Redirects are disabled with `redirect: error`, and redirect responses are rejected rather than followed.

Request headers are merged with init headers (init values win), then local authorization, account ID and originator are applied. Stale account IDs are removed when the local credentials have none. Method, body and signal follow Request/init semantics. String JSON payloads and the Pi payload callback enforce `store: false` and `stream: true`. Pi owns SSE parsing, usage events and terminal stream semantics; this package does not duplicate its parser. Injected auth resolvers and fetch implementations are trusted code and must honor the redirect policy themselves.

Loopback restrictions prevent ordinary remote credential forwarding; they do not isolate prompts, files or credentials from the local service, protect against malicious local listeners, or guarantee localhost DNS resolution in every environment.

## Provisional metadata and evidence limits

The six static model IDs are WIP candidates, **not validated daemon-supported models**. Reasoning maps, image support, token limits and context windows are provisional. Numeric zero costs are Pi-required unknown-price placeholders, **not zero actual billable prices**. Do not use the displayed cost estimate for billing decisions. Offline tests establish adapter contracts, not actual model capability.

## Live tests are separately gated

Ordinary offline tests inject synthetic credentials and fetch responses. The live file skips before credential-path or daemon probes unless **both** `GENTLE_CODEX_NATIVE=1` and `GENTLE_CODEX_NATIVE_LIVE=1` are set. An enabled live test has a 15-second test timeout and a shared 10-second AbortSignal deadline; its health probe also has a one-second deadline.

The stabilization work does not authorize live inference or reading real credentials. Keep both flags disabled for verification. Enabling the live flag is a separate operator decision that may send prompts and credentials and incur billing.
