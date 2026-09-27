#!/usr/bin/env node
import { FactsMcpServer } from "../lib/facts/facts-mcp-server.ts";

let workspace = process.cwd();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) {
    workspace = args[i + 1];
    i++;
  }
}

const server = new FactsMcpServer(workspace, process.stdin, process.stdout);
server.start();
