# Facts evidence index — implementation contract

## Decision and scope

Extend the existing Facts feature into a versioned evidence index. Preserve the existing tools and the preceding uncommitted remediation. This work is R2 × L because it includes shared publication, worker cancellation and lock recovery; the module-resolution subtask is R1 × M.

Required deliverables:

1. Resolve local modules using project TypeScript configuration; expose resolution evidence and unresolved edges, plus transitive impact queries without claiming full semantic typechecking.
2. Publish immutable generations with bounded consistency validation; support reproducible indexing of a specific commit.
3. Bind pagination cursors to an immutable query result/generation with explicit expiration, bounded retention and no silent fallback to fresh results.
4. Store reusable facts per file and avoid rewriting the entire source inventory for one changed file; preserve safe publication and bounded storage.
5. Parse in cancellable workers, recover orphaned locks only with verified owner death, and retain conservative fallback where process identity cannot be verified.
6. Measure diverse workloads (large sources, dense symbols, packages, mass edits), validate the production-installed package, and document evidence and limitations.

## Acceptance and sequencing

Implement independent module resolution and cursor mechanics first, then integrate generations, storage and workers. Each significant behavior requires an observed failing test followed by passing focused and integration tests. Re-run package installation when runtime loading changes. Keep tests for the preceding behavior unless the contract intentionally changes it.

## Review and isolation

The available collaboration harness shares filesystem access and does not expose a verified per-agent write-denial mechanism. Agent identities provide independent review, not physical isolation. SHS option (c) applies: concurrency changes require human review before merge in addition to independent agent review. Implementation and local verification may continue. Do not invent approval signatures or claim this gate passed. No merge, deployment or publication is part of this authorization.

## Compatibility

Existing offset queries remain supported as fresh queries. New cursor continuations retain their original results. Limits and incomplete resolution must be visible. Unknown dynamic imports must never be reported as resolved. A newer schema may rebuild disposable caches; repository source files remain untouched.

## Progress — query evidence and cursors

Implemented query-result snapshots with five-minute expiration, 8 MiB retention and 128-entry retention limits. `nextCursor` binds the original query/filter set and result generation; continuations do not refresh or silently substitute new data. Existing `offset` requests remain fresh queries. Snapshot identifiers currently hash the in-memory database and resolved edges; they are not yet persistent disk generations.

Module resolution now uses TypeScript configuration (nearest config, extends, aliases, project references). `facts_dependents` supports `transitive` and labels each result with resolution evidence, depth and immediate predecessor. `facts_status` reports resolved and unresolved literal edge counts. This does not imply typechecking or complete discovery of dynamic imports. Resolver metadata IO remains synchronous and is a pending worker/budget integration concern.

Observed RED/GREEN: missing cursor module; mutation during paging; mismatched/expired/evicted cursor; aliases absent from service queries; transitive evidence absent from tool response; unresolved coverage absent from status. Tests are in facts-cursors, facts-module-resolver, facts-store and facts-extension.

Open: persistent generations and consistency validation; commit-pinned mode; file-granular storage; cancellable worker integration with metadata budgets; safe owner-death recovery; expanded performance and final package evidence. Prior remediation evidence in docs/evidence predates this evolution and must not be presented as final verification of these changes.
