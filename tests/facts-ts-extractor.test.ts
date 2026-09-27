import assert from "node:assert/strict";
import test from "node:test";
import { extractTypeScriptFacts } from "../lib/facts/facts-ts-extractor.ts";

test("extractTypeScriptFacts extracts exported functions with signatures and docstrings", () => {
	const code = `
/**
 * Calculates sum of two numbers.
 * @param a First operand
 * @param b Second operand
 */
export function add(a: number, b: number = 0): number {
	return a + b;
}

export async function fetchUser<T>(id: string): Promise<T> {
	return {} as T;
}
`;

	const facts = extractTypeScriptFacts("math.ts", code, "fake_sha_1");

	assert.equal(facts.path, "math.ts");
	assert.equal(facts.sha, "fake_sha_1");
	assert.equal(facts.symbols.length, 2);

	const addSymbol = facts.symbols.find((s) => s.name === "add");
	assert.ok(addSymbol);
	assert.equal(addSymbol.kind, "function");
	assert.equal(addSymbol.isExported, true);
	assert.match(addSymbol.signature, /function add\(a: number, b\?: number\): number/);
	assert.ok(addSymbol.docstring?.includes("Calculates sum of two numbers."));
	assert.ok(addSymbol.startLine > 0);
	assert.ok(addSymbol.endLine >= addSymbol.startLine);

	const fetchSymbol = facts.symbols.find((s) => s.name === "fetchUser");
	assert.ok(fetchSymbol);
	assert.equal(fetchSymbol.kind, "function");
	assert.match(fetchSymbol.signature, /async function fetchUser<T>\(id: string\): Promise<T>/);
});

test("extractTypeScriptFacts extracts arrow functions assigned to exported constants", () => {
	const code = `
export const multiply = (x: number, y: number): number => x * y;
export const greet = (name: string) => \`Hello, \${name}\`;
`;

	const facts = extractTypeScriptFacts("helpers.ts", code, "fake_sha_2");

	const multiplySymbol = facts.symbols.find((s) => s.name === "multiply");
	assert.ok(multiplySymbol);
	assert.equal(multiplySymbol.kind, "function");
	assert.match(multiplySymbol.signature, /const multiply: \(x: number, y: number\) => number/);

	const greetSymbol = facts.symbols.find((s) => s.name === "greet");
	assert.ok(greetSymbol);
	assert.equal(greetSymbol.kind, "function");
});

test("extractTypeScriptFacts extracts interfaces, type aliases and enums", () => {
	const code = `
/** User representation */
export interface User<T = string> {
	id: string;
	data: T;
	getName(): string;
}

export type Status = "active" | "inactive" | "pending";

export enum Role {
	Admin = "ADMIN",
	User = "USER",
}
`;

	const facts = extractTypeScriptFacts("models.ts", code, "fake_sha_3");

	const userInterface = facts.symbols.find((s) => s.name === "User");
	assert.ok(userInterface);
	assert.equal(userInterface.kind, "interface");
	assert.ok(userInterface.docstring?.includes("User representation"));
	assert.match(userInterface.signature, /interface User<T = string>/);

	const statusType = facts.symbols.find((s) => s.name === "Status");
	assert.ok(statusType);
	assert.equal(statusType.kind, "typeAlias");
	assert.match(statusType.signature, /type Status = "active" \| "inactive" \| "pending"/);

	const roleEnum = facts.symbols.find((s) => s.name === "Role");
	assert.ok(roleEnum);
	assert.equal(roleEnum.kind, "enum");
});

test("extractTypeScriptFacts extracts classes and their public signatures", () => {
	const code = `
export class OrderService {
	private db: any;

	constructor(db: any) {
		this.db = db;
	}

	public async processOrder(orderId: string): Promise<boolean> {
		return true;
	}

	static createDefault(): OrderService {
		return new OrderService(null);
	}
}
`;

	const facts = extractTypeScriptFacts("services.ts", code, "fake_sha_4");

	const serviceClass = facts.symbols.find((s) => s.name === "OrderService");
	assert.ok(serviceClass);
	assert.equal(serviceClass.kind, "class");
	assert.match(serviceClass.signature, /class OrderService/);
	assert.match(serviceClass.signature, /processOrder\(orderId: string\): Promise<boolean>/);
	assert.match(serviceClass.signature, /static createDefault\(\): OrderService/);
});

test("extractTypeScriptFacts records all import module specifiers", () => {
	const code = `
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import "../lib/utils.ts";

export const x = 10;
`;

	const facts = extractTypeScriptFacts("app.ts", code, "fake_sha_5");

	assert.deepEqual(facts.imports.sort(), [
		"../lib/utils.ts",
		"@earendil-works/pi-coding-agent",
		"node:fs/promises",
		"node:path",
	]);
});

test("extractTypeScriptFacts records named exports and re-exports", () => {
	const code = `
const a = 1;
const b = 2;
export { a, b as c };
export * from "./other.ts";
export default function main() {}
`;

	const facts = extractTypeScriptFacts("index.ts", code, "fake_sha_6");

	assert.ok(facts.exports.includes("a"));
	assert.ok(facts.exports.includes("c"));
	assert.ok(facts.exports.includes("default"));
	assert.ok(facts.exports.includes("* from ./other.ts"));
});

test("extractTypeScriptFacts handles syntax errors gracefully without throwing", () => {
	const malformedCode = `
export function incomplete(a: number {
	return 123;
// missing closing braces
`;

	const facts = extractTypeScriptFacts("broken.ts", malformedCode, "fake_sha_7");

	assert.equal(facts.path, "broken.ts");
	assert.ok(Array.isArray(facts.symbols));
});
