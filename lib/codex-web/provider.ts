import { createHash } from "node:crypto";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CodexWebClient } from "./client.ts";
import { ToolReceipts } from "./tool-receipts.ts";
import { inspectContextBudget, type ContextBudgetSnapshot } from "./context-budget.ts";

export interface CodexWebProviderOptions {
  origin: string;
  pairingToken: string;
  cwd: string;
  sessionId: string;
  sessionFile?: string;
  contextTargetTokens?: number;
}

/** Pi owns the agent loop and every tool invocation; this provider only transports Responses. */
export async function createCodexWebProvider(settings: CodexWebProviderOptions) {
  const clients = new Map<string, Promise<CodexWebClient>>();
  const journals = new Map<string, ToolReceipts>();
  const contexts = new Map<string, ContextBudgetSnapshot>();
  const turns = new Map<string, {
    user: string;
    id: string;
    journal: ToolReceipts;
    admitted: boolean;
    inFlight: boolean;
    cancelled: boolean;
    subscriptions: Map<AbortSignal, () => void>;
  }>();
  const clearTurn = (turn: { subscriptions: Map<AbortSignal, () => void> }) => {
    for (const [signal, listener] of turn.subscriptions) {
      signal.removeEventListener("abort", listener);
    }
    turn.subscriptions.clear();
  };
  let closed = false;
  const getJournal = (sessionId: string): ToolReceipts => {
    const existing = journals.get(sessionId);
    if (existing) return existing;
    if (journals.size >= 16) throw new Error("Bridge recovery session capacity reached");
    const journal = new ToolReceipts(sessionId, settings.cwd, settings.sessionFile);
    journals.set(sessionId, journal);
    return journal;
  };
  const getClient = (sessionId: string): Promise<CodexWebClient> => {
    if (closed) return Promise.reject(new Error("Bridge provider is closed; reconnect explicitly"));
    const existing = clients.get(sessionId);
    if (existing) return existing;
    if (clients.size >= 16) return Promise.reject(new Error("Bridge host session limit reached"));
    const client = new CodexWebClient(settings.origin);
    const recoveryScope = settings.sessionFile ? getJournal(sessionId).scope : undefined;
    const ready = client.connect(settings.pairingToken, settings.cwd, recoveryScope).then(async () => {
      if (closed) {
        await client.close();
        throw new Error("Bridge provider closed during pairing");
      }
      return client;
    });
    clients.set(sessionId, ready);
    return ready;
  };
  const root = await getClient(settings.sessionId);
  const config: ProviderConfig = {
    name: "ChatGPT Web Bridge",
    api: "openai-responses",
    apiKey: "host-session",
    baseUrl: `${root.origin}/host/v1`,
    models: root.models.map(model => ({
      ...model,
      input: ["text", "image"],
      // Subscription transport does not expose marginal billing. These are not savings estimates.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple(model, context, options = {}) {
      const sessionId = options.sessionId ?? settings.sessionId;
      contexts.set(sessionId, inspectContextBudget({
        context,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        targetInputTokens: settings.contextTargetTokens,
      }));
      const latestUser = context.messages.findLast(message => message.role === "user");
      const fingerprint = createHash("sha256").update(JSON.stringify(latestUser ?? null)).digest("hex");
      const contextDigest = createHash("sha256").update(JSON.stringify({ model: model.id, context })).digest("hex");
      let turn = turns.get(sessionId);
      if (!turn || turn.user !== fingerprint) {
        if (turn) clearTurn(turn);
        const journal = getJournal(sessionId);
        const id = createHash("sha256").update(`${journal.scope}:${fingerprint}`).digest("hex").slice(0, 32);
        turn = { user: fingerprint, id, journal, admitted: false, inFlight: false, cancelled: false, subscriptions: new Map() };
        turns.set(sessionId, turn);
      }
      const currentTurn = turn;
      const turnId = currentTurn.id;
      const stream = openAIResponsesApi().streamSimple({ ...model, api: "openai-responses", baseUrl: config.baseUrl! } as Model<"openai-responses">, context, {
        ...options,
        apiKey: "host-session",
        maxRetries: 0,
        onPayload: async (payload, currentModel) => {
          const replacement = await options.onPayload?.(payload, currentModel);
          const selected = replacement ?? payload;
          if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error("Invalid Responses payload");
          const row = root.models.find(candidate => candidate.id === model.id);
          if (!row) throw new Error("Model is not advertised by the bridge host");
          const body = selected as Record<string, any>;
          if (row.reasoningEffort) {
            const desired = body.reasoning?.effort;
            const effort = row.supportedReasoningEfforts?.includes(desired) ? desired : row.reasoningEffort;
            body.reasoning = { ...body.reasoning, effort };
          }
          return body;
        },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (request.url !== `${root.origin}/host/v1/responses` || request.method !== "POST") {
            throw new Error("Bridge provider refuses requests outside its host endpoint");
          }
          request.signal.throwIfAborted();
          const payload = JSON.parse(await request.text());
          // Runtime-owned identity is supplied by the authenticated transport, after onPayload.
          delete payload.client_metadata;
          delete payload.prompt_cache_key;
          delete payload.previous_response_id;
          payload.store = false;
          if (currentTurn.cancelled) throw new Error("Host turn was cancelled; start a new user turn");
          if (currentTurn.inFlight) throw new Error("This host turn already has an active model request");
          currentTurn.inFlight = true;
          try {
            if (!currentTurn.admitted) {
              await currentTurn.journal.admit(turnId, "model", { user: fingerprint, model: model.id });
              currentTurn.admitted = true;
            }
            await currentTurn.journal.admit(`${turnId}_context_${contextDigest}`, "model_context", { digest: contextDigest });
            const roundDigest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
            await currentTurn.journal.admit(`${turnId}_${roundDigest}`, "model_round", { digest: roundDigest });
            const client = await getClient(sessionId);
            const agentSignal = options.signal;
            if (agentSignal && !currentTurn.subscriptions.has(agentSignal)) {
              const cancel = () => {
                currentTurn.cancelled = true;
                clearTurn(currentTurn);
                void client.cancel(turnId).catch(() => {});
              };
              agentSignal.throwIfAborted();
              currentTurn.subscriptions.set(agentSignal, cancel);
              agentSignal.addEventListener("abort", cancel, { once: true });
            }
            return await client.request(turnId, payload, { signal: request.signal, headers: request.headers });
          } catch (error) {
            currentTurn.inFlight = false;
            throw error;
          }
        },
      });
      void stream.result().then(result => {
        currentTurn.inFlight = false;
        if (result.stopReason !== "toolUse") clearTurn(currentTurn);
      }, () => {
        currentTurn.inFlight = false;
        clearTurn(currentTurn);
      });
      return stream;
    },
  };
  return {
    config,
    connected: () => !closed && root.connected,
    inspectContext(sessionId = settings.sessionId) {
      const snapshot = contexts.get(sessionId);
      return snapshot ? structuredClone(snapshot) : undefined;
    },
    async inspect(sessionId = settings.sessionId) {
      if (closed) return undefined;
      const turn = turns.get(sessionId);
      const existing = clients.get(sessionId);
      if (!turn || !existing) return undefined;
      const client = await existing;
      if (closed || turns.get(sessionId) !== turn || clients.get(sessionId) !== existing) return undefined;
      const state = await client.inspectTurn(turn.id);
      if (closed || turns.get(sessionId) !== turn || clients.get(sessionId) !== existing) return undefined;
      return state;
    },
    async inspectRecovery(sessionId = settings.sessionId) {
      if (closed || !settings.sessionFile) return undefined;
      const existing = clients.get(sessionId);
      if (!existing) return undefined;
      const client = await existing;
      if (closed || clients.get(sessionId) !== existing) return undefined;
      const state = await client.inspectRecovery();
      if (closed || clients.get(sessionId) !== existing) return undefined;
      return state;
    },
    async close() {
      closed = true;
      const opened = await Promise.allSettled(clients.values());
      await Promise.allSettled(opened.map(value => value.status === "fulfilled" ? value.value.close() : undefined));
      clients.clear();
      for (const turn of turns.values()) clearTurn(turn);
      turns.clear();
      contexts.clear();
    },
  };
}
