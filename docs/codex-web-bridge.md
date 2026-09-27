# ChatGPT Web Bridge for Pi

The `gentle-codex-web` extension registers a Responses provider backed by a local `codex-chatgpt-web` launcher advertising host protocol v1. Pi owns its normal agent loop, tool execution, permission hooks and session lifecycle. The bridge transports model requests and tool calls. Its host mode refuses legacy local filesystem handlers, inferred command aliases and gateway fallback, and does not initialize workspace state files.

On session startup the extension reads the local bridge configuration and probes `/healthz`. Only a launcher advertising `hostProtocol:1` receives a pairing request. The configuration's `controlToken` authorizes pairing; a separate random capability authorizes each host session. Credentials are not shown in the sidebar or model catalog. The extension registers the advertised Web routes without selecting one automatically.

Configuration defaults:

- Launcher: `http://127.0.0.1:17841`, or the port in the local bridge configuration.
- Configuration: `$CODEX_CHATGPT_WEB_HOME/config.json`, otherwise `~/.codex-chatgpt-web/config.json`.
- Optional overrides: `GENTLE_CODEX_WEB_URL` and `GENTLE_CODEX_WEB_TOKEN`.
- Disable automatic detection: `GENTLE_CODEX_WEB=0`.

Use `/web-bridge connect`, `/web-bridge disconnect`, or `/web-bridge status`. Pick a model under **ChatGPT Web Bridge** in Pi's model picker after connection. Pairing requires a bridge built with host protocol v1 in Full mode; an older installed launcher will remain unavailable until updated. Source edits do not update a running launcher.

`/web-bridge status` also inspects the current user turn when one exists. It reports bridge activity/cancellation, the last accepted and last completed request sequences, and emitted calls without registered results. Idle means no active bridge response; inspect Pi's tool output to verify task effects. This read does not execute a model request, create a session, retry a command or clear uncertain-delivery protection. An older host-v1 bridge without the inspection endpoint reports an inspection error and requires updating.

## Transport and lifecycle

The provider uses Pi's public OpenAI Responses factory and preserves payload/response callbacks. It binds session capability, turn ID and monotonic request sequence after user payload callbacks, and does not retry uncertain requests automatically. Model reasoning effort is selected from the route's advertised supported values; Pi's default `none` must not be sent to routes that do not support it.

Each Pi session affinity gets its own capability (at most 16 per provider instance). Full tool history is transmitted. Live results must match calls emitted to that session; historical paired calls before the latest user message remain snapshots, without authority to complete current work. The backend freezes the tool catalog within a turn and rejects identity overrides, consumed sequences, cross-session continuations and changed result replays.

Closing or switching the extension session unregisters the provider and revokes capabilities. Connection generations prevent late handshakes or responses from reactivating or cancelling a newer session. A lost response marks its turn uncertain. Cancellation endpoints report bridge HTTP/browser settlement; they do not assert that a host command has stopped. Pi owns command cancellation through its normal AbortSignal. The provider retains the agent cancellation subscription while Pi executes tools between model rounds, and retires the corresponding bridge turn on abort. A subsequent user request can preserve the cancelled tool result as historical evidence without reviving the cancelled turn.

The backend bounds host sessions, request bodies and retained continuation state. The native MCP transport limits serialized tool-result delivery to 1 MiB; host HTTP requests have a separate 4 MiB body budget. These delivery bounds do not establish an OS sandbox or cap every producer allocation. Subscription routes use zero cost rates because the bridge does not expose marginal billing; the sidebar makes no savings claims.

## Verification

```sh
node --experimental-strip-types --test tests/codex-web-*.test.ts
pnpm test
pnpm run typecheck
```

From the bridge checkout, run the joint probe:

```sh
bun scripts/smoke-pi-host.ts ../gentle-shell
```

The joint probe starts actual host HTTP routes and two installed Pi runtimes concurrently, each with its own committed TypeScript workspace. Across twenty model rounds it executes `facts_query`, blocks a shell call through Pi's permission hook, runs an allowed command, aborts a running command, continues after cancellation, explicitly disconnects/reconnects, and checks that all session capabilities are revoked. It verifies filesystem effects independently of bridge cancellation acknowledgements. Model output is scripted; this is not a live ChatGPT/browser evaluation. No installed launcher restart is part of the probe.

## Live verification

A live run on 2026-09-27 verified the installed Pi 0.87.1 TUI and SDK against an authenticated ChatGPT browser: a text request completed, and `facts_query` returned the `buildPiInvocation` signature. Codex also completed a real request through `/v1/responses`. The Instant route requires `model_reasoning_effort="low"`; an explicitly selected model with an incompatible effort is rejected rather than silently changed.

For a small live SDK check, use an empty agent directory and an existing local launcher configuration:

```sh
mkdir -p /tmp/pi-live-agent
PI_HOST_PROBE_WORKSPACE="$PWD" \
PI_HOST_PROBE_AGENT_DIR=/tmp/pi-live-agent \
node --experimental-strip-types tests/support/codex-web-live-probe.mjs
```

This sends a real model request and checks its final text; the default joint probe above remains scripted. Host model requests share a rate budget across capabilities (default 60/minute, configurable with `rateLimitRpm` or `CODEX_RATE_LIMIT_RPM`; zero disables it). Cancellation and capability deletion remain available when that budget is exhausted.

## Transport hardening verified on 2026-09-27

Health and pairing JSON responses are bounded incrementally at 256 KiB; cancellation acknowledgements are bounded at 64 KiB. Chunked responses are rejected on exceeding the byte budget without waiting for end of stream. This bounds client retention, not all allocations inside the network stack.

A failed request or interrupted response retires its remote turn through a best-effort cancellation using the original capability. The turn remains uncertain and cannot be replayed automatically. A cancellation acknowledgement still describes bridge settlement, not termination of a Pi command.

The complete Gentle Shell suite passed 4,081 tests with 41 skipped, followed by successful provider-contract and runtime-harness checks (`/tmp/pi-retirement-full-gentle.log`). Fourteen focused client/provider/extension tests passed (`/tmp/pi-transport-retirement-green.log`). Type checking retains 188 recorded diagnostics with no regressions. Real Codex verification also completed one local `printf CODEX_TOOL_OK` command and reported its observed output (`/tmp/pi-live-codex-tool.log`).

After the environment restart, a fresh complete run again passed 4,081 tests, 41 skipped, and the provider-contract/runtime-harness stages (`/tmp/pi-persistence-full-gentle.log`). Native Codex executed exactly one successful command in an isolated committed read-only workspace; independent assertions verified no `.agents` directory and a clean git status (`/tmp/pi-persistence-codex-live.log`). The bridge's automatic initialization/checkpoints now respect write authority. A post-reload live Pi request passed (`/tmp/pi-lifecycle-postreload-live.log`).

The source launcher supervises the current daemon and native tunnel. A visible Pi terminal remains open; use `/web-bridge status` and `/model` to select an advertised ChatGPT Web model. These runtime observations establish compatibility with the installed Pi 0.87.1 and Codex binary, not an untested version matrix or a general model-quality benchmark.

Turn inspection was verified with real local HTTP peers and the installed Pi runtime: closed metadata schema, 64 KiB/three-second bounds, generation changes, late 401 responses, and preservation of uncertain-turn rejection. The provider rejects an inspection of a user turn superseded during the read. The joint probe now observes eight status reads across two concurrent Pi runtimes/four capabilities without increasing its twenty model rounds.

Final inspection increment: 4,091 tests passed, 41 skipped, zero failures, with provider-contract/runtime-harness passing (`/tmp/host-inspection-full-gentle.log`). A real Pi TUI completed a live request and visibly displayed the accepted/completed sequence and pending-result count through `/web-bridge status` (`/tmp/host-inspection-tui.log`). The current source daemon serves the endpoint and a visible Pi terminal remains open.

## Delivery completeness

The client observes successful SSE framing with an 8 MiB budget per accumulated event. A clean HTTP EOF without a dispatched terminal, a foreign completion identity or an accepted bodyless response retires that turn as uncertain and requests scoped cancellation. Inspection never unlocks an uncertain turn. A new user turn may proceed without replacing the capability. Explicit terminal failures remain distinct from truncation, while SDK/agent cancellation still retires the turn.

This protection is in memory; it does not resume a session after daemon restart or guarantee exactly-once external side effects. See [the recovery ADR and sprint backlog](engineering/codex-web-sprints.md) for current evidence and remaining requirements. New sessions load the changed client; an existing visible Pi session keeps its previously loaded modules.

## Durable tool admission (incremental recovery)

When Pi uses the `gentle-codex-web` provider with a persistent Pi session file, the extension writes a private per-session admission record before allowing each tool call. The record contains the Pi session scope, call identity, tool name, input hash, nonce and admission time. It stores neither raw arguments nor tool output. A separate immutable record notes when Pi's tool-result hook observed a result. On POSIX, records and their parent directory entries are synced before admission is returned. A second process or a reopened Pi session cannot execute that same call ID again, whether the first process died before or after a side effect. In-memory Pi sessions retain the guard only while the extension process lives.

Use `/web-bridge recovery` to inspect up to ten receipts in the current Pi session. It shows hashed call references and states: `admitted` means execution may or may not have happened; `result-observed` means the tool hook saw a result, not that external effects or the transcript are committed. A denied call can remain admitted because Pi blocks it after this extension's admission hook. Verify effects independently before asking Pi to perform new work. Recovery never unlocks or replays a call. If an admission lock remains after a crash, the session blocks new tool calls until an operator verifies no writer is live and repairs the owned storage; there is no automatic lock removal.

The guarantee is scoped to the same Pi session ID, session-file path, workspace path and `toolCallId`. A new call ID or a copied/renamed session is a new scope. It is not exactly-once execution of semantically equivalent commands. Local users with write access to the private receipt directory can tamper with storage; this mechanism is an accident/restart guard, not an OS security boundary. Windows lacks the POSIX directory-sync guarantee. Tool-result persistence failure is reported to Pi as an error with an uncertainty warning; the admission remains blocked.

## Model-turn restart guard

The same private recovery store also admits a model turn before its first `/host/v1/responses` request. The turn ID is derived from the Pi session scope and the latest user-message fingerprint; the receipt stores hashes and identifiers, not the prompt. Normal tool/model rounds reuse the in-memory admitted turn. Before each HTTP request, the provider writes two exclusive round claims: one for the model and normalized Pi context before `onPayload`, and one for the sanitized Responses payload after `onPayload`. Repeating either exact representation is blocked; a legitimate continuation with a tool result changes both. A provider or Pi process reopened with the same persistent session file refuses to send that old user turn again, including when the earlier HTTP stream ended incompletely. A distinct user message may start a new turn. Concurrent streams for one user turn are rejected while a model request is active.

The Pi model receipt remains `admitted` even if a response completed: it says the request was allowed, not that Pi persisted the final transcript or that the browser completed side effects. The round claims compare serialized representations, not semantic equivalence if both context and payload change. Reopening a session cannot resume an old host capability or infer a safe replay after daemon restart. An in-memory Pi session loses this cross-process guard when its process ends. A new session ID, copied/renamed session file, or new user message creates a different scope. A failed admission can conservatively prevent reuse even when no model request reached the browser.

For a persistent Pi session, pairing also binds its digest-only recovery scope to a fresh host capability. `/web-bridge recovery` reads host model metadata across daemon restarts as well as local tool receipts. Host states are `unobserved`, `admitted`, `model-completed` and `cancelled`; the completed sequence and response ID are host-side evidence only. The command never permits replay and does not establish that Pi received the response, saved its transcript, or settled external tool effects. If the host journal is corrupt or unavailable, the command reports the inspection error while retaining the local receipt list. An older running daemon must be restarted to accept the new pairing field.

## Pi bash descendant containment

The existing `quiet-tools` bash definition dispatches Web-provider calls through a contained Pi `BashOperations` wrapper and keeps its current rendering/timing for other providers. When quiet tools are disabled, the bridge extension registers that provider-aware bash fallback itself. For `gentle-codex-web` on Linux with delegated cgroup v2, the command joins a private child cgroup before executing. Abort and timeout retain Pi's process-group cancellation and also kill the cgroup, covering ordinary descendants that call `setsid`. Normal completion retires leftover processes in that cgroup. When delegation is unavailable, Pi's existing process-group behavior remains; Windows retains Pi's native tree termination. This changes Pi's command execution path, not the bridge HTTP/browser cancellation scope.

A command running under the same UID can deliberately migrate out of a writable cgroup, so this is operational descendant cleanup rather than an adversarial sandbox. The session's tool receipt still proves only admission and observed result, not that external side effects were undone. The composed host/Pi probe tests a detached descendant after cancellation; the focused Pi tests cover timeout, normal completion and immediate abort.
