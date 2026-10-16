#!/usr/bin/env node
import { basename } from "node:path";
import { FactsMcpServer } from "../lib/facts/facts-mcp-server.ts";
import { FactsMcpMemoryBinding } from "../lib/facts/facts-mcp-memory-binding.ts";

let workspace = process.cwd();
let sessionFile;
let leafId;
const siblings = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) {
    workspace = args[i + 1];
    i++;
  }
  if (args[i] === "--sibling-root" && args[i + 1]) {
    const root = args[++i];
    siblings.push({ name: basename(root), root });
  }
  if (args[i] === "--session-file" && args[i + 1]) {
    sessionFile = args[++i];
  } else if (args[i] === "--leaf-id" && args[i + 1]) {
    leafId = args[++i];
  }
}

if (Boolean(sessionFile) !== Boolean(leafId)) {
  throw new Error("Bound memory requires both --session-file and --leaf-id");
}
const binding = sessionFile && leafId
  ? await FactsMcpMemoryBinding.open(workspace, sessionFile, leafId)
  : undefined;
const server = new FactsMcpServer(workspace, process.stdin, process.stdout, binding, siblings);
server.start();
