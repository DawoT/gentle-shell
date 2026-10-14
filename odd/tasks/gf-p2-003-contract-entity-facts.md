# GF-P2-003 — Sprint 6 Contract/Entity Facts
Feature branch: `feat/gf-p2-003-contract-entity-facts`.
Goal: Integrate contract/entity facts into Gentle Facts without changing existing contracts; dogfood live facts queries throughout.

## Specs

S1: "S6.1 Abstracción EntityFact: Soporte para entidades más allá de código TypeScript: rutas API, OpenAPI schemas, GraphQL types, Protobuf messages, tablas SQL y   
migraciones sin alterar contratos existentes."

S2: "S6.2 Parsers acotados: OpenAPI y JSON Schema primero, seguidos por GraphQL SDL, Protobuf y migraciones SQL con límites estrictos de bytes."

S3: "S6.3 Consultas de impacto de contratos: Relaciones consumes, serves y validates integradas con el motor de invalidación en capas de Sprint 4."

S4: "S6.4 Fixtures herméticos: Pruebas de propiedades e idempotencia sobre contratos reales."

## Tasks

- [x] T1 — S1 — Inline — Implement additive EntityFact model and persistence compatibility; commit: `feat(facts): add compatible contract entity types`. RED 1/3, GREEN 3/3, regression and typecheck exit 0.
- [x] T2 — S2 — Inline — Implement bounded contract parsers with RED/GREEN tests; commit: `feat(facts): add bounded contract entity parsers`. RED 1/5, GREEN 5/5, regression and typecheck exit 0.
- [ ] T3 — S3 — Inline — Integrate relation-aware contract impact with layered invalidation and public query; commit: pending.
- [ ] T4 — S4 — Inline — Add hermetic contract fixtures, property and idempotence tests, docs and end-to-end verification; commit: pending.

## Log

L1 — Original user request (verbatim):

proyecto de doogfooding usa en vivo el gentle facts para verificar planificar e integrar 🎯 Sprint 6 — Contract/Entity Facts (GF-P2-003) (Próximo en cola)
  
  • S6.1 Abstracción EntityFact: Soporte para entidades más allá de código TypeScript: rutas API, OpenAPI schemas, GraphQL types, Protobuf messages, tablas SQL y   
migraciones sin alterar contratos existentes.
  • S6.2 Parsers acotados: OpenAPI y JSON Schema primero, seguidos por GraphQL SDL, Protobuf y migraciones SQL con límites estrictos de bytes.
  • S6.3 Consultas de impacto de contratos: Relaciones consumes, serves y validates integradas con el motor de invalidación en capas de Sprint 4.
  • S6.4 Fixtures herméticos: Pruebas de propiedades e idempotencia sobre contratos reales.
