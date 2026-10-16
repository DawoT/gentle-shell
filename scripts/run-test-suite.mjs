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
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageProofInput, computeTreeDigest } from "../lib/proofs/proof-harness.ts";
import { computeProofFingerprint, proofInputsDigest } from "../lib/proofs/proof-fingerprint.ts";
import { collectCoverageObservation } from "../lib/proofs/coverage-observation.ts";
import { selectMinimumTestSet } from "../lib/proofs/proof-invalidation.ts";
import { acquireVerifyLock } from "../lib/verify-lock.ts";

export const DEFAULT_STAGES = Object.freeze([
	{ name: "unit-tests", command: "node --experimental-strip-types --test tests/*.test.ts" },
	{ name: "provider-contract", command: "pnpm run check:provider-contract" },
	{ name: "runtime-harness", command: "pnpm run test:harness" },
]);

export async function runStage(stage) {
	// Unit fixtures must not inherit the terminal's Git overrides, child-session
	// identity, or personal guardrails. Other stages retain their existing env.
	const configHome = stage.name === "unit-tests" ? mkdtempSync(join(tmpdir(), "gentle-pi-unit-config-")) : undefined;
	const env = configHome ? Object.fromEntries(Object.entries(process.env).filter(([key]) => {
		const normalizedKey = key.toUpperCase();
		return !normalizedKey.startsWith("GIT_") && !normalizedKey.startsWith("GENTLE_PI_AGENTS_") && normalizedKey !== "GENTLE_PI_CONFIG_HOME";
	})) : process.env;
	if (configHome) env.GENTLE_PI_CONFIG_HOME = configHome;
	try {
		return await new Promise((resolve) => {
			const child = spawn(stage.command, { shell: true, stdio: "inherit", env });
			child.on("close", (code) => resolve({ name: stage.name, code: code ?? 1 }));
			child.on("error", (error) => {
				console.error(`\n[${stage.name}] spawn failed: ${error.message}`);
				resolve({ name: stage.name, code: 1 });
			});
		});
	} finally {
		if (configHome) rmSync(configHome, { recursive: true, force: true });
	}
}

function unitTestCommand(stage, file) {
	return stage.command.includes("tests/*.test.ts") ? stage.command.replace("tests/*.test.ts", file) : null;
}

function unitTestFingerprint(command) {
	const material = {
		command: { argv: [command], cwd: "." },
		toolchain: { runtime: "node", runtimeVersion: process.version, os: process.platform, arch: process.arch },
	};
	return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function enumerateUnitTestFiles(repoRoot) {
	return readdirSync(join(repoRoot, "tests"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => `tests/${entry.name}`)
		.sort();
}

function digestCoveredFiles(repoRoot, files) {
	const digests = {};
	for (const file of files) {
		try {
			digests[file] = createHash("sha256").update(readFileSync(join(repoRoot, file))).digest("hex");
		} catch {
			digests[file] = "<missing>";
		}
	}
	return digests;
}

function coverageSnapshotPath(proofs, fingerprint) {
	return join(proofs.ledgerRoot, "per-file-coverage", `${fingerprint}.json`);
}

function readCoverageSnapshot(proofs, fingerprint) {
	try {
		const value = JSON.parse(readFileSync(coverageSnapshotPath(proofs, fingerprint), "utf8"));
		return value && typeof value === "object" && value.files && typeof value.files === "object" ? value : null;
	} catch {
		return null;
	}
}

function writeCoverageSnapshot(proofs, fingerprint, snapshot) {
	const root = join(proofs.ledgerRoot, "per-file-coverage");
	mkdirSync(root, { recursive: true });
	writeFileSync(coverageSnapshotPath(proofs, fingerprint), `${JSON.stringify(snapshot)}\n`, "utf8");
}

function validPerFileObservation(observation, file) {
	return observation?.kind === "v8-coverage"
		&& observation.truncated !== true
		&& Array.isArray(observation.files)
		&& observation.files.includes(file);
}

async function recordProof(proofLedger, fingerprint, code, runtimeObservation, confidence, agent) {
	const record = await proofLedger.start({
		fingerprint,
		inputsDigest: fingerprint,
		confidence,
		sideEffects: "pure_validation",
		...(agent ? { agent } : {}),
	});
	await proofLedger.finish(record, {
		status: code === 0 ? "passed" : "failed",
		exitCode: code,
		...(runtimeObservation ? { runtimeObservation } : {}),
	});
}

async function recordStageProof(proofLedger, stage, proofs, code, runtimeObservation, constituents) {
	const input = buildStageProofInput(stage, proofs.treeDigest);
	const record = await proofLedger.start({
		fingerprint: computeProofFingerprint(input),
		inputsDigest: proofInputsDigest(input),
		confidence: "hermetic_static",
		sideEffects: "pure_validation",
		...(proofs.agent ? { agent: proofs.agent } : {}),
	});
	await proofLedger.finish(record, {
		status: code === 0 ? "passed" : "failed",
		exitCode: code,
		...(runtimeObservation ? { runtimeObservation } : {}),
		...(constituents ? { constituents } : {}),
	});
}

async function runUnitTestFile(stage, entry, runStageImpl, proofs, proofLedger) {
	const previousCoverageDir = process.env.NODE_V8_COVERAGE;
	const coverageDir = mkdtempSync(join(tmpdir(), "gentle-proof-file-coverage-"));
	let result;
	let runtimeObservation;
	try {
		process.env.NODE_V8_COVERAGE = coverageDir;
		result = await runStageImpl({ ...stage, command: entry.command });
		runtimeObservation = await collectCoverageObservation(coverageDir, proofs.repoRoot);
	} finally {
		if (previousCoverageDir === undefined) delete process.env.NODE_V8_COVERAGE;
		else process.env.NODE_V8_COVERAGE = previousCoverageDir;
		rmSync(coverageDir, { recursive: true, force: true });
	}
	if (!validPerFileObservation(runtimeObservation, entry.name)) return { result, runtimeObservation, trustworthy: false };
	const snapshot = { files: digestCoveredFiles(proofs.repoRoot, runtimeObservation.files) };
	await recordProof(proofLedger, entry.fingerprint, result.code, runtimeObservation, "hermetic_unit", proofs.agent);
	writeCoverageSnapshot(proofs, entry.fingerprint, snapshot);
	return { result, runtimeObservation, trustworthy: true, snapshot };
}

export async function runTestSuite(stages = DEFAULT_STAGES, { runStageImpl = runStage, write = (line) => console.log(line), proofs } = {}) {
	const results = [];
	let layer;
	let proofLedger;
	if (proofs) {
		// Opt-in proof-aware mode (GENTLE_PROOFS): reuse per-stage proofs while
		// the tree digest is unchanged. Any failure to load the layer degrades
		// to the plain sequential runner.
		try {
			const [{ createStageProofLayer }, { ProofLedger }] = await Promise.all([
				import("../lib/proofs/proof-harness.ts"),
				import("../lib/proofs/proof-ledger.ts"),
			]);
			proofLedger = new ProofLedger(proofs.ledgerRoot);
			layer = createStageProofLayer({ ledger: proofLedger, treeDigest: proofs.treeDigest, agent: proofs.agent });
		} catch (error) {
			write(`[proofs] layer unavailable (${error instanceof Error ? error.message : error}); running all stages`);
		}
	}
	for (const stage of stages) {
		if (layer && proofLedger && stage.name === "unit-tests" && proofs?.repoRoot) {
			const stageDecision = await layer.shouldExecute(stage);
			if (!stageDecision.execute) {
				write(`REUSED [${stage.name}] ${stageDecision.reason}`);
				results.push({ name: stage.name, code: 0, reused: true });
				continue;
			}

			let granularFallback = false;
			let inventory = [];
			const proofByFingerprint = new Map();
			const priorObservations = new Map();
			const currentFileDigests = {};
			const changedFiles = new Set();

			try {
				const files = enumerateUnitTestFiles(proofs.repoRoot);
				if (files.length === 0) granularFallback = true;
				for (const file of files) {
					const command = unitTestCommand(stage, file);
					if (!command) {
						granularFallback = true;
						break;
					}
					const fingerprint = unitTestFingerprint(command);
					const proof = await proofLedger.current(fingerprint);
					proofByFingerprint.set(fingerprint, proof);
					let coverage = { files: {} };
					if (proof) {
						if (!validPerFileObservation(proof.runtimeObservation, file)) {
							granularFallback = true;
							break;
						}
						const snapshot = readCoverageSnapshot(proofs, fingerprint);
						if (!snapshot) {
							granularFallback = true;
							break;
						}
						coverage = snapshot;
						priorObservations.set(file, proof.runtimeObservation);
						const current = digestCoveredFiles(proofs.repoRoot, Object.keys(snapshot.files));
						Object.assign(currentFileDigests, current);
						for (const [coveredFile, previousDigest] of Object.entries(snapshot.files)) {
							if (current[coveredFile] !== previousDigest) changedFiles.add(coveredFile);
						}
					}
					inventory.push({
						name: file,
						command,
						fingerprint,
						coverage,
						confidence: "hermetic_unit",
						sideEffects: "pure_validation",
					});
				}
			} catch {
				granularFallback = true;
			}

			let selection;
			if (!granularFallback) {
				const explicitlyChanged = Array.isArray(proofs.changedFiles) ? proofs.changedFiles : [];
				// Committed changes carry no explicit changed files: the per-file
				// coverage snapshots are the change detector. Any file a test loaded
				// is digest-compared against its snapshot; a changed file that no
				// test loaded cannot affect unit outcomes. Unknown reachability and
				// selection fallbacks still fail closed inside the selector.
				for (const file of explicitlyChanged) changedFiles.add(file);
			}
			if (!granularFallback) {
				selection = selectMinimumTestSet({
					inventory,
					proofFor: (entry) => proofByFingerprint.get(entry.fingerprint) ?? null,
					currentFileDigests,
					changedFiles: [...changedFiles],
					reaches: typeof proofs.reaches === "function"
						? proofs.reaches
						: (changedFile, coveredFile) => changedFile === coveredFile,
					allowUnreachableReuse: true,
				});
				if (selection.fallback) granularFallback = true;
			}

			if (!granularFallback) {
				const byName = new Map(inventory.map((entry) => [entry.name, entry]));
				const observations = new Map(priorObservations);
				const executedStatus = new Map();
				let code = 0;
				for (const item of selection.execute) {
					const entry = byName.get(item.name);
					if (!entry) {
						granularFallback = true;
						break;
					}
					write(`\n=== [${stage.name}:${entry.name}] ${entry.command} ===`);
					const execution = await runUnitTestFile(stage, entry, runStageImpl, proofs, proofLedger);
					if (!execution.trustworthy) {
						granularFallback = true;
						break;
					}
					observations.set(entry.name, execution.runtimeObservation);
					executedStatus.set(item.name, execution.result.code === 0 ? "passed" : "failed");
					if (execution.result.code !== 0 && code === 0) code = execution.result.code;
				}
				if (!granularFallback) {
					let falseReuseIncidents = 0;
					for (const item of selection.reuse) {
						const entry = byName.get(item.name);
						if (!entry) {
							granularFallback = true;
							break;
						}
						const current = digestCoveredFiles(proofs.repoRoot, Object.keys(entry.coverage.files));
						const drifted = Object.entries(entry.coverage.files).filter(
							([coveredFile, previousDigest]) => current[coveredFile] !== previousDigest,
						);
						if (drifted.length === 0) continue;
						for (const [coveredFile] of drifted) {
							write(`FALSE-REUSE [${stage.name}:${entry.name}] covered ${coveredFile} drifted after reuse`);
							falseReuseIncidents += 1;
						}
						write(`\n=== [${stage.name}:${entry.name}] ${entry.command} ===`);
						const execution = await runUnitTestFile(stage, entry, runStageImpl, proofs, proofLedger);
						if (!execution.trustworthy) {
							granularFallback = true;
							break;
						}
						observations.set(entry.name, execution.runtimeObservation);
						if (execution.result.code !== 0 && code === 0) code = execution.result.code;
					}
					write(`false-reuse incidents: ${falseReuseIncidents}`);
					if (!granularFallback) {
						const constituents = [
							...selection.reuse.map((item) => {
								const entry = byName.get(item.name);
								const prior = entry ? proofByFingerprint.get(entry.fingerprint) : undefined;
								return { file: item.name, fingerprint: entry?.fingerprint ?? "", disposition: "reused", status: prior?.status ?? "passed" };
							}),
							...selection.execute.map((item) => ({
								file: item.name,
								fingerprint: byName.get(item.name)?.fingerprint ?? "",
								disposition: "executed",
								status: executedStatus.get(item.name) ?? "failed",
							})),
						];
						const provenance = constituents.length > 0 && constituents.length <= 500 ? constituents : undefined;
						const files = [...new Set([...observations.values()].flatMap((observation) => observation.files))].sort();
						const runtimeObservation = { kind: "v8-coverage", files };
						await recordStageProof(proofLedger, stage, proofs, code, runtimeObservation, provenance);
						results.push({ name: stage.name, code });
						continue;
					}
				}
			}
		}

		if (layer) {
			const decision = await layer.shouldExecute(stage);
			if (!decision.execute) {
				write(`REUSED [${stage.name}] ${decision.reason}`);
				results.push({ name: stage.name, code: 0, reused: true });
				continue;
			}
		}
		write(`\n=== [${stage.name}] ${stage.command} ===`);
		let result;
		let runtimeObservation;
		let coverageDir;
		const previousCoverageDir = process.env.NODE_V8_COVERAGE;
		try {
			if (layer) {
				coverageDir = mkdtempSync(join(tmpdir(), "gentle-proof-coverage-"));
				process.env.NODE_V8_COVERAGE = coverageDir;
			}
			result = await runStageImpl(stage);
			if (coverageDir) {
				runtimeObservation = await collectCoverageObservation(coverageDir, proofs.repoRoot ?? process.cwd());
			}
		} finally {
			if (previousCoverageDir === undefined) delete process.env.NODE_V8_COVERAGE;
			else process.env.NODE_V8_COVERAGE = previousCoverageDir;
			if (coverageDir) rmSync(coverageDir, { recursive: true, force: true });
		}
		if (layer && proofLedger) {
			const input = buildStageProofInput(stage, proofs.treeDigest);
			const fingerprint = computeProofFingerprint(input);
			try {
				const record = await proofLedger.start({
					fingerprint,
					inputsDigest: proofInputsDigest(input),
					confidence: "hermetic_static",
					sideEffects: "pure_validation",
					...(proofs.agent ? { agent: proofs.agent } : {}),
				});
				await proofLedger.finish(record, {
					status: result.code === 0 ? "passed" : "failed",
					exitCode: result.code,
					...(runtimeObservation ? { runtimeObservation } : {}),
				});
			} catch (error) {
				write(`[proofs] could not record proof for ${stage.name}: ${error.message}`);
			}
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
	let lock;
	try {
		lock = await acquireVerifyLock(process.cwd(), `run-test-suite (GENTLE_PROOFS=${process.env.GENTLE_PROOFS ?? "0"})`);
		if (lock.heldByOther) {
			console.error(`WARNING: another verification run holds .pi/verify.lock (pid ${lock.owner?.pid}, started ${new Date(lock.owner?.startedAt).toISOString()}, command "${lock.owner?.command}"); results may be contended.`);
		}
		const stages = process.argv[2] ? readStagesFromJsonPath(process.argv[2]) : DEFAULT_STAGES;
		// Proof-aware reuse is strictly opt-in (GENTLE_PROOFS=1): release and
		// CI gates keep running every stage unless the operator asks for reuse.
		let proofs;
		if (process.env.GENTLE_PROOFS === "1") {
			const repoRoot = process.cwd();
			const treeDigest = await computeTreeDigest(repoRoot);
			try {
				const [{ execFile }, { promisify }, { FactsService }] = await Promise.all([
					import("node:child_process"),
					import("node:util"),
					import("../lib/facts/facts-service.ts"),
				]);
				const execFileAsync = promisify(execFile);
				const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 });
				const fields = stdout.split("\0").filter(Boolean);
				const changedFiles = [];
				for (let index = 0; index < fields.length; index += 1) {
					const record = fields[index];
					const status = record.slice(0, 2);
					const path = record.slice(3);
					if (path) changedFiles.push(path);
					if (status.includes("R") || status.includes("C")) index += 1;
				}
				const facts = new FactsService(repoRoot);
				await facts.sync(undefined, { mode: "auto" });
				const indexedFiles = new Set(Object.keys(facts.getDatabase()?.files ?? {}));
				const reachability = new Map();
				for (const changedFile of changedFiles) {
					if (!indexedFiles.has(changedFile)) {
						reachability.set(changedFile, "unknown");
						continue;
					}
					reachability.set(changedFile, new Set(facts.queryDependents(changedFile, { transitive: true })));
				}
				facts.close();
				proofs = {
					ledgerRoot: ".pi/proofs",
					treeDigest,
					repoRoot,
					changedFiles,
					reaches: (changedFile, coveredFile) => {
						if (changedFile === coveredFile) return true;
						const reachable = reachability.get(changedFile);
						return reachable === "unknown" ? "unknown" : reachable?.has(coveredFile) === true;
					},
				};
			} catch {
				proofs = { ledgerRoot: ".pi/proofs", treeDigest, repoRoot, changedFiles: ["<reachability-unknown>"], reaches: () => "unknown" };
			}
		}
		const results = await runTestSuite(stages, { proofs });
		process.exitCode = results.some((result) => result.code !== 0) ? 1 : 0;
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await lock?.release();
	}
}
