import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexAuth {
	accessToken: string;
	accountId?: string;
}

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function getDefaultCodexAuthPath(): string {
	const configuredHome = process.env.CODEX_HOME?.trim();
	const baseDir = configuredHome && configuredHome.length > 0
		? configuredHome
		: join(homedir(), ".codex");
	return join(baseDir, "auth.json");
}

function extractAccountIdFromJwt(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payloadJson = Buffer.from(parts[1]!, "base64").toString("utf8");
		const payload = JSON.parse(payloadJson);
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId.trim().length > 0 ? accountId.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function readCodexAuth(filePath: string = getDefaultCodexAuthPath()): CodexAuth {
	if (!existsSync(filePath)) {
		throw new Error("Codex auth credentials file not found");
	}

	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		throw new Error("Failed to read Codex auth file");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("Failed to parse Codex auth file as JSON");
	}

	const record = asRecord(parsed);
	const tokens = asRecord(record?.tokens);
	const accessToken = nonEmptyString(tokens?.access_token)
		?? nonEmptyString(record?.OPENAI_API_KEY)
		?? nonEmptyString(record?.access_token);

	if (!accessToken) {
		throw new Error("Missing access_token in Codex auth file");
	}

	const accountId = nonEmptyString(tokens?.account_id)
		?? nonEmptyString(record?.account_id)
		?? extractAccountIdFromJwt(accessToken);

	return {
		accessToken,
		accountId,
	};
}
