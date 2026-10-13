import assert from "node:assert/strict";
import test from "node:test";
import { isFactsDatabase } from "../lib/facts/facts-schema.ts";
import { FACTS_DATABASE_VERSION } from "../lib/facts/facts-types.ts";

const legacy = {
  version: FACTS_DATABASE_VERSION,
  root: "/repo",
  updatedAt: 1,
  files: {},
};

const route = {
  id: "api:openapi.yaml:GET:/pets",
  kind: "api-route",
  name: "GET /pets",
  path: "openapi.yaml",
};
const schema = {
  id: "schema:openapi.yaml:Pet",
  kind: "openapi-schema",
  name: "Pet",
  path: "openapi.yaml",
};
const edge = {
  from: route.id,
  to: schema.id,
  kind: "serves",
};

test("EntityFact extension preserves legacy FactsDatabase compatibility", () => {
  assert.equal(isFactsDatabase(legacy), true);
  assert.equal(isFactsDatabase({ ...legacy, entities: [route, schema], entityRelations: [edge] }), true);
});

test("EntityFact validates known entity kinds and required identity fields", () => {
  const validKinds = ["api-route", "openapi-schema", "json-schema", "graphql-type", "protobuf-message", "sql-table", "sql-migration"];
  for (const kind of validKinds) {
    assert.equal(isFactsDatabase({ ...legacy, entities: [{ ...route, kind }] }), true, kind);
  }
  assert.equal(isFactsDatabase({ ...legacy, entities: [{ ...route, kind: "unknown" }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entities: [{ ...route, id: "" }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entities: [{ ...route, path: 7 }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entities: "not-an-array" }), false);
  assert.equal(isFactsDatabase({ ...legacy, entities: [route, route] }), false);
});

test("EntityFact validates consumes, serves and validates relations", () => {
  for (const kind of ["consumes", "serves", "validates"]) {
    assert.equal(isFactsDatabase({ ...legacy, entityRelations: [{ ...edge, kind }] }), true, kind);
  }
  assert.equal(isFactsDatabase({ ...legacy, entityRelations: [{ ...edge, kind: "imports" }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entityRelations: [{ ...edge, from: "" }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entityRelations: [{ ...edge, to: 42 }] }), false);
  assert.equal(isFactsDatabase({ ...legacy, entityRelations: {} }), false);
});
