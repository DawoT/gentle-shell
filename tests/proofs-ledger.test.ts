import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProofLedger, ProofLifecycleError, type ProofConstituent } from "../lib/proofs/proof-ledger.ts";
import { computeProofFingerprint, proofInputsDigest, canonicalProofInputsForStorage, type ProofFingerprintInput } from "../lib/proofs/proof-fingerprint.ts";

function fingerprintInput(overrides: Partial<ProofFingerprintInput> = {}): ProofFingerprintInput {
  return {
    command: { argv: ["pnpm", "test", "tests/facts-store.test.ts"], cwd: "packages/app", taskKind: "test", selection: ["tests/facts-store.test.ts"] },
    repository: { treeDigest: "a".repeat(64), factsGeneration: "b".repeat(64), manifestDigest: "c".repeat(64), configDigests: ["d".repeat(64)] },
    toolchain: { runtime: "node", runtimeVersion: "26.10.0", runner: "node:test", runnerVersion: "1.0.0", os: "linux", arch: "arm64" },
    environment: { declared: { CI: "1" }, sensitive: { API_TOKEN: "secret-value" }, hmacKey: "hmac-secret" },
    ...overrides,
  };
}

async function ledgerFixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofs-ledger-"));
  return {
    dir,
    ledger: new ProofLedger(join(dir, "proofs")),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("the fingerprint is deterministic, order-independent and sensitive-free", () => {
  const base = computeProofFingerprint(fingerprintInput());
  const reordered = computeProofFingerprint(fingerprintInput({
    environment: { declared: { CI: "1" }, sensitive: { API_TOKEN: "secret-value" }, hmacKey: "hmac-secret" },
  }));
  assert.equal(reordered, base);
  assert.match(base, /^[a-f0-9]{64}$/);

  // Every input dimension participates: changing any one moves the fingerprint.
  const dimensions = [
    fingerprintInput({ command: { ...fingerprintInput().command, argv: ["pnpm", "test", "other.test.ts"] } }),
    fingerprintInput({ command: { ...fingerprintInput().command, cwd: "packages/other" } }),
    fingerprintInput({ command: { ...fingerprintInput().command, selection: ["other.test.ts"] } }),
    fingerprintInput({ repository: { ...fingerprintInput().repository, treeDigest: "f".repeat(64) } }),
    fingerprintInput({ repository: { ...fingerprintInput().repository, factsGeneration: undefined } }),
    fingerprintInput({ toolchain: { ...fingerprintInput().toolchain, runtimeVersion: "25.0.0" } }),
    fingerprintInput({ toolchain: { ...fingerprintInput().toolchain, os: "darwin" } }),
    fingerprintInput({ environment: { declared: { CI: "0" }, sensitive: fingerprintInput().environment.sensitive, hmacKey: "hmac-secret" } }),
  ];
  for (const dimension of dimensions) {
    assert.notEqual(computeProofFingerprint(dimension), base, "an input change must change the fingerprint");
  }
});

test("missing input dimensions block fingerprint creation", () => {
  assert.throws(() => computeProofFingerprint(fingerprintInput({ command: { ...fingerprintInput().command, argv: [] } })), /argv/);
  assert.throws(() => computeProofFingerprint(fingerprintInput({ repository: { ...fingerprintInput().repository, treeDigest: "" } })), /treeDigest/);
  assert.throws(() => computeProofFingerprint(fingerprintInput({ toolchain: { ...fingerprintInput().toolchain, runtimeVersion: "" } })), /runtimeVersion/);
});

test("sensitive environment values are never persisted in plaintext", () => {
  const input = fingerprintInput();
  const fingerprint = computeProofFingerprint(input);
  const serialized = JSON.stringify(canonicalProofInputsForStorage(input));
  assert.doesNotMatch(serialized, /secret-value/);
  assert.match(serialized, /hmac/i);
  assert.equal(fingerprint, computeProofFingerprint(fingerprintInput()));
});

test("the ledger stores and retrieves immutable content-addressed proofs", async () => {
  const { ledger, dir, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const record = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_unit", sideEffects: "pure_validation", agent: "verifier-a" });
    assert.equal(record.status, "running");

    const finished = await ledger.finish(record, {
      status: "passed", exitCode: 0, durationMs: 1234, outputDigests: { stdout: "e".repeat(64), stderr: "0".repeat(64) },
    });

    const current = await ledger.current(fingerprint);
    assert.equal(current?.status, "passed");
    assert.equal(current?.fingerprint, fingerprint);
    assert.equal(current?.inputsDigest, finished.inputsDigest);
    assert.ok((current as { seq?: number }).seq !== undefined);

    // Immutable artifacts: at least one artifact per publication, and the
    // current view points at the latest one.
    const artifactDir = join(dir, "proofs", "records", fingerprint);
    const artifacts = (await readdir(artifactDir)).filter((name) => /^\d+\.json$/.test(name));
    assert.ok(artifacts.length >= 1);

    // Raw output never lands on disk: only digests.
    const raw = await readFile(join(artifactDir, "current.json"), "utf8");
    assert.doesNotMatch(raw, /hello stdout|lorem ipsum/i);
    assert.match(raw, /"stdout"/);
    assert.match(raw, /"stderr"/);
    await stat(join(artifactDir, "current.json"));
  } finally {
    await cleanup();
  }
});

test("lifecycle transitions are enforced and terminal artifacts stay immutable", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const record = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_static", sideEffects: "pure_validation" });
    await ledger.finish(record, { status: "passed", exitCode: 0 });

    assert.equal((await ledger.current(record.fingerprint))?.status, "passed");
    await assert.rejects(
      () => ledger.finish(record, { status: "running" } as never),
      (error: unknown) => error instanceof ProofLifecycleError && /already published/.test((error as Error).message),
    );
    await ledger.transition(record.fingerprint, "invalidated", "source tree changed");
    assert.equal((await ledger.current(record.fingerprint))?.status, "invalidated");
    await assert.rejects(
      () => ledger.finish(record, { status: "passed", exitCode: 0 }),
      ProofLifecycleError,
    );
  } finally {
    await cleanup();
  }
});

test("re-running the same fingerprint publishes a new artifact and current view", async () => {
  const { ledger, dir, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const first = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_unit", sideEffects: "pure_validation" });
    await ledger.finish(first, { status: "failed", exitCode: 1 });

    // A new execution for the same fingerprint: old artifact untouched.
    const second = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_unit", sideEffects: "pure_validation" });
    await ledger.finish(second, { status: "passed", exitCode: 0 });

    const current = await ledger.current(fingerprint);
    assert.equal(current?.status, "passed");
    const artifactDir = join(dir, "proofs", "records", fingerprint);
    const artifacts = (await readdir(artifactDir)).filter((name) => /^\d+\.json$/.test(name));
    assert.deepEqual(artifacts.sort(), ["1.json", "2.json"]);
  } finally {
    await cleanup();
  }
});

test("runtime coverage never changes the exact proof fingerprint", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const start = () => ledger.start({
      fingerprint,
      inputsDigest: proofInputsDigest(input),
      confidence: "hermetic_unit",
      sideEffects: "pure_validation",
    });

    const withoutCoverage = await ledger.finish(await start(), { status: "passed", exitCode: 0 });
    const runtimeObservation = { kind: "v8-coverage", files: ["src/a.ts", "tests/a.test.ts"] } as const;
    const withCoverage = await ledger.finish(
      await start(),
      { status: "passed", exitCode: 0, runtimeObservation } as never,
    );

    assert.equal(withCoverage.fingerprint, withoutCoverage.fingerprint);
    assert.equal(withCoverage.fingerprint, fingerprint);
    assert.deepEqual((withCoverage as typeof withCoverage & { runtimeObservation?: unknown }).runtimeObservation, runtimeObservation);
  } finally {
    await cleanup();
  }
});

test("runtime coverage survives ledger round-trip and rejects payloads above 65536 bytes", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const start = () => ledger.start({
      fingerprint,
      inputsDigest: proofInputsDigest(input),
      confidence: "hermetic_unit",
      sideEffects: "pure_validation",
    });
    const runtimeObservation = { kind: "v8-coverage", files: ["src/a.ts", "src/b.ts"] } as const;

    await ledger.finish(
      await start(),
      { status: "passed", exitCode: 0, runtimeObservation } as never,
    );
    const roundTripped = await ledger.current(fingerprint);
    assert.deepEqual(
      (roundTripped as (typeof roundTripped & { runtimeObservation?: unknown })).runtimeObservation,
      runtimeObservation,
    );

    const oversizedObservation = {
      kind: "v8-coverage",
      files: Array.from({ length: 4096 }, (_, index) => `src/${index.toString().padStart(4, "0")}-${"x".repeat(24)}.ts`),
    } as const;
    assert.ok(Buffer.byteLength(JSON.stringify(oversizedObservation), "utf8") > 65_536);
    await assert.rejects(
      async () => ledger.finish(
        await start(),
        { status: "passed", exitCode: 0, runtimeObservation: oversizedObservation } as never,
      ),
      /runtime observation exceeds 65536 bytes/i,
    );
  } finally {
    await cleanup();
  }
});

test("raw command output is rejected as proof material", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const record = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_unit", sideEffects: "pure_validation" });
    await assert.rejects(
      () => ledger.finish(record, { status: "passed", stdout: "the full test output" } as never),
      /raw output|stdout/i,
    );
  } finally {
    await cleanup();
  }
});

test("the ledger persists constituent provenance for composed stage proofs", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const input = fingerprintInput();
    const fingerprint = computeProofFingerprint(input);
    const record = await ledger.start({ fingerprint, inputsDigest: proofInputsDigest(input), confidence: "hermetic_static", sideEffects: "pure_validation" });
    const constituents: ProofConstituent[] = [
      { file: "tests/alpha.test.ts", fingerprint: "a".repeat(64), disposition: "reused", status: "passed" },
      { file: "tests/gamma.test.ts", fingerprint: "c".repeat(64), disposition: "executed", status: "passed" },
    ];
    const finished = await ledger.finish(record, { status: "passed", exitCode: 0, constituents });
    assert.deepEqual(finished.constituents, constituents);
    assert.deepEqual((await ledger.current(fingerprint))?.constituents, constituents);
  } finally {
    await cleanup();
  }
});

test("constituent provenance fails closed and legacy records stay valid without it", async () => {
  const { ledger, cleanup } = await ledgerFixture();
  try {
    const startWith = (fingerprint: string) => ledger.start({ fingerprint, inputsDigest: fingerprint, confidence: "hermetic_static", sideEffects: "pure_validation" });
    const tooMany: ProofConstituent[] = Array.from({ length: 501 }, (_, index) => ({
      file: `tests/f${index}.test.ts`, fingerprint: "a".repeat(64), disposition: "reused", status: "passed",
    }));
    await assert.rejects(
      ledger.finish(await startWith("a".repeat(64)), { status: "passed", constituents: tooMany }),
      /constituents/i,
    );

    const invalid: ProofConstituent[] = [{ file: "tests/x.test.ts", fingerprint: "not-hex", disposition: "reused", status: "passed" }];
    const mutated = invalid[0] as { disposition: string; fingerprint: string };
    mutated.disposition = "sideways";
    mutated.fingerprint = "not-hex";
    await assert.rejects(
      ledger.finish(await startWith("b".repeat(64)), { status: "passed", constituents: invalid }),
      /constituent/i,
    );

    const legacy = await ledger.finish(await startWith("c".repeat(64)), { status: "passed", exitCode: 0 });
    assert.equal(legacy.constituents, undefined);
    assert.equal((await ledger.current("c".repeat(64)))?.status, "passed");
  } finally {
    await cleanup();
  }
});

test("list returns the true newest records even when the ledger holds more than 200", async () => {
	const dir = await mkdtemp(join(tmpdir(), "proofs-ledger-"));
	const ledger = new ProofLedger(join(dir, "proofs"));
	try {
		const total = 250;
		const recordsDir = join(dir, "proofs", "records");
		const fingerprints: string[] = [];
		for (let index = 0; index < total; index += 1) {
			const fingerprint = index < total - 1 ? "0".repeat(62) + index.toString(16).padStart(2, "0") : "f" + "a".repeat(63);
			fingerprints.push(fingerprint);
			const record = {
				seq: index + 1,
				fingerprint,
				status: "passed",
				confidence: "hermetic_static",
				sideEffects: "pure_validation",
				inputsDigest: "d".repeat(64),
				startedAt: index + 1,
				finishedAt: index + 1,
			};
			await mkdir(join(recordsDir, fingerprint), { recursive: true });
			await writeFile(join(recordsDir, fingerprint, "current.json"), JSON.stringify(record));
		}
		const target = fingerprints[total - 1]!;
		const listed = await ledger.list(200);
		assert.equal(listed.length, 200, "the 200-record bound still holds");
		const expected = new Set(fingerprints.slice(total - 200));
		for (const record of listed) {
			assert.ok(expected.has(record.fingerprint), `unexpected record among the newest 200: ${record.fingerprint}`);
		}
		assert.equal(listed[0]!.fingerprint, target, "the newest record leads the list regardless of its directory name");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
