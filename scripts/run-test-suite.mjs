#!/usr/bin/env node
// Sequential test-suite runner for `pnpm test` (gentle-pi#1285).
//
// `pnpm test` used to chain its three stages with `&&`, so any stage-1
// failure — including a known-flaky unit test — silently suppressed the
// provider-contract check and the runtime harness while reporting a plain
// "test failed". This runner executes every stage unconditionally, prints a
// per-stage header and a final summary, and exits non-zero when any stage
// fails. Stages are plain shell commands, so behavior stays identical on
// POSIX and Windows CI.

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeTreeDigest } from "../lib/proofs/proof-harness.ts";

export const DEFAULT_STAGES = Object.freeze([
	{ name: "unit-tests", command: "node --experimental-strip-types --test tests/*.test.ts" },
	{ name: "provider-contract", command: "pnpm run check:provider-contract" },
	{ name: "runtime-harness", command: "pnpm run test:harness" },
]);

export async function runStage(stage) {
	return await new Promise((resolve) => {
		const child = spawn(stage.command, { shell: true, stdio: "inherit" });
		child.on("close", (code) => resolve({ name: stage.name, code: code ?? 1 }));
		child.on("error", (error) => {
			console.error(`\n[${stage.name}] spawn failed: ${error.message}`);
			resolve({ name: stage.name, code: 1 });
		});
	});
}

export async function runTestSuite(stages = DEFAULT_STAGES, { runStageImpl = runStage, write = (line) => console.log(line), proofs } = {}) {
	const results = [];
	let layer;
	if (proofs) {
		// Opt-in proof-aware mode (GENTLE_PROOFS): reuse per-stage proofs while
		// the tree digest is unchanged. Any failure to load the layer degrades
		// to the plain sequential runner.
		try {
			const [{ createStageProofLayer }, { ProofLedger }] = await Promise.all([
				import("../lib/proofs/proof-harness.ts"),
				import("../lib/proofs/proof-ledger.ts"),
			]);
			layer = createStageProofLayer({ ledger: new ProofLedger(proofs.ledgerRoot), treeDigest: proofs.treeDigest, agent: proofs.agent });
		} catch (error) {
			write(`[proofs] layer unavailable (${error instanceof Error ? error.message : error}); running all stages`);
		}
	}
	for (const stage of stages) {
		if (layer) {
			const decision = await layer.shouldExecute(stage);
			if (!decision.execute) {
				write(`REUSED [${stage.name}] ${decision.reason}`);
				results.push({ name: stage.name, code: 0, reused: true });
				continue;
			}
		}
		write(`\n=== [${stage.name}] ${stage.command} ===`);
		const result = await runStageImpl(stage);
		if (layer) {
			await layer.recordResult(stage, result.code).catch((error) => write(`[proofs] could not record proof for ${stage.name}: ${error.message}`));
		}
		results.push(result);
	}
	write("\n=== test suite summary ===");
	for (const result of results) write(`${result.reused ? "REUSED" : result.code === 0 ? "PASS" : "FAIL"}  ${result.name}`);
	const failures = results.filter((result) => result.code !== 0);
	write(failures.length === 0 ? "all stages passed" : `${failures.length} stage(s) failed: ${failures.map((f) => f.name).join(", ")}`);
	return results;
}

function readStagesFromJsonPath(jsonPath) {
	const stages = JSON.parse(readFileSync(jsonPath, "utf8"));
	if (!Array.isArray(stages) || stages.some((stage) => typeof stage?.name !== "string" || typeof stage?.command !== "string")) {
		throw new Error(`stages file must be an array of { name, command } objects: ${jsonPath}`);
	}
	return stages;
}

// Direct-invocation detection must survive symlinks: Node real-paths
// `import.meta.url` but keeps `process.argv[1]` logical, so a plain equality
// check silently no-ops the whole runner (zero stages run, exit 0) when the
// script is reached through a file symlink.
function isDirectRun(argv1) {
	if (!argv1) return false;
	try {
		return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

if (isDirectRun(process.argv[1])) {
	try {
		const stages = process.argv[2] ? readStagesFromJsonPath(process.argv[2]) : DEFAULT_STAGES;
		// Proof-aware reuse is strictly opt-in (GENTLE_PROOFS=1): release and
		// CI gates keep running every stage unless the operator asks for reuse.
		const proofs = process.env.GENTLE_PROOFS === "1"
			? { ledgerRoot: ".pi/proofs", treeDigest: await computeTreeDigest(process.cwd()) }
			: undefined;
		const results = await runTestSuite(stages, { proofs });
		process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
