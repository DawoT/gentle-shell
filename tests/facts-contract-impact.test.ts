import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFactsImpact } from "../lib/facts/facts-impact.ts";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type EntityFact, type EntityRelation } from "../lib/facts/facts-types.ts";
import { evaluateProofValidity } from "../lib/proofs/proof-invalidation.ts";
import type { ProofRecord } from "../lib/proofs/proof-ledger.ts";

function databaseWithContracts(
  files: Record<string, string>,
  moduleEdges: Array<[string, string]>,
  entities: EntityFact[],
  entityRelations: EntityRelation[],
): FactsDatabase {
  return {
    version: FACTS_DATABASE_VERSION,
    root: "/repo",
    updatedAt: 1,
    files: Object.fromEntries(Object.entries(files).map(([path, sha]) => [path, { path, sha, symbols: [], imports: [], exports: [] }])),
    moduleEdges: moduleEdges.map(([importer, target]) => ({ importer, target, specifier: `./${target}`, evidence: "typescript" })),
    entities,
    entityRelations,
  };
}

const petRoute: EntityFact = {
  id: "api-route:api/openapi.yaml:GET /pets",
  kind: "api-route",
  name: "GET /pets",
  path: "api/openapi.yaml",
};

const petSchema: EntityFact = {
  id: "openapi-schema:api/openapi.yaml:Pet",
  kind: "openapi-schema",
  name: "Pet",
  path: "api/openapi.yaml",
};

const clientEntity: EntityFact = {
  id: "api-route:src/client.ts:fetchPets",
  kind: "api-route",
  name: "fetchPets",
  path: "src/client.ts",
};

const testEntity: EntityFact = {
  id: "api-route:tests/pets.test.ts:testPets",
  kind: "api-route",
  name: "testPets",
  path: "tests/pets.test.ts",
};

test("contract impact propagates changes across consumes, serves, and validates relations", () => {
  const relations: EntityRelation[] = [
    { from: petRoute.id, to: petSchema.id, kind: "serves" },
    { from: clientEntity.id, to: petRoute.id, kind: "consumes" },
    { from: testEntity.id, to: petRoute.id, kind: "validates" },
  ];
  const entities = [petRoute, petSchema, clientEntity, testEntity];
  const files = {
    "api/openapi.yaml": "sha1",
    "src/client.ts": "sha2",
    "tests/pets.test.ts": "sha3",
  };

  const base = databaseWithContracts(files, [], entities, relations);
  const candidate = databaseWithContracts({ ...files, "api/openapi.yaml": "sha1-modified" }, [], entities, relations);

  const impact = analyzeFactsImpact(base, candidate);
  assert.equal(impact.changedSources.length, 1);
  assert.equal(impact.changedSources[0]?.file, "api/openapi.yaml");

  const consumerFiles = impact.consumers.map((c) => c.file);
  assert.ok(consumerFiles.includes("src/client.ts"), "client consuming the contract route must be impacted");
  assert.ok(consumerFiles.includes("tests/pets.test.ts"), "test validating the contract route must be impacted");
});

test("layered invalidation reachability identifies contract dependencies", () => {
  const relations: EntityRelation[] = [
    { from: clientEntity.id, to: petRoute.id, kind: "consumes" },
  ];
  const entities = [petRoute, clientEntity];
  const db = databaseWithContracts(
    { "api/openapi.yaml": "sha1", "src/client.ts": "sha2", "src/unrelated.ts": "sha3" },
    [],
    entities,
    relations,
  );

  const impact = analyzeFactsImpact(db, { ...db, files: { ...db.files, "api/openapi.yaml": { path: "api/openapi.yaml", sha: "sha1-mod", symbols: [], imports: [], exports: [] } } });
  const reachMap = new Set(impact.consumers.map((c) => `${c.origin}->${c.file}`));

  const reaches = (from: string, to: string) => {
    if (from === to) return true;
    return reachMap.has(`${from}->${to}`);
  };

  assert.equal(reaches("api/openapi.yaml", "src/client.ts"), true);
  assert.equal(reaches("api/openapi.yaml", "src/unrelated.ts"), false);

  const proof: ProofRecord = {
    proofVersion: 1,
    seq: 1,
    fingerprint: "f".repeat(64),
    status: "passed",
    confidence: "hermetic_unit",
    sideEffects: "pure_validation",
    inputsDigest: "i".repeat(64),
    startedAt: 1000,
    finishedAt: 2000,
  };

  const verdict = evaluateProofValidity(proof, { files: { "src/client.ts": "sha2" } }, {
    changedFiles: ["api/openapi.yaml"],
    currentFileDigests: { "api/openapi.yaml": "sha1-mod", "src/client.ts": "sha2" },
    reaches,
  });

  assert.equal(verdict.valid, false);
  assert.equal(verdict.layer, "static-reachability");
});

test("FactsService indexes contracts and queries entities and relations", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { FactsService } = await import("../lib/facts/facts-service.ts");

  const dir = await mkdtemp(join(tmpdir(), "contract-service-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  try {
    await writeFile(
      join(dir, "openapi.yaml"),
      "openapi: 3.0.0\npaths:\n  /pets:\n    get:\n      responses:\n        '200':\n          description: ok\ncomponents:\n  schemas:\n    Pet:\n      type: object\n",
    );
    const service = new FactsService(dir, undefined, { fastPath: true, fastPathWatch: false });
    await service.sync();

    const entities = service.queryEntities();
    assert.equal(entities.length, 2);
    assert.ok(entities.some((e) => e.kind === "api-route" && e.name === "GET /pets"));
    assert.ok(entities.some((e) => e.kind === "openapi-schema" && e.name === "Pet"));

    const routeEntities = service.queryEntities({ kind: "api-route" });
    assert.equal(routeEntities.length, 1);
    assert.equal(routeEntities[0]?.name, "GET /pets");

    const schemaEntities = service.queryEntities({ name: "Pet" });
    assert.equal(schemaEntities.length, 1);
    assert.equal(schemaEntities[0]?.kind, "openapi-schema");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

