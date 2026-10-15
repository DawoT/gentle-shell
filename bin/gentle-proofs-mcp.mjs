#!/usr/bin/env node
import { resolve } from "node:path";
import { createProofMcpServer } from "../lib/proofs/proof-mcp-server.ts";

let workspace = process.cwd();
let ledgerRoot = process.env.GENTLE_PROOF_LEDGER_ROOT;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--workspace") {
    const value = args[++index];
    if (!value) throw new Error("--workspace requires a path");
    workspace = resolve(value);
  } else if (arg === "--ledger-root") {
    const value = args[++index];
    if (!value) throw new Error("--ledger-root requires a path");
    ledgerRoot = resolve(value);
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

const resolvedLedgerRoot = ledgerRoot ? resolve(ledgerRoot) : resolve(workspace, ".pi", "proofs");
createProofMcpServer({ ledgerRoot: resolvedLedgerRoot }).start();
