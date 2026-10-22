import assert from "node:assert/strict";
import test from "node:test";
import { parseContractFacts, isContractFile } from "../lib/facts/facts-contract-parser.ts";
import { MAX_SOURCE_BYTES, FactsLimitError } from "../lib/facts/facts-limits.ts";

const parse = (path: string, source: string) => parseContractFacts(path, Buffer.from(source, "utf8"));

test("bounded OpenAPI JSON extracts routes, schemas and serves edges", () => {
  const result = parse("spec/openapi.json", JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/pets": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { "$ref": "#/components/schemas/Pet" }
                }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        Pet: {
          type: "object",
          properties: { id: { type: "integer" } }
        }
      }
    }
  }));
  assert.deepEqual(result.entities.map((entity) => entity.kind), ["api-route", "openapi-schema"]);
  assert.equal(result.entities[0]?.name, "GET /pets");
  assert.equal(result.entities[1]?.name, "Pet");
  assert.ok(result.entityRelations.some((edge) => edge.kind === "serves" && edge.from === result.entities[0]?.id && edge.to === result.entities[1]?.id));
});

test("OpenAPI YAML and stand-alone JSON Schema parse deterministically", () => {
  const openapi = "openapi: 3.0.0\npaths:\n  /health:\n    get:\n      responses:\n        '200':\n          description: ok\ncomponents:\n  schemas:\n    Health:\n      type: object\n";
  const a = parse("api/openapi.yaml", openapi);
  assert.deepEqual(a, parse("api/openapi.yaml", openapi));
  assert.equal(a.entities.length, 2);
  const schema = parse("contracts/order.schema.json", JSON.stringify({ "$schema": "https://json-schema.org/draft/2020-12/schema", title: "Order", "$defs": { Money: { type: "number" } } }));
  assert.deepEqual(schema.entities.map((entity) => entity.kind), ["json-schema", "json-schema"]);
});

test("GraphQL SDL and protobuf declarations produce stable facts", () => {
  const graphql = parse("api/schema.graphql", "type Query { pet: Pet }\ntype Pet { id: ID! }\n");
  assert.deepEqual(graphql.entities.map((entity) => entity.name), ["Query", "Pet"]);
  assert.ok(graphql.entities.every((entity) => entity.kind === "graphql-type"));
  const protobuf = parse("api/pet.proto", "syntax = \"proto3\";\nmessage Pet { string name = 1; }\nmessage ListPetsRequest {}\n");
  assert.deepEqual(protobuf.entities.map((entity) => entity.name), ["Pet", "ListPetsRequest"]);
  assert.ok(protobuf.entities.every((entity) => entity.kind === "protobuf-message"));
});

test("SQL migrations identify tables and migration entity", () => {
  const facts = parse("db/migrations/001_pets.sql", "CREATE TABLE pets (id INTEGER PRIMARY KEY);\nALTER TABLE pets ADD COLUMN name TEXT;\n");
  assert.ok(facts.entities.some((entity) => entity.kind === "sql-table" && entity.name === "pets"));
  assert.ok(facts.entities.some((entity) => entity.kind === "sql-migration"));
});

test("byte limits and unknown extensions fail closed", () => {
  assert.equal(isContractFile("api/openapi.yaml"), true);
  assert.equal(isContractFile("lib/file.ts"), false);
  assert.deepEqual(parse("src/file.ts", "export const value = 1"), { entities: [], entityRelations: [] });
  assert.throws(() => parseContractFacts("api/openapi.json", Buffer.alloc(MAX_SOURCE_BYTES + 1)), FactsLimitError);
  assert.throws(() => parse("api/openapi.json", "{invalid"), SyntaxError);
});

test("oversized YAML only fails closed when its content is a contract", () => {
  const oversized = Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x61);
  assert.deepEqual(parseContractFacts("ci/generated-pipeline.yml", oversized), { entities: [], entityRelations: [] });
  const contractYaml = Buffer.from("openapi: 3.0.0\npaths:\n  /health:\n    get:\n      responses:\n        '200':\n          description: ok\n");
  assert.throws(
    () => parseContractFacts("api/openapi-huge.yaml", Buffer.concat([contractYaml, Buffer.alloc(MAX_SOURCE_BYTES)])),
    FactsLimitError,
  );
});

test("characterization: the same def name in different files yields distinct path-qualified entities", () => {
  // The provider-contract mirror defines a local "sha256" alias in many schema
  // files. Extraction is CORRECT: entity ids are path-qualified, so same-named
  // defs across files are distinct artifacts, not collisions. This pins that
  // invariant so a future "noise reduction" cannot silently drop defs.
  const schemaBody = (title: string) => JSON.stringify({
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    title,
    type: "object",
    "$defs": { sha256: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" } },
  });
  const first = parse("contracts/a.schema.json", schemaBody("Contract A")).entities;
  const second = parse("contracts/b.schema.json", schemaBody("Contract B")).entities;
  const names = [...first, ...second].map((entity) => entity.name);
  assert.deepEqual(names.filter((name) => name === "sha256").length, 2);
  const ids = [...first, ...second].map((entity) => entity.id);
  assert.equal(new Set(ids).size, ids.length, "entity ids must stay path-qualified and unique");
});

test("ignores lockfiles and non-contract multi-document YAML gracefully", () => {
  assert.equal(isContractFile("pnpm-lock.yaml"), false);
  assert.equal(isContractFile("sub/pnpm-lock.yaml"), false);
  assert.equal(isContractFile("package-lock.json"), false);
  assert.equal(isContractFile("yarn.lock"), false);

  const multiDocYaml = "name: doc1\n---\nname: doc2\n";
  const result = parse("docs/archive/notes.yaml", multiDocYaml);
  assert.deepEqual(result, { entities: [], entityRelations: [] });
});
