import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultCodexAuthPath, readCodexAuth } from "../lib/codex-native/auth.ts";

test("readCodexAuth resolves valid token and account_id from auth.json", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
	try {
		const authFile = join(dir, "auth.json");
		const syntheticPayload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_test_from_jwt" },
		})).toString("base64");
		const syntheticJwt = `header.${syntheticPayload}.signature`;

		writeFileSync(authFile, JSON.stringify({
			tokens: {
				access_token: syntheticJwt,
				account_id: "acct_test_123",
			},
		}));

		const auth = readCodexAuth(authFile);
		assert.equal(auth.accessToken, syntheticJwt);
		assert.equal(auth.accountId, "acct_test_123");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readCodexAuth extracts accountId from JWT payload when account_id field is omitted", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
	try {
		const authFile = join(dir, "auth.json");
		const syntheticPayload = Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct_jwt_fallback" },
		})).toString("base64");
		const syntheticJwt = `header.${syntheticPayload}.signature`;

		writeFileSync(authFile, JSON.stringify({
			tokens: {
				access_token: syntheticJwt,
			},
		}));

		const auth = readCodexAuth(authFile);
		assert.equal(auth.accessToken, syntheticJwt);
		assert.equal(auth.accountId, "acct_jwt_fallback");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readCodexAuth throws when auth file is missing", () => {
	const nonExistent = join(tmpdir(), "non-existent-auth-file-12345.json");
	assert.throws(
		() => readCodexAuth(nonExistent),
		/Codex auth credentials file not found/
	);
});

test("readCodexAuth throws when auth file has invalid JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
	try {
		const authFile = join(dir, "auth.json");
		writeFileSync(authFile, "{ corrupted json ");
		assert.throws(
			() => readCodexAuth(authFile),
			/Failed to parse Codex auth file/
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readCodexAuth throws when access_token is missing or empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
	try {
		const authFile = join(dir, "auth.json");
		writeFileSync(authFile, JSON.stringify({ tokens: {} }));
		assert.throws(
			() => readCodexAuth(authFile),
			/Missing access_token/
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed credential fields fail with safe diagnostics rather than trim errors", () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-auth-test-"));
	try {
		const authFile = join(dir, "auth.json");
		for (const value of [42, {}, [], true]) {
			for (const document of [{ tokens: { access_token: value } }, { OPENAI_API_KEY: value }, { access_token: value }]) {
				writeFileSync(authFile, JSON.stringify(document));
				assert.throws(() => readCodexAuth(authFile), /Missing access_token/);
			}
		}
		writeFileSync(authFile, '{"tokens":{"access_token":"secret-marker",');
		assert.throws(() => readCodexAuth(authFile), error => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /Failed to parse Codex auth file/);
			assert.equal(error.message.includes("secret-marker"), false);
			return true;
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("getDefaultCodexAuthPath respects CODEX_HOME environment variable", () => {
	const original = process.env.CODEX_HOME;
	try {
		process.env.CODEX_HOME = "/custom/codex/path";
		assert.equal(getDefaultCodexAuthPath(), "/custom/codex/path/auth.json");
	} finally {
		if (original !== undefined) process.env.CODEX_HOME = original;
		else delete process.env.CODEX_HOME;
	}
});

