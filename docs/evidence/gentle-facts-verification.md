# Gentle Facts remediation evidence

## Scope and verification

- Snapshot integrity: parsed bytes determine the cached blob hash. Tests cover edits between scan and parsing, queued syncs, separate services, separate Node processes, cancellation, and source reversion after another writer publishes.
- Extraction: generic/async/rest arrow signatures, local export aliases, declaration locations and external re-exports are covered in `tests/facts-ts-extractor.test.ts`.
- Budgets: tests cover oversized sources, aggregate source reads, path counts, cache reads/publications, named pipes, bounded pages, continuation offsets and summary metadata.
- Monorepos: nearest package, inherited manager, command directory, invalid manifests and cancellation are covered in `tests/facts-receipts-monorepo.test.ts` and the service tests.
- Diagnostics: idle/refreshing/ready/unavailable states, last successful refresh, failure hints and cache load outcomes are implemented; failure/recovery and card output have focused tests.
- Production installation: `node scripts/test-facts-packed.mjs` passed with Pi SDK 0.87.1 and gentle-pi 3.7.0. It installed production dependencies in isolation, loaded the real extension in a real SDK session, invoked all three tools, observed external edits, checked cancellation and disposed the session. No provider call was made. Install scripts were intentionally disabled.

## Gates

- Full `pnpm test`: 3,936 passed, 41 skipped, zero failures; provider-contract and runtime-harness stages passed.
- Final focused Facts suite after the last disk-reconciliation fix: 80 passed, zero failures. This includes the additional reversion regression added after the full suite started.
- `node scripts/check-types.mjs`: no regressions against the existing 188-diagnostic baseline. This is not a zero-diagnostic typecheck.
- `node scripts/build-runtime-modules.mjs --check`: passed (7 generated modules).
- `node scripts/verify-package-files.mjs`: passed (152 files, 69 byte-pinned artifacts).
- `node --check` for the new executable scripts and `git diff --check`: passed.

## Performance observations

Median elapsed milliseconds across three samples per synthetic repository, measured without the test suite running concurrently:

| Source files | Cold | Unchanged | One edited file |
| --- | --- | --- | --- |
| 25 | 49.15 | 22.03 | 23.91 |
| 250 | 116.05 | 22.60 | 32.16 |
| 2500 | 1320.72 | 108.71 | 150.80 |

The complete host details, source digest, samples and memory observations are in [gentle-facts-benchmark.json](gentle-facts-benchmark.json). Reproduce with `pnpm run benchmark:facts`. The largest fixture contains roughly 0.9 MB of TypeScript; these figures do not describe all large repositories or establish a production SLA. RSS peaks are process-wide, and heap samples occur after each phase.

## Operational limits

The source index is syntactic. It does not perform semantic type resolution, follow configured TypeScript aliases, or compute transitive consumers. File reads are individually consistent with their hashes; the entire working tree is not atomically snapshotted. Pagination refreshes between requests. A hard-killed writer can leave a lock requiring operator recovery after confirming that no writer remains. Cancellation is cooperative between bounded synchronous parsing operations, and publication is committed at the atomic rename.
