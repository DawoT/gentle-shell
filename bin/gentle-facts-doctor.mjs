#!/usr/bin/env node
// Facts lock doctor: report and recover stuck Facts locks.
// Classifications mirror lib/facts/facts-lock.ts recoverDeadOwner exactly.
import { classifyFactsLockDir, recoverFactsLockDir } from "../lib/facts/facts-lock-doctor.ts";
import { join } from "node:path";

const DEFAULT_STORAGE_DIRS = [".pi", join(".pi", "facts-commit-cache")];

function usage() {
  console.error("usage: node bin/gentle-facts-doctor.mjs [storageDir...] [--recovery] [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const recovery = args.includes("--recovery");
const json = args.includes("--json");
const storageDirs = args.filter((a) => !a.startsWith("--"));
if (args.some((a) => a.startsWith("--") && a !== "--recovery" && a !== "--json")) usage();
if (storageDirs.length === 0) storageDirs.push(...DEFAULT_STORAGE_DIRS);

const results = [];
for (const storageDir of storageDirs) {
  results.push(recovery ? await recoverFactsLockDir(storageDir) : await classifyFactsLockDir(storageDir));
}

const needsRecovery = results.some((r) =>
  (r.classification === "recoverable-dead" || r.classification === "corrupt-unknown" || r.classification === "empty-dir") &&
  !(recovery && "removed" in r && r.removed));

if (json) {
  console.log(JSON.stringify({ needsRecovery, results }, null, 2));
} else {
  for (const r of results) {
    const suffix = "removed" in r ? (r.removed ? " [removed]" : " [not removed]") : "";
    console.log(`${r.storageDir}: ${r.classification}${suffix}`);
  }
  if (needsRecovery && !recovery) {
    console.error("Some locks need recovery; rerun with --recovery.");
  }
}

// Exit 0 when nothing needs recovery; 1 when recovery is needed (report mode)
// or was attempted but refused (e.g. a removable-class lock survived).
const stillStuck = results.some((r) => {
  if (r.classification !== "recoverable-dead" && r.classification !== "corrupt-unknown" && r.classification !== "empty-dir") return false;
  return !recovery || !("removed" in r && r.removed);
});
process.exit(stillStuck ? 1 : 0);
