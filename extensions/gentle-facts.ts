import { registerFactsImpact } from "../lib/facts/facts-impact-extension.ts";
import { FactsUsage, factsUsageLines } from "../lib/facts/facts-usage.ts";
import type { FileFacts } from "../lib/facts/facts-types.ts";
import { recordFactsHistory, registerFactsHistory } from "../lib/facts/facts-history-extension.ts";
import type { FactsHistoryReceipt } from "../lib/facts/facts-history.ts";
import { registerFactsCommit } from "../lib/facts/facts-commit-extension.ts";
import { FactsCursors } from "../lib/facts/facts-cursors.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFactsCard } from "../lib/facts/facts-card.ts";
import { paginationProperties } from "../lib/facts/facts-response.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { formatResolutionSummary } from "../lib/facts/facts-module-resolver.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";

export const FACTS_TOOL_QUERY = "facts_query";
export const FACTS_TOOL_DEPENDENTS = "facts_dependents";
export const FACTS_TOOL_STATUS = "facts_status";

const FACTS_WIDGET_KEY = "gentle-facts";

function showCard(ctx: ExtensionContext, service: FactsService, usage?: FactsUsage): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(FACTS_WIDGET_KEY, (tui, theme) => {
    const card = {
      render(width: number) {
        return renderFactsCard(service.getDatabase(), theme, width, { expanded: true, diagnostics: service.getDiagnostics(), usage: usage?.snapshot() });
      },
      invalidate() {},
      digest() {
        return JSON.stringify([service.getDiagnostics(), usage?.snapshot()]);
      },
    };
    return sidebarPart(tui, "facts", card);
  });
}

export default function gentleFacts(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  registerFactsHistory(pi);
  registerFactsCommit(pi);
  registerFactsImpact(pi);
  const fastPathEnabled = env.GENTLE_FACTS_DISABLE_FAST_PATH === undefined;
  const historyFailures = new Map<string, string>();
  const historyReceipts = new Map<string, FactsHistoryReceipt>();
  const cursors = new Map<string, FactsCursors>();
  const usages = new Map<string, FactsUsage>();
  const lifetimes = new Map<string, AbortController>();
  const baselines = new WeakMap<object, Array<Pick<FileFacts, "path" | "sha" | "sourceBytes">>>();

  function usageFor(cwd: string): FactsUsage {
    let usage = usages.get(cwd);
    if (!usage) {
      usage = new FactsUsage();
      usages.set(cwd, usage);
      lifetimes.set(cwd, new AbortController());
    }
    return usage;
  }

  function tracked(execute: (...args: any[]) => Promise<any>) {
    return async (...args: any[]) => {
      const ctx = args[4] as ExtensionContext;
      const usage = usageFor(ctx.cwd);
      let result: any;
      try {
        result = await execute(...args);
      } catch (error) {
        usage.record({ status: "error", returned: 0, text: "" });
        if (usages.get(ctx.cwd) === usage) showCard(ctx, getService(ctx.cwd), usage);
        throw error;
      }
      usage.record({
        status: result.details?.status ?? "error",
        returned: result.details?.returned ?? 0,
        text: result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"),
        sources: baselines.get(result),
      });
      if (usages.get(ctx.cwd) === usage) showCard(ctx, getService(ctx.cwd), usage);
      return result;
    };
  }

  function queryCursors(cwd: string): FactsCursors {
    let pool = cursors.get(cwd);
    if (!pool) {
      pool = new FactsCursors();
      cursors.set(cwd, pool);
    }
    return pool;
  }

  function generation(service: FactsService): string {
    const id = service.getGeneration();
    if (!id) throw new Error("Facts has no published generation");
    return id;
  }

  const services = new Map<string, FactsService>();

  function getService(cwd: string): FactsService {
    let service = services.get(cwd);
    if (!service) {
      service = new FactsService(cwd, undefined, { fastPath: fastPathEnabled });
      services.set(cwd, service);
    }
    return service;
  }

  async function refreshService(ctx: ExtensionContext, signal?: AbortSignal): Promise<FactsService | null> {
    const service = getService(ctx.cwd);
    const usage = usageFor(ctx.cwd);
    const lifetime = lifetimes.get(ctx.cwd)!.signal;
    signal = signal ? AbortSignal.any([signal, lifetime]) : lifetime;
    try {
      const sync = service.sync(signal, { mode: "auto" });
      showCard(ctx, service, usage);
      const result = await sync;
      signal.throwIfAborted();
      if (result.path !== "fast") {
        // Fast-path reads serve an unchanged generation; the digest cannot
        // differ from the recorded one, so history work would be redundant.
        try {
          const receipt = await recordFactsHistory(pi, ctx, service, signal);
          signal.throwIfAborted();
          if (receipt) historyReceipts.set(ctx.cwd, receipt);
          else historyReceipts.delete(ctx.cwd);
          historyFailures.delete(ctx.cwd);
        } catch (error) {
          historyReceipts.delete(ctx.cwd);
          signal?.throwIfAborted();
          historyFailures.set(ctx.cwd, error instanceof Error ? error.message : "Snapshot persistence failed");
        }
      }
      signal.throwIfAborted();
      showCard(ctx, service, usage);
      return service;
    } catch {
      signal.throwIfAborted();
      showCard(ctx, service, usage);
      return null;
    }
  }

  function unavailableResult(ctx: ExtensionContext) {
    const diagnostics = getService(ctx.cwd).getDiagnostics();
    return {
      content: [{
        type: "text" as const,
        text: `Facts are not indexed for this directory. ${diagnostics.failure?.message ?? "Retry the refresh."}`,
      }],
      details: { status: "unavailable", diagnostics },
    };
  }

  // 1. Tool: facts_query
  pi.registerTool({
    name: FACTS_TOOL_QUERY,
    label: "Facts Query",
    description: "Inspect declarations by exact symbol name or repository-relative file path, optionally combining both. Prefer this for signatures and types before reading source; inspect implementation for behavior and edits.",
    parameters: {
      type: "object",
      additionalProperties: false,
      anyOf: [{ required: ["name"] }, { required: ["file"] }],
      properties: {
        ...paginationProperties,
        file: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "Exact repository-relative source path; lists its declarations without knowing symbol names.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          description: "Name of the symbol (function, interface, class, type, or variable) to find.",
        },
        kind: {
          type: "string",
          enum: ["function", "interface", "class", "typeAlias", "enum", "variable", "constant", "all"],
          description: "Optional filter by symbol kind.",
        },
      },
    },
    execute: tracked(async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      if (params.name !== undefined && (typeof params.name !== "string" || !params.name.trim() || params.name.length > 1024)) {
        throw new Error("Invalid Facts query name");
      }
      let file: string | undefined;
      if (params.file !== undefined) {
        if (typeof params.file !== "string" || !params.file || params.file.length > 4096 ||
          /[\\\x00-\x1f]/.test(params.file) || params.file.startsWith("/") || /^[a-z]:/i.test(params.file)) {
          throw new Error("Invalid Facts query file");
        }
        file = params.file.replace(/^(?:\.\/)+/, "");
        if (file.split("/").some((part: string) => !part || part === "." || part === "..")) throw new Error("Invalid Facts query file");
      }
      if (params.name === undefined && file === undefined) throw new Error("Facts query requires name or file");
      const queryLabel = params.name ?? file;
      const key = JSON.stringify(["query", params.name ?? null, file ?? null, params.kind ?? "all"]);
      if (params.cursor) {
        if (params.offset !== undefined) throw new Error("Use cursor or offset, not both");
        const page = queryCursors(ctx.cwd).resume(params.cursor, key, params);
        const result = {
          content: [{ type: "text" as const, text: page.text }],
          details: { status: "snapshot", diagnostics: getService(ctx.cwd).getDiagnostics(), found: page.details.total, query: queryLabel, file, ...page.details },
        };
        if (page.sources) baselines.set(result, page.sources);
        return result;
      }
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const matches = service.querySymbols({ name: params.name, file });

      const filtered = params.kind && params.kind !== "all"
        ? matches.filter((m) => m.symbol.kind === params.kind)
        : matches;

      filtered.sort((a, b) => a.file.localeCompare(b.file, "en") || a.symbol.startLine - b.symbol.startLine);

      if (filtered.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No symbols found matching '${queryLabel}'. Check the spelling or run 'facts_status' to inspect indexed files.`,
          }],
          details: { status: "ready", diagnostics: service.getDiagnostics(), found: 0, query: queryLabel, file, returned: 0, nextOffset: null },
        };
      }

      const rows = filtered.map(({ file, symbol }) => {
        const doc = symbol.docstring ? `\n  Doc: ${symbol.docstring.trim()}` : "";
        return `• ${symbol.name} (${symbol.kind})\n  File: ${file} (lines ${symbol.startLine}-${symbol.endLine})\n  Signature: ${symbol.signature}${doc}`;
      });
      const database = service.getDatabase()!;
      const page = queryCursors(ctx.cwd).start(key, generation(service), rows, params, filtered.map((match) => database.files[match.file]));

      const result = {
        content: [{
          type: "text" as const,
          text: `Found ${filtered.length} symbol(s) matching '${queryLabel}':\n\n${page.text}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), found: filtered.length, query: queryLabel, file, ...page.details },
      };
      if (page.sources) baselines.set(result, page.sources);
      return result;
    }),
  });

  // 2. Tool: facts_dependents
  pi.registerTool({
    name: FACTS_TOOL_DEPENDENTS,
    label: "Facts Dependents",
    description: "Find files that import or depend on a given file or module path for safe refactoring.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        ...paginationProperties,
        transitive: {
          type: "boolean",
          description: "Include indirect consumers, with shortest dependency depth (default false).",
        },
        target: {
          type: "string",
          maxLength: 1024,
          description: "Target file path or module name to check for dependents (e.g. './calc.ts' or 'calc.ts').",
        },
      },
    },
    execute: tracked(async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      const key = JSON.stringify(["dependents", params.target, params.transitive ?? false]);
      if (params.cursor) {
        if (params.offset !== undefined) throw new Error("Use cursor or offset, not both");
        const page = queryCursors(ctx.cwd).resume(params.cursor, key, params);
        return {
          content: [{ type: "text", text: page.text }],
          details: { status: "snapshot", diagnostics: getService(ctx.cwd).getDiagnostics(), dependentsCount: page.details.total, target: params.target, ...page.details },
        };
      }
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const dependents = service.queryDependencyEvidence(params.target, { transitive: params.transitive });

      if (dependents.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No indexed direct dependencies found for '${params.target}'. Computed imports and unresolved modules require source inspection.`,
          }],
          details: { status: "ready", diagnostics: service.getDiagnostics(), dependentsCount: 0, target: params.target, returned: 0, nextOffset: null },
        };
      }

      const page = queryCursors(ctx.cwd).start(key, generation(service), dependents.map((item) => `• ${item.file} [${item.evidence}${item.resolutionNote ? ` (${item.resolutionNote})` : ""}; depth ${item.depth}; via ${item.via}]`), params);
      return {
        content: [{
          type: "text",
          text: `Files depending on '${params.target}':\n${page.text}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), dependentsCount: dependents.length, target: params.target, ...page.details },
      };
    }),
  });

  // 3. Tool: facts_status
  pi.registerTool({
    name: FACTS_TOOL_STATUS,
    label: "Facts Status",
    description: "Inspect the indexed facts and commands declared in package.json.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    execute: async (_toolCallId: string, _params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<any> => {
      const service = await refreshService(ctx, signal);
      if (!service) {
        const unavailable = unavailableResult(ctx);
        return { ...unavailable, details: { ...unavailable.details, resolution: undefined, usage: usageFor(ctx.cwd).snapshot(), historyError: historyFailures.get(ctx.cwd) } };
      }
      const block = service.getSummaryPromptBlock();
      const edges = service.getResolutionEdges();
      const resolution = {
        resolved: edges.filter((edge) => edge.evidence === "typescript").length,
        unresolved: edges.filter((edge) => edge.evidence === "unresolved").length,
      };
      const historyReceipt = historyReceipts.get(ctx.cwd);
      return {
        content: [{
          type: "text",
          text: `${block}\n${factsUsageLines(usageFor(ctx.cwd).snapshot()).join("\n")}\n${formatResolutionSummary(edges)}${historyReceipt ? `\n- Snapshot digest: ${historyReceipt.digest}` : ""}${historyFailures.has(ctx.cwd) ? "\n- History snapshot unavailable; check transcript storage permissions and retention limits." : ""}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), resolution, usage: usageFor(ctx.cwd).snapshot(), historyReceipt, historyError: historyFailures.get(ctx.cwd) },
      };
    },
  });

  // Lifecycle hooks
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    lifetimes.get(ctx.cwd)?.abort(new Error("Facts session replaced or closed"));
    lifetimes.delete(ctx.cwd);
    usages.delete(ctx.cwd);
    historyReceipts.delete(ctx.cwd);
    cursors.delete(ctx.cwd);
    await refreshService(ctx);
  });

  pi.on("before_agent_start", async (event: { systemPrompt: string }, ctx: ExtensionContext) => {
    try {
      const service = await refreshService(ctx);
      if (!service) return undefined;
      const block = service.getSummaryPromptBlock();
      if (!block) return undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\n${block}`,
      };
    } catch {
      return undefined;
    }
  });

  pi.on("tool_execution_end", async (event: { toolName: string; isError?: boolean }, ctx: ExtensionContext) => {
    if (event.isError) return;
    if (event.toolName === "write" || event.toolName === "edit" || event.toolName === "apply_diff") {
      // Lazy invalidation: mark the epoch dirty and let the next consumer pay
      // for the refresh instead of forcing duplicate full scans per edit.
      getService(ctx.cwd).markWorkspaceDirty("manual");
    }
  });

  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget(FACTS_WIDGET_KEY, undefined);
    services.get(ctx.cwd)?.close();
    services.delete(ctx.cwd);
    cursors.delete(ctx.cwd);
    lifetimes.get(ctx.cwd)?.abort(new Error("Facts session replaced or closed"));
    lifetimes.delete(ctx.cwd);
    usages.delete(ctx.cwd);
  });
}
