# gentle-proofs: execution proof ledger over MCP

The standalone Proofs server exposes the Execution Proof Ledger (per-generation
immutable artifacts under `.pi/proofs`) over stdio, plus a coverage reverse
query over recorded V8 runtime observations. Register it the same way as
`gentle_facts`:

```toml
[mcp_servers.gentle_proofs]
command = "node"
args = ["--experimental-strip-types", "/absolute/path/to/gentle-shell/bin/gentle-proofs-mcp.mjs", "--ledger-root", "/absolute/path/to/workspace/.pi/proofs"]
cwd = "/absolute/path/to/workspace"
```

`--ledger-root` defaults to `<workspace>/.pi/proofs` and is populated by
proof-aware verification runs (`GENTLE_PROOFS=1 node scripts/run-test-suite.mjs`).

## Tools

### `proof_query`
Lists recent execution proofs newest-first without exposing commands or secrets.

```json
// Tool Call
{ "name": "proof_query", "arguments": { "limit": 5 } }

// Result rows
- fingerprint: 10cf74dbba1a... | status: passed | age: 2m | confidence: hermetic_static
```

### `proof_status`
Explains one proof: full fingerprint, status, age, confidence class, side-effect
classification, inputs digest, exact stored lifecycle reason, allowed
transitions, and re-verification guidance. Accepts a full fingerprint or an
unambiguous prefix (as printed by `proof_query`).

```json
{ "name": "proof_status", "arguments": { "fingerprint": "10cf74dbba1a" } }
```

### `proof_coverage`
Lists the stored proofs whose recorded V8 runtime observation covers a
repository-relative file — "which verification runs exercised this file?".
Uncovered files are answered explicitly.

```json
{ "name": "proof_coverage", "arguments": { "file": "lib/math.ts" } }
```

### `proof_invalidate`
Marks one proof invalidated with a required non-empty reason (full 64-character
fingerprint). The next proof-aware verification run re-executes the affected
work; invalidation is evidence, never silent.

`proof_invalidate` mutates ledger state — prefer the explicit operator decision
it documents over routine use.
