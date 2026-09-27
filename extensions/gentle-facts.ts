import { createHash } from "node:crypto";
import { FactsCursors } from "../lib/facts/facts-cursors.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFactsCard } from "../lib/facts/facts-card.ts";
import { paginationProperties } from "../lib/facts/facts-response.ts";
import { FactsService } from "../lib/facts/facts-service.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";

export const FACTS_TOOL_QUERY = "facts_query";
export const FACTS_TOOL_DEPENDENTS = "facts_dependents";
export const FACTS_TOOL_STATUS = "facts_status";

const FACTS_WIDGET_KEY = "gentle-facts";

function showCard(ctx: ExtensionContext, service: FactsService): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(FACTS_WIDGET_KEY, (tui, theme) => {
    const card = {
      render(width: number) {
        return renderFactsCard(service.getDatabase(), theme, width, { expanded: true, diagnostics: service.getDiagnostics() });
      },
      invalidate() {},
      digest() {
        return JSON.stringify(service.getDiagnostics());
      },
    };
    return sidebarPart(tui, "facts", card);
  });
}

export default function gentleFacts(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  const cursors = new Map<string, FactsCursors>();

  function queryCursors(cwd: string): FactsCursors {
    let pool = cursors.get(cwd);
    if (!pool) {
      pool = new FactsCursors();
      cursors.set(cwd, pool);
    }
    return pool;
  }

  function generation(service: FactsService): string {
    return createHash("sha256").update(JSON.stringify([service.getDatabase(), service.getResolutionEdges()])).digest("hex");
  }

  const services = new Map<string, FactsService>();

  function getService(cwd: string): FactsService {
    let service = services.get(cwd);
    if (!service) {
      service = new FactsService(cwd);
      services.set(cwd, service);
    }
    return service;
  }

  async function refreshService(ctx: ExtensionContext, signal?: AbortSignal): Promise<FactsService | null> {
    const service = getService(ctx.cwd);
    try {
      const sync = service.sync(signal);
      showCard(ctx, service);
      await sync;
      showCard(ctx, service);
      return service;
    } catch {
      signal?.throwIfAborted();
      showCard(ctx, service);
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
    description: "Deterministic AST query for exact symbols, signatures, interfaces, and docstrings without reading raw source files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        ...paginationProperties,
        name: {
          type: "string",
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
    execute: async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      const key = JSON.stringify(["query", params.name, params.kind ?? "all"]);
      if (params.cursor) {
        if (params.offset !== undefined) throw new Error("Use cursor or offset, not both");
        const page = queryCursors(ctx.cwd).resume(params.cursor, key, params);
        return {
          content: [{ type: "text", text: page.text }],
          details: { status: "snapshot", diagnostics: getService(ctx.cwd).getDiagnostics(), found: page.details.total, query: params.name, ...page.details },
        };
      }
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const matches = service.querySymbol(params.name);

      const filtered = params.kind && params.kind !== "all"
        ? matches.filter((m) => m.symbol.kind === params.kind)
        : matches;

      filtered.sort((a, b) => a.file.localeCompare(b.file, "en") || a.symbol.startLine - b.symbol.startLine);

      if (filtered.length === 0) {
        return {
          content: [{
            type: "text",
            text: `No symbols found matching '${params.name}'. Check the spelling or run 'facts_status' to inspect indexed files.`,
          }],
          details: { status: "ready", diagnostics: service.getDiagnostics(), found: 0, query: params.name, returned: 0, nextOffset: null },
        };
      }

      const rows = filtered.map(({ file, symbol }) => {
        const doc = symbol.docstring ? `\n  Doc: ${symbol.docstring.trim()}` : "";
        return `• ${symbol.name} (${symbol.kind})\n  File: ${file} (lines ${symbol.startLine}-${symbol.endLine})\n  Signature: ${symbol.signature}${doc}`;
      });
      const page = queryCursors(ctx.cwd).start(key, generation(service), rows, params);

      return {
        content: [{
          type: "text",
          text: `Found ${filtered.length} symbol(s) matching '${params.name}':\n\n${page.text}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), found: filtered.length, query: params.name, ...page.details },
      };
    },
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
    execute: async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
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

      const page = queryCursors(ctx.cwd).start(key, generation(service), dependents.map((item) => `• ${item.file} [${item.evidence}; depth ${item.depth}; via ${item.via}]`), params);
      return {
        content: [{
          type: "text",
          text: `Files depending on '${params.target}':\n${page.text}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), dependentsCount: dependents.length, target: params.target, ...page.details },
      };
    },
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
    execute: async (_toolCallId: string, _params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      const service = await refreshService(ctx, signal);
      if (!service) {
        const unavailable = unavailableResult(ctx);
        return { ...unavailable, details: { ...unavailable.details, resolution: undefined } };
      }
      const block = service.getSummaryPromptBlock();
      const edges = service.getResolutionEdges();
      const resolution = {
        resolved: edges.filter((edge) => edge.evidence === "typescript").length,
        unresolved: edges.filter((edge) => edge.evidence === "unresolved").length,
      };
      return {
        content: [{
          type: "text",
          text: `${block}\n- Module resolution: ${resolution.resolved} resolved, ${resolution.unresolved} unresolved (literal imports only)`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), resolution },
      };
    },
  });

  // Lifecycle hooks
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
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
      await refreshService(ctx);
    }
  });

  pi.on("session_shutdown", (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget(FACTS_WIDGET_KEY, undefined);
    services.delete(ctx.cwd);
    cursors.delete(ctx.cwd);
  });
}
