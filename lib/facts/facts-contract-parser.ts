import path from "node:path";
import { parse as parseYaml } from "yaml";
import { MAX_SOURCE_BYTES, FactsLimitError } from "./facts-limits.ts";
import type { EntityFact, EntityRelation, EntityKind } from "./facts-types.ts";

export interface ParsedContractFacts {
  entities: EntityFact[];
  entityRelations: EntityRelation[];
}

export function isContractFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".yaml") || normalized.endsWith(".yml")) {
    return true;
  }
  if (normalized.endsWith(".schema.json")) {
    return true;
  }
  if (normalized.endsWith(".json") && (normalized.includes("openapi") || normalized.includes("swagger"))) {
    return true;
  }
  if (normalized.endsWith(".graphql") || normalized.endsWith(".gql")) {
    return true;
  }
  if (normalized.endsWith(".proto")) {
    return true;
  }
  if (normalized.endsWith(".sql")) {
    return true;
  }
  return false;
}

function entityId(kind: EntityKind, filePath: string, name: string): string {
  return `${kind}:${filePath}:${name}`;
}

function parseOpenApiFacts(filePath: string, data: Record<string, any>): ParsedContractFacts {
  const entities: EntityFact[] = [];
  const entityRelations: EntityRelation[] = [];

  const schemas = data.components?.schemas ?? data.definitions ?? {};
  const schemaEntitiesMap = new Map<string, EntityFact>();

  const paths = data.paths ?? {};
  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    const methods = ["get", "post", "put", "delete", "patch", "options", "head"];
    for (const method of methods) {
      const operation = (pathItem as Record<string, any>)[method];
      if (typeof operation !== "object" || operation === null) continue;

      const name = `${method.toUpperCase()} ${routePath}`;
      const routeEntity: EntityFact = {
        id: entityId("api-route", filePath, name),
        kind: "api-route",
        name,
        path: filePath,
      };
      entities.push(routeEntity);

      // Search for $ref in responses or request body
      const operationStr = JSON.stringify(operation);
      const refMatches = operationStr.matchAll(/"\$ref"\s*:\s*"([^"]+)"/g);
      for (const match of refMatches) {
        const ref = match[1];
        if (ref) {
          const refName = ref.split("/").pop();
          if (refName) {
            entityRelations.push({
              from: routeEntity.id,
              to: entityId("openapi-schema", filePath, refName),
              kind: "serves",
            });
          }
        }
      }
    }
  }

  for (const [schemaName] of Object.entries(schemas)) {
    const schemaEntity: EntityFact = {
      id: entityId("openapi-schema", filePath, schemaName),
      kind: "openapi-schema",
      name: schemaName,
      path: filePath,
    };
    entities.push(schemaEntity);
    schemaEntitiesMap.set(schemaName, schemaEntity);
  }

  return { entities, entityRelations };
}

function parseJsonSchemaFacts(filePath: string, data: Record<string, any>): ParsedContractFacts {
  const entities: EntityFact[] = [];
  if (typeof data.title === "string" && data.title.length > 0) {
    entities.push({
      id: entityId("json-schema", filePath, data.title),
      kind: "json-schema",
      name: data.title,
      path: filePath,
    });
  }
  const defs = data.$defs ?? data.definitions ?? {};
  if (typeof defs === "object" && defs !== null) {
    for (const [defName] of Object.entries(defs)) {
      entities.push({
        id: entityId("json-schema", filePath, defName),
        kind: "json-schema",
        name: defName,
        path: filePath,
      });
    }
  }
  return { entities, entityRelations: [] };
}

function parseGraphQLFacts(filePath: string, text: string): ParsedContractFacts {
  const entities: EntityFact[] = [];
  const regex = /(?:type|interface|union|input|enum|scalar)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1]!;
    entities.push({
      id: entityId("graphql-type", filePath, name),
      kind: "graphql-type",
      name,
      path: filePath,
    });
  }
  return { entities, entityRelations: [] };
}

function parseProtobufFacts(filePath: string, text: string): ParsedContractFacts {
  const entities: EntityFact[] = [];
  const regex = /(?:message)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1]!;
    entities.push({
      id: entityId("protobuf-message", filePath, name),
      kind: "protobuf-message",
      name,
      path: filePath,
    });
  }
  return { entities, entityRelations: [] };
}

function parseSqlFacts(filePath: string, text: string): ParsedContractFacts {
  const entities: EntityFact[] = [];
  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"']?[a-zA-Z0-9_]+[`"']?\.)?[`"']?([a-zA-Z0-9_]+)[`"']?/gi;
  let match: RegExpExecArray | null;
  const seenTables = new Set<string>();
  while ((match = tableRegex.exec(text)) !== null) {
    const name = match[1]!;
    if (!seenTables.has(name)) {
      seenTables.add(name);
      entities.push({
        id: entityId("sql-table", filePath, name),
        kind: "sql-table",
        name,
        path: filePath,
      });
    }
  }

  const normalized = filePath.toLowerCase();
  if (normalized.includes("migration") || normalized.includes("migrations")) {
    const baseName = path.basename(filePath, path.extname(filePath));
    entities.push({
      id: entityId("sql-migration", filePath, baseName),
      kind: "sql-migration",
      name: baseName,
      path: filePath,
    });
  }

  return { entities, entityRelations: [] };
}

export function parseContractFacts(filePath: string, buffer: Buffer): ParsedContractFacts {
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new FactsLimitError(`Facts byte limit (${MAX_SOURCE_BYTES}) exceeded: ${filePath}`);
  }

  if (!isContractFile(filePath)) {
    return { entities: [], entityRelations: [] };
  }

  const text = buffer.toString("utf8");
  const normalized = filePath.toLowerCase();

  if (normalized.endsWith(".yaml") || normalized.endsWith(".yml")) {
    const data = parseYaml(text);
    if (typeof data === "object" && data !== null) {
      if (data.openapi || data.swagger || data.paths) {
        return parseOpenApiFacts(filePath, data);
      }
      if (data.$schema || data.$defs || data.definitions || data.title) {
        return parseJsonSchemaFacts(filePath, data);
      }
    }
    return { entities: [], entityRelations: [] };
  }

  if (normalized.endsWith(".json")) {
    const data = JSON.parse(text);
    if (typeof data === "object" && data !== null) {
      if (data.openapi || data.swagger || data.paths) {
        return parseOpenApiFacts(filePath, data);
      }
      if (data.$schema || data.$defs || data.definitions || data.title || normalized.endsWith(".schema.json")) {
        return parseJsonSchemaFacts(filePath, data);
      }
    }
    return { entities: [], entityRelations: [] };
  }

  if (normalized.endsWith(".graphql") || normalized.endsWith(".gql")) {
    return parseGraphQLFacts(filePath, text);
  }

  if (normalized.endsWith(".proto")) {
    return parseProtobufFacts(filePath, text);
  }

  if (normalized.endsWith(".sql")) {
    return parseSqlFacts(filePath, text);
  }

  return { entities: [], entityRelations: [] };
}
