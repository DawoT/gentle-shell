import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProofFingerprint } from "../lib/proofs/proof-fingerprint.ts";
import { buildStageProofInput, createStageProofLayer } from "../lib/proofs/proof-harness.ts";
import { ProofLedger } from "../lib/proofs/proof-ledger.ts";

const STAGE = { name: "unit-tests", command: "node --test tests/" };

test("stage proof input shape is pinned so harness and runner fingerprints cannot drift", () => {
	const input = buildStageProofInput(STAGE, "tree-digest");
	assert.deepEqual(input, {
		command: { argv: [STAGE.command], cwd: ".", taskKind: "test-suite-stage", selection: [STAGE.name] },
		repository: { treeDigest: "tree-digest" },
		toolchain: { runtime: "node", runtimeVersion: process.version, os: process.platform, arch: process.arch },
		environment: { declared: {}, sensitive: {}, hmacKey: "stage-proof-layer" },
	});
});

test("the stage proof layer decides reuse with the same fingerprint the shared builder computes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "proofs-stage-input-"));
	try {
		const ledger = new ProofLedger(join(dir, "proofs"));
		const layer = createStageProofLayer({ ledger, treeDigest: "tree-digest" });
		const expected = computeProofFingerprint(buildStageProofInput(STAGE, "tree-digest"));
		const before = await layer.shouldExecute(STAGE);
		assert.equal(before.execute, true, "no published proof yet, so the stage must execute");
		await layer.recordResult(STAGE, 0);
		const after = await layer.shouldExecute(STAGE);
		assert.equal(after.execute, false, "a passed proof for the same input must be reused");
		assert.ok(
			after.reason.includes(expected.slice(0, 12)),
			`reuse reason must carry the shared fingerprint prefix ${expected.slice(0, 12)}; got: ${after.reason}`,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
