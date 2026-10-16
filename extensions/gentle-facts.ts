import { registerFactsImpact } from "../lib/facts/facts-impact-extension.ts";
import { FactsUsage, factsUsageLines } from "../lib/facts/facts-usage.ts";
import type { FileFacts } from "../lib/facts/facts-types.ts";
import { recordFactsHistory, registerFactsHistory } from "../lib/facts/facts-history-extension.ts";
import type { FactsHistoryReceipt } from "../lib/facts/facts-history.ts";
import { registerFactsCommit } from "../lib/facts/facts-commit-extension.ts";
import { FactsCursors } from "../lib/facts/facts-cursors.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderFactsCard } from "../lib/facts/facts-card.ts";
import { entityRows, fileImportLines, pageFacts, paginationProperties } from "../lib/facts/facts-response.ts";
import { basename, delimiter, isAbsolute } from "node:path";
import { isSourceStale, sourceStamp, syncSourceStamp } from "../lib/facts/facts-extension-stamp.ts";
import { fileURLToPath } from "node:url";
import { FactsService } from "../lib/facts/facts-service.ts";
import { formatResolutionSummary } from "../lib/facts/facts-module-resolver.ts";
import { sidebarPart } from "../lib/shell-sidebar.ts";

const EXTENSION_SOURCE = fileURLToPath(import.meta.url);
const LOADED_STAMP = syncSourceStamp(EXTENSION_SOURCE);

/** Makes extension staleness visible: the loaded source hash vs the working tree. */
async function extensionCodeLine(): Promise<string> {
	if (!(await isSourceStale(LOADED_STAMP, EXTENSION_SOURCE))) return `\n- Extension code: current (${LOADED_STAMP})`;
	const disk = await sourceStamp(EXTENSION_SOURCE).catch(() => "unavailable");
	return `\n- Extension code: STALE — the working tree changed since this session loaded the extension; /reload to pick it up (loaded ${LOADED_STAMP}, disk ${disk})`;
}

export const FACTS_TOOL_QUERY = "facts_query";
export const FACTS_TOOL_DEPENDENTS = "facts_dependents";
export const FACTS_TOOL_STATUS = "facts_status";
export const FACTS_TOOL_ENTITIES = "facts_entities";
export const FACTS_TOOL_USAGES = "facts_usages";
export const FACTS_TOOL_SEARCH = "facts_search";

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

  const impactHintsEnabled = env.GENTLE_FACTS_DISABLE_IMPACT_HINTS !== "1";
  // Cross-repo entity federation (T3.2 v1): opt-in sibling repository roots.
  const siblingRoots = (env.GENTLE_FACTS_SIBLING_ROOTS ?? "")
    .split(delimiter)
    .map((root) => root.trim())
    .filter((root) => root.length > 0 && isAbsolute(root))
    .map((root) => ({ name: basename(root), root }));
  const siblingServices = new Map<string, FactsService>();
  function siblingServiceFor(root: string): FactsService {
    let service = siblingServices.get(root);
    if (!service) {
      service = new FactsService(root);
      siblingServices.set(root, service);
    }
    return service;
  }
  const EMPTY_SHAPE_TOOLS = new Set(["facts_query", "facts_dependents", "facts_entities", "facts_usages", "facts_search"]);

  function shapeFor(toolName: string, params: any): string {
    const filters = Object.keys(params ?? {})
      .filter((key) => key !== "offset" && key !== "limit" && key !== "cursor")
      .sort();
    return filters.length > 0 ? `${toolName}(${filters.join("+")})` : toolName;
  }

  function tracked(toolName: string, execute: (...args: any[]) => Promise<any>) {
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
      const emptyShape = EMPTY_SHAPE_TOOLS.has(toolName) && (result.details?.returned ?? 0) === 0 && result.details?.status !== "error" && result.details?.status !== "unavailable"
        ? shapeFor(toolName, args[1])
        : undefined;
      usage.record({
        status: result.details?.status ?? "error",
        returned: result.details?.returned ?? 0,
        text: result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n"),
        sources: baselines.get(result),
        ...(emptyShape ? { shape: emptyShape } : {}),
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
          description: "Exact repository-relative source path; lists its declarations without knowing symbol names. File-mode responses append a bounded resolved/unresolved imports section.",
        },
        name: {
          type: "string",
          minLength: 1,
          maxLength: 1024,
          description: "Name of the symbol (function, interface, class, type, or variable) to find. Qualified class members (Class.member) project the member signature; line ranges cover the owning declaration.",
        },
        kind: {
          type: "string",
          enum: ["function", "interface", "class", "typeAlias", "enum", "variable", "constant", "all"],
          description: "Optional filter by symbol kind.",
        },
      },
    },
    execute: tracked("facts_query", async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
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

      const importLines = file ? fileImportLines(file, database.files[file]?.imports ?? [], service.getResolutionEdges()) : [];
      const result = {
        content: [{
          type: "text" as const,
          text: `Found ${filtered.length} symbol(s) matching '${queryLabel}':\n\n${page.text || `No rows at this offset; ${filtered.length} total match${filtered.length === 1 ? "" : "es"}. Restart with offset=0.`}${importLines.length ? `\n\n${importLines.join("\n")}` : ""}`,
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
    execute: tracked("facts_dependents", async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
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
          text: `${block}\n${factsUsageLines(usageFor(ctx.cwd).snapshot()).join("\n")}\n${formatResolutionSummary(edges)}${historyReceipt ? `\n- Snapshot digest: ${historyReceipt.digest}` : ""}${historyFailures.has(ctx.cwd) ? "\n- History snapshot unavailable; check transcript storage permissions and retention limits." : ""}${await extensionCodeLine()}`,
        }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), resolution, usage: usageFor(ctx.cwd).snapshot(), historyReceipt, historyError: historyFailures.get(ctx.cwd) },
      };
    },
  });

  // Tool: facts_entities
  pi.registerTool({
    name: FACTS_TOOL_ENTITIES,
    label: "Facts Entities",
    description: "Search contract entities (routes, schemas, tables, messages) extracted from indexed contract files by exact name, path or kind.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...paginationProperties,
        name: {
          type: "string",
          maxLength: 1024,
          description: "Exact entity name (case-insensitive).",
        },
        path: {
          type: "string",
          maxLength: 4096,
          description: "Repository-relative contract file path.",
        },
        kind: {
          type: "string",
          enum: ["api-route", "openapi-schema", "json-schema", "graphql-type", "protobuf-message", "sql-table", "sql-migration", "consumer", "test"],
          description: "Optional entity kind filter.",
        },
      },
    },
    execute: tracked("facts_entities", async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      if (params.name !== undefined && (typeof params.name !== "string" || !params.name.trim() || params.name.length > 1024)) {
        throw new Error("Invalid Facts entities name");
      }
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const filters = {
        name: typeof params.name === "string" ? params.name : undefined,
        path: typeof params.path === "string" ? params.path : undefined,
        kind: typeof params.kind === "string" ? params.kind : undefined,
      };
      const entities = service.queryEntities(filters);
      const rows = entities.length > 0
        ? entityRows(entities, service.queryEntities(), service.queryEntityRelations({}))
        : [];
      const page = rows.length > 0 ? pageFacts(rows, params, (row) => row) : null;
      let text = entities.length > 0
        ? `Found ${entities.length} contract entit${entities.length === 1 ? "y" : "ies"}:\n\n${page!.text}`
        : "No matching contract entities found. Contract entities are extracted from indexed contract files (OpenAPI, JSON Schema, GraphQL, protobuf, SQL).";
      let found = entities.length;
      for (const sibling of siblingRoots) {
        try {
          const siblingService = siblingServiceFor(sibling.root);
          await siblingService.sync(signal);
          const siblingEntities = siblingService.queryEntities(filters);
          if (siblingEntities.length === 0) continue;
          const siblingRows = entityRows(siblingEntities, siblingService.queryEntities(), siblingService.queryEntityRelations({}))
            .slice(0, typeof params.limit === "number" ? params.limit : 50)
            .map((row) => row.replace("• ", `• [${sibling.name}] `));
          text += `\n\n[sibling ${sibling.name}] ${siblingEntities.length} matches:\n${siblingRows.join("\n")}`;
          found += siblingEntities.length;
        } catch {
          // Siblings are advisory: skip unreachable roots.
        }
      }
      return {
        content: [{ type: "text", text }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), found, ...page?.details },
      };
    }),
  });

  // Tool: facts_usages
  pi.registerTool({
    name: FACTS_TOOL_USAGES,
    label: "Facts Usages",
    description: "Find files referencing a symbol by exact name (usage sites), with whether they import its declaring file. Files without recorded references are not reported.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        ...paginationProperties,
        name: {
          type: "string",
          maxLength: 1024,
          description: "Exact symbol name (case-sensitive).",
        },
      },
    },
    execute: tracked("facts_usages", async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      if (typeof params.name !== "string" || params.name.trim().length === 0 || params.name.length > 1024) {
        throw new Error("Invalid Facts usages name");
      }
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const sites = service.queryUsageSites(params.name);
      if (sites.length === 0) {
        return {
          content: [{ type: "text", text: `No usage sites found for '${params.name}'. Files without recorded references are not reported.` }],
          details: { status: "ready", diagnostics: service.getDiagnostics(), found: 0, returned: 0, nextOffset: null },
        };
      }
      const rows = sites.map((site) => `• ${site.file}${site.importsDeclaration ? " (imports the declaring file)" : " (references without recorded import)"}`);
      const page = pageFacts(rows, params, (row) => row);
      return {
        content: [{ type: "text", text: `Found ${sites.length} usage site${sites.length === 1 ? "" : "s"} for '${params.name}':\n\n${page.text}` }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), found: sites.length, ...page.details },
      };
    }),
  });

  // Tool: facts_search
  pi.registerTool({
    name: FACTS_TOOL_SEARCH,
    label: "Facts Search",
    description: "Fuzzy lexical discovery across indexed symbols, paths, docstrings and contract entities (exact, prefix, token and trigram matching), including configured sibling repositories.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          maxLength: 1024,
          description: "Fuzzy query text.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum results per root (default 20).",
        },
      },
    },
    execute: tracked("facts_search", async (_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
      signal?.throwIfAborted();
      if (typeof params.query !== "string" || params.query.trim().length === 0 || params.query.length > 1024) {
        throw new Error("Invalid Facts search query");
      }
      const limit = typeof params.limit === "number" && params.limit >= 1 ? params.limit : 20;
      const service = await refreshService(ctx, signal);
      if (!service) return unavailableResult(ctx);
      const matches = service.searchSymbols(params.query, { limit });
      const rows = matches.map((match) => {
        const label = match.name ?? match.match.slice(0, 200);
        return `• [${match.kind}] ${label} — ${match.file} (score ${match.score})`;
      });
      let text = matches.length > 0
        ? `Found ${matches.length} matches for '${params.query}':\n\n${rows.join("\n")}`
        : `No matches found for '${params.query}'.`;
      for (const sibling of siblingRoots) {
        try {
          const siblingService = siblingServiceFor(sibling.root);
          await siblingService.sync(signal);
          const siblingMatches = siblingService.searchSymbols(params.query, { limit });
          if (siblingMatches.length === 0) continue;
          const siblingRows = siblingMatches.map((match) => {
            const label = match.name ?? match.match.slice(0, 200);
            return `• [${sibling.name}] [${match.kind}] ${label} — ${match.file} (score ${match.score})`;
          });
          text += `\n\n[sibling ${sibling.name}] ${siblingMatches.length} matches:\n${siblingRows.join("\n")}`;
        } catch {
          // Siblings are advisory: skip unreachable roots.
        }
      }
      return {
        content: [{ type: "text", text }],
        details: { status: "ready", diagnostics: service.getDiagnostics(), found: matches.length, returned: matches.length, nextOffset: null },
      };
    }),
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

  const pendingToolPaths = new Map<string, string>();

  pi.on("tool_execution_start", (event: { toolCallId: string; toolName: string; args?: any }) => {
    if (!impactHintsEnabled) return;
    const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
    const candidate = [args.path, args.file_path, args.filePath].find((value) => typeof value === "string" && value.length > 0);
    if (typeof candidate !== "string") return;
    if (pendingToolPaths.size >= 200) {
      const oldest = pendingToolPaths.keys().next().value;
      if (oldest !== undefined) pendingToolPaths.delete(oldest);
    }
    pendingToolPaths.set(event.toolCallId, candidate);
  });

  function appendImpactHint(ctx: ExtensionContext, toolCallId: string): void {
    try {
      const file = pendingToolPaths.get(toolCallId);
      pendingToolPaths.delete(toolCallId);
      if (file === undefined) return;
      const service = services.get(ctx.cwd);
      if (!service || service.getDatabase() === null) return;
      const dependents = service.queryDependencyEvidence(file, { transitive: true }).length;
      pi.appendEntry("gentle-facts-impact-hint", {
        text: `Impact hint: '${file}' — ${dependents} dependents (facts, advisory)`,
        file,
      });
    } catch {
      // Advisory only: a hint must never fail the tool execution.
    }
  }

  pi.on("tool_execution_end", async (event: { toolCallId?: string; toolName: string; isError?: boolean }, ctx: ExtensionContext) => {
    if (event.isError) return;
    if (impactHintsEnabled && (event.toolName === "write" || event.toolName === "edit" || event.toolName === "apply_diff")) {
      appendImpactHint(ctx, event.toolCallId ?? "");
    }
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
