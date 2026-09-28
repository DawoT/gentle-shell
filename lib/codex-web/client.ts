import { readBoundedJson } from "./http-json.ts";
import { SseDelivery } from "./sse-delivery.ts";

export interface CodexWebModel {
  id: string;
  name: string;
  reasoning: boolean;
  reasoningEffort?: string;
  supportedReasoningEfforts?: string[];
  contextWindow: number;
  maxTokens: number;
}

export interface CodexWebTurnState {
  session_id: string;
  turn_id: string;
  state: "unknown" | "admitting" | "active" | "idle" | "cancelled";
  cancellation: "requested" | "settled" | null;
  request_sequence: number | null;
  last_completed_sequence: number | null;
  last_completed_response_id: string | null;
  response_retained: boolean;
  pending_tool_calls: number;
  scope: "bridge-http-and-browser-only";
  replay_allowed: false;
}

export interface CodexWebRecoveryState {
  scope: "bridge-model-only";
  turn_id: string | null;
  state: "unobserved" | "admitted" | "model-completed" | "cancelled";
  cancellation: "requested" | "settled" | null;
  last_completed_sequence: number | null;
  last_completed_response_id: string | null;
  replay_allowed: false;
}

function validateRecoveryState(value: unknown): CodexWebRecoveryState {
  const fields = ["scope", "turn_id", "state", "cancellation", "last_completed_sequence", "last_completed_response_id", "replay_allowed"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge recovery status");
  const row = value as Record<string, unknown>;
  const hasCompletion = row.last_completed_sequence !== null;
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
    || row.scope !== "bridge-model-only" || row.replay_allowed !== false
    || !["unobserved", "admitted", "model-completed", "cancelled"].includes(row.state as string)
    || ![null, "requested", "settled"].includes(row.cancellation as null | string)
    || ((row.state === "cancelled") !== (row.cancellation !== null))
    || !(row.turn_id === null || (typeof row.turn_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.turn_id)))
    || (row.state === "unobserved" && row.turn_id !== null)
    || (row.state !== "unobserved" && row.turn_id === null)
    || (row.state === "model-completed" && !hasCompletion)
    || ((row.state === "unobserved" || row.state === "admitted") && hasCompletion)
    || (hasCompletion !== (Number.isSafeInteger(row.last_completed_sequence) && (row.last_completed_sequence as number) > 0))
    || (hasCompletion !== (typeof row.last_completed_response_id === "string"
      && row.last_completed_response_id.length > 0 && row.last_completed_response_id.length <= 256
      && !/[\x00-\x1f]/.test(row.last_completed_response_id)))) {
    throw new Error("Invalid bridge recovery status");
  }
  return value as CodexWebRecoveryState;
}

function validateTurnState(value: unknown, sessionId: string, turnId: string): CodexWebTurnState {
  const fields = ["session_id", "turn_id", "state", "cancellation", "request_sequence", "last_completed_sequence", "last_completed_response_id", "response_retained", "pending_tool_calls", "scope", "replay_allowed"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bridge turn status");
  const row = value as Record<string, unknown>;
  const positiveOrNull = (item: unknown) => item === null || (Number.isSafeInteger(item) && (item as number) > 0);
  if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
    || row.session_id !== sessionId || row.turn_id !== turnId
    || !["unknown", "admitting", "active", "idle", "cancelled"].includes(row.state as string)
    || ![null, "requested", "settled"].includes(row.cancellation as null | string)
    || !positiveOrNull(row.request_sequence) || !positiveOrNull(row.last_completed_sequence)
    || !(row.last_completed_response_id === null || typeof row.last_completed_response_id === "string")
    || typeof row.response_retained !== "boolean" || !Number.isSafeInteger(row.pending_tool_calls)
    || (row.pending_tool_calls as number) < 0 || (row.pending_tool_calls as number) > 4096
    || row.scope !== "bridge-http-and-browser-only" || row.replay_allowed !== false) {
    throw new Error("Invalid bridge turn status");
  }
  return value as CodexWebTurnState;
}

export function loopbackOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The bridge requires an HTTP loopback origin without credentials or a path");
  }
  return url.origin;
}

interface HostSession {
  token: string;
  id: string;
  sequence: number;
  models: CodexWebModel[];
  lifetime: AbortController;
  uncertainTurns: Set<string>;
}

/** Local capability transport. No automatic replay, reconnect, or command execution. */
export class CodexWebClient {
  readonly origin: string;
  #session?: HostSession;
  #generation = 0;
  #pairing?: AbortController;

  constructor(origin = "http://127.0.0.1:17841") {
    this.origin = loopbackOrigin(origin);
  }

  get connected(): boolean {
    return this.#session !== undefined;
  }

  get models(): CodexWebModel[] {
    return this.#session?.models.map(model => ({ ...model })) ?? [];
  }

  async connect(pairingToken: string, cwd: string, recoveryScope?: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (recoveryScope !== undefined && !/^[a-f0-9]{64}$/.test(recoveryScope)) {
      throw new Error("Invalid bridge recovery scope");
    }
    const generation = ++this.#generation;
    const previous = this.#session;
    this.#session = undefined;
    this.#pairing?.abort();
    const pairing = new AbortController();
    this.#pairing = pairing;
    await this.revoke(previous);
    pairing.signal.throwIfAborted();
    if (!pairingToken.trim()) throw new Error("Missing local bridge pairing credential");
    const response = await fetch(`${this.origin}/host/v1/sessions`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([pairing.signal, AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
      headers: { authorization: `Bearer ${pairingToken}`, "content-type": "application/json" },
      body: JSON.stringify({ protocol: 1, host: "pi", cwd, ...(recoveryScope ? { recovery_scope: recoveryScope } : {}) }),
    });
    if (!response.ok) throw new Error(`Bridge pairing failed (HTTP ${response.status}); a host-v1 launcher is required`);
    const value = await readBoundedJson(response, 256 * 1024, "Bridge handshake") as {
      protocol: number;
      session_id: string;
      token: string;
      models: CodexWebModel[];
    } | null;
    if (!value || value.protocol !== 1 || typeof value.session_id !== "string" || !value.session_id
      || typeof value.token !== "string" || !value.token || !Array.isArray(value.models)
      || value.models.length > 100 || value.models.some((model: CodexWebModel) => (
        !model || typeof model.id !== "string" || !model.id.startsWith("chatgpt-web/")
        || typeof model.name !== "string" || typeof model.reasoning !== "boolean"
        || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1
        || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1
      ))) {
      throw new Error("Invalid bridge host-v1 handshake");
    }
    const session: HostSession = {
      token: value.token,
      id: value.session_id,
      sequence: 0,
      models: value.models,
      lifetime: new AbortController(),
      uncertainTurns: new Set(),
    };
    if (generation !== this.#generation || pairing.signal.aborted || signal?.aborted) {
      await this.revoke(session);
      throw new Error("Bridge pairing was superseded");
    }
    this.#pairing = undefined;
    this.#session = session;
  }

  async request(turnId: string, payload: unknown, init: RequestInit = {}): Promise<Response> {
    const session = this.#session;
    if (!session) throw new Error("Bridge is not connected");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) throw new Error("Invalid host turn identity");
    if (session.uncertainTurns.has(turnId)) throw new Error("Turn delivery is uncertain; use /web-bridge status to inspect host state before starting a new turn");
    const signal = init.signal
      ? AbortSignal.any([init.signal, session.lifetime.signal])
      : session.lifetime.signal;
    signal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${session.token}`);
    headers.set("content-type", "application/json");
    headers.set("x-cgw-session-id", session.id);
    headers.set("x-cgw-turn-id", turnId);
    headers.set("x-cgw-sequence", String(++session.sequence));
    let cancellationRequested = false;
    const onAbort = () => {
      session.uncertainTurns.add(turnId);
      if (!cancellationRequested) {
        cancellationRequested = true;
        void this.cancelSessionTurn(session, turnId).catch(() => {});
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    try {
      const response = await fetch(`${this.origin}/host/v1/responses`, {
        ...init,
        method: "POST",
        redirect: "error",
        headers,
        signal,
        body: JSON.stringify(payload),
      });
      if (response.status >= 500) onAbort();
      if (response.status === 401 && this.#session === session) {
        let rejection: unknown;
        try {
          rejection = await readBoundedJson(response, 16 * 1024, "Bridge authorization reply");
        } catch {
          rejection = { error: { type: "host_protocol_error", message: "Bridge returned an unreadable HTTP 401 reply" } };
        }
        cleanup();
        this.#session = undefined;
        await this.revoke(session);
        return Response.json(rejection, { status: 401, headers: response.headers });
      }
      if (!response.body) {
        if (response.ok) {
          throw new Error("Bridge accepted a response without a body; delivery is uncertain");
        }
        cleanup();
        return response;
      }
      const reader = response.body.getReader();
      const delivery = response.ok && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream"
        ? new SseDelivery()
        : undefined;
      return new Response(new ReadableStream({
        pull: async controller => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              delivery?.finish();
              cleanup();
              controller.close();
            } else {
              delivery?.push(value);
              controller.enqueue(value);
            }
          } catch (error) {
            onAbort();
            cleanup();
            void reader.cancel(error).catch(() => {});
            controller.error(error);
          }
        },
        cancel: async reason => {
          onAbort();
          cleanup();
          await reader.cancel(reason);
        },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      onAbort();
      cleanup();
      throw error;
    }
  }

  async inspectTurn(turnId: string): Promise<CodexWebTurnState> {
    const session = this.#session;
    const generation = this.#generation;
    if (!session) throw new Error("Bridge is not connected");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) throw new Error("Invalid host turn identity");
    const signal = AbortSignal.any([session.lifetime.signal, AbortSignal.timeout(3000)]);
    const response = await fetch(`${this.origin}/host/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(turnId)}`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (response.status === 401 && this.#session === session) {
      this.#session = undefined;
      await this.revoke(session);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Bridge turn inspection failed (HTTP ${response.status})`);
    }
    const value = await readBoundedJson(response, 64 * 1024, "Bridge turn status");
    signal.throwIfAborted();
    if (this.#session !== session || generation !== this.#generation) throw new Error("Bridge turn inspection was superseded");
    return validateTurnState(value, session.id, turnId);
  }

  async inspectRecovery(): Promise<CodexWebRecoveryState> {
    const session = this.#session;
    const generation = this.#generation;
    if (!session) throw new Error("Bridge is not connected");
    const signal = AbortSignal.any([session.lifetime.signal, AbortSignal.timeout(3000)]);
    const response = await fetch(`${this.origin}/host/v1/sessions/${encodeURIComponent(session.id)}/recovery`, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (response.status === 401 && this.#session === session) {
      this.#session = undefined;
      await this.revoke(session);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Bridge recovery inspection failed (HTTP ${response.status})`);
    }
    const value = await readBoundedJson(response, 64 * 1024, "Bridge recovery status");
    signal.throwIfAborted();
    if (generation !== this.#generation || this.#session !== session) {
      throw new Error("Bridge recovery inspection was superseded");
    }
    return validateRecoveryState(value);
  }

  async cancel(turnId: string): Promise<unknown> {
    return this.#session ? this.cancelSessionTurn(this.#session, turnId) : { status: "unknown" };
  }

  private async cancelSessionTurn(session: HostSession, turnId: string): Promise<unknown> {
    const response = await fetch(`${this.origin}/host/v1/sessions/${encodeURIComponent(session.id)}/turns/${encodeURIComponent(turnId)}/cancel`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) return { status: "unknown" };
    return readBoundedJson(response, 64 * 1024, "Bridge cancellation reply");
  }

  async close(): Promise<void> {
    this.#generation += 1;
    this.#pairing?.abort();
    this.#pairing = undefined;
    const session = this.#session;
    this.#session = undefined;
    await this.revoke(session);
  }

  private async revoke(session?: HostSession): Promise<void> {
    if (!session) return;
    session.lifetime.abort();
    await fetch(`${this.origin}/host/v1/sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(3000),
      headers: { authorization: `Bearer ${session.token}` },
    }).catch(() => {});
  }
}
