import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isContractFile, parseContractFacts } from "../lib/facts/facts-contract-parser.ts";
import { isFactsDatabase } from "../lib/facts/facts-schema.ts";
import { FACTS_DATABASE_VERSION, type EntityFact, type EntityRelation, type EntityKind } from "../lib/facts/facts-types.ts";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "contracts");

const fixtureFiles = [
  "petstore.openapi.yaml",
  "user.schema.json",
  "schema.graphql",
  "service.proto",
  "001_create_users.sql",
];

test("hermetic fixtures are recognized by isContractFile", () => {
  for (const file of fixtureFiles) {
    assert.equal(isContractFile(`contracts/${file}`), true, `Fixture ${file} must be recognized as a contract file`);
  }
});

test("parseContractFacts is strictly idempotent across repeated parses", async () => {
  for (const file of fixtureFiles) {
    const fullPath = join(FIXTURES_DIR, file);
    const buffer = await readFile(fullPath);
    const relPath = `contracts/${file}`;

    const first = parseContractFacts(relPath, buffer);
    const second = parseContractFacts(relPath, buffer);
    const third = parseContractFacts(relPath, buffer);

    assert.deepEqual(first, second, `Parse must be idempotent for ${file}`);
    assert.deepEqual(second, third, `Parse must be idempotent across multiple iterations for ${file}`);
    assert.ok(first.entities.length > 0, `Fixture ${file} must yield at least one entity`);
  }
});

test("entity facts conform to invariant properties across all fixtures", async () => {
  const validKinds = new Set<EntityKind>([
    "api-route",
    "openapi-schema",
    "json-schema",
    "graphql-type",
    "protobuf-message",
    "sql-table",
    "sql-migration",
  ]);

  for (const file of fixtureFiles) {
    const fullPath = join(FIXTURES_DIR, file);
    const buffer = await readFile(fullPath);
    const relPath = `contracts/${file}`;
    const { entities, entityRelations } = parseContractFacts(relPath, buffer);

    const ids = new Set<string>();
    for (const entity of entities) {
      assert.ok(entity.id.length > 0, "Entity ID must not be empty");
      assert.equal(ids.has(entity.id), false, `Entity ID ${entity.id} must be unique within file`);
      ids.add(entity.id);

      assert.ok(validKinds.has(entity.kind), `Entity kind ${entity.kind} must be valid`);
      assert.equal(entity.path, relPath, "Entity path must match file path");
      assert.ok(entity.name.length > 0, "Entity name must not be empty");
    }

    for (const rel of entityRelations) {
      assert.ok(["consumes", "serves", "validates"].includes(rel.kind), `Relation kind ${rel.kind} must be valid`);
      assert.ok(rel.from.length > 0, "Relation from must not be empty");
      assert.ok(rel.to.length > 0, "Relation to must not be empty");
    }
  }
});

test("facts database schema accepts full fixture catalog entities and relations", async () => {
  const allEntities: EntityFact[] = [];
  const allRelations: EntityRelation[] = [];

  for (const file of fixtureFiles) {
    const fullPath = join(FIXTURES_DIR, file);
    const buffer = await readFile(fullPath);
    const relPath = `contracts/${file}`;
    const result = parseContractFacts(relPath, buffer);
    allEntities.push(...result.entities);
    allRelations.push(...result.entityRelations);
  }

  const database = {
    version: FACTS_DATABASE_VERSION,
    root: "/repo",
    updatedAt: Date.now(),
    files: {},
    entities: allEntities,
    entityRelations: allRelations,
  };

  assert.equal(isFactsDatabase(database), true, "FactsDatabase must validate with full contract fixture catalog");
});
