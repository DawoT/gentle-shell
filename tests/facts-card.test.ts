import assert from "node:assert/strict";
import test from "node:test";
import { renderFactsCard } from "../lib/facts/facts-card.ts";
import type { FactsDatabase } from "../lib/facts/facts-types.ts";

const plainTheme = {
	fg: (_color: string, text: string) => text,
};

test("renderFactsCard renders card with symbols, files, and test receipts", () => {
	const db: FactsDatabase = {
		version: "1.0.0",
		root: "/workspace",
		updatedAt: Date.now(),
		files: {
			"calc.ts": {
				path: "calc.ts",
				sha: "sha1",
				symbols: [{
					name: "add",
					kind: "function",
					signature: "function add(): number",
					startLine: 1,
					endLine: 2,
					isExported: true,
				}],
				imports: [],
				exports: ["add"],
			},
		},
		receipts: {
			packageManager: "pnpm@11.1.1",
			testCommand: "pnpm test",
			dependencies: {},
			devDependencies: {},
		},
	};

	const lines = renderFactsCard(db, plainTheme, 60, { expanded: true });

	assert.ok(lines.length >= 3);
	const content = lines.join("\n");
	assert.ok(content.includes("Facts"));
	assert.ok(content.includes("1 symbols"));
	assert.ok(content.includes("pnpm test"));
});

test("renderFactsCard handles null database gracefully", () => {
	const lines = renderFactsCard(null, plainTheme, 60);

	assert.ok(lines.length >= 3);
	const content = lines.join("\n");
	assert.ok(content.includes("Facts"));
	assert.ok(content.includes("No facts indexed"));
});
