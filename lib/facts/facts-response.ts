import { classifyUnresolvedSpecifier, type FactsModuleEdge } from "./facts-module-resolver.ts";
import type { EntityFact, EntityRelation } from "./facts-types.ts";

export const paginationProperties = {
  cursor: {
    type: "string",
    maxLength: 128,
    description: "Continue an immutable result using nextCursor. Repeat the original query and filters; omit offset. Expires after five minutes or retention eviction.",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "Result offset. Use nextOffset from the previous response.",
  },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 50,
    description: "Maximum results per page (default 50). The response budget may reduce this.",
  },
};

interface PageOptions {
  offset?: number;
  limit?: number;
}

/**
 * Renders a name-lookup row as `file:startLine-endLine` followed by the signature.
 * Defensive for historical snapshots: a missing or invalid endLine (non-integer,
 * NaN, or before startLine) falls back to rendering the start line only.
 */
export function symbolRow(filePath: string, symbol: { startLine: number; endLine: number; signature: string }): string {
  const location = Number.isSafeInteger(symbol.endLine) && symbol.endLine >= symbol.startLine
    ? `${filePath}:${symbol.startLine}-${symbol.endLine}`
    : `${filePath}:${symbol.startLine}`;
  return `${location}\n${symbol.signature}`;
}

export function pageFacts<T>(items: T[], options: PageOptions, format: (item: T) => string) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("offset must be a nonnegative integer and limit must be between 1 and 50");
  }
  const rows: string[] = [];
  let characters = 0;
  let truncated = false;
  for (const item of items.slice(offset, offset + limit)) {
    const full = format(item);
    const shortened = full.length > 6500;
    const row = shortened
      ? `${full.slice(0, 6400)}\n[Truncated: inspect the source for the complete declaration.]`
      : full;
    if (characters + row.length + 2 > 14500) break;
    rows.push(row);
    characters += row.length + 2;
    truncated ||= shortened;
  }
  const nextOffset = offset + rows.length < items.length ? offset + rows.length : null;
  const continuation = nextOffset === null ? "" : `\n\nMore results: repeat with offset=${nextOffset}.`;
  return {
    text: rows.join("\n\n") + continuation,
    details: {
      returned: rows.length,
      nextOffset,
      truncated,
    },
  };
}

/**
 * Renders the bounded resolved/unresolved import section for file-mode
 * queries. Resolution evidence comes from the module snapshot; declared
 * specifiers without a resolved edge are classified by shape so agents see
 * why an import could not be followed without opening the file. Shared by
 * the MCP server and the session extension so both transports answer file
 * queries identically.
 */
export function fileImportLines(file: string, imports: readonly string[], edges: readonly FactsModuleEdge[]): string[] {
	const bySpecifier = new Map(edges.filter((edge) => edge.importer === file).map((edge) => [edge.specifier, edge]));
	const resolved: string[] = [];
	const unresolved: string[] = [];
	for (const specifier of imports) {
		const edge = bySpecifier.get(specifier);
		if (edge?.target && edge.evidence !== "unresolved") resolved.push(`  → ${edge.target} (from "${specifier}")`);
		else unresolved.push(`  → "${specifier}" [unresolved: ${classifyUnresolvedSpecifier(specifier)}]`);
	}
	const total = resolved.length + unresolved.length;
	if (total === 0) return [];
	const cap = 20;
	const rows = [`imports (${resolved.length} resolved / ${unresolved.length} unresolved${total > cap ? `; first ${cap}` : ""}):`];
	rows.push(...[...resolved, ...unresolved].slice(0, cap));
	if (total > cap) rows.push(`  …and ${total - cap} more`);
	return rows;
}

/**
 * Renders contract entity rows including the relations touching each
 * entity, so one entity query answers "what does this route serve?" without
 * a second call. Outgoing relations render as "kind → other" and incoming
 * as "kind ← other", capped per entity to keep rows bounded. Shared by the
 * MCP server and the session extension.
 */
export function entityRows(
	entities: readonly EntityFact[],
	allEntities: readonly EntityFact[],
	relations: readonly EntityRelation[],
): string[] {
	const nameById = new Map(allEntities.map((entity) => [entity.id, entity.name] as const));
	const touching = new Map<string, string[]>();
	for (const relation of relations) {
		const fromName = nameById.get(relation.from) ?? relation.from;
		const toName = nameById.get(relation.to) ?? relation.to;
		const outgoing = touching.get(relation.from) ?? [];
		outgoing.push(`${relation.kind} → ${toName}`);
		touching.set(relation.from, outgoing);
		const incoming = touching.get(relation.to) ?? [];
		incoming.push(`${relation.kind} ← ${fromName}`);
		touching.set(relation.to, incoming);
	}
	const cap = 4;
	return entities.map((entity) => {
		const base = `• [${entity.kind}] ${entity.name} — ${entity.path}${typeof entity.line === "number" ? `:${entity.line}` : ""}`;
		const rels = touching.get(entity.id);
		if (!rels || rels.length === 0) return base;
		return `${base}\n    relations (${rels.length}): ${rels.slice(0, cap).join("; ")}${rels.length > cap ? ` …+${rels.length - cap} more` : ""}`;
	});
}
