import assert from "node:assert/strict";
import test from "node:test";
import { classifyUnresolvedSpecifier, formatResolutionSummary } from "../lib/facts/facts-module-resolver.ts";
import type { FactsModuleEdge } from "../lib/facts/facts-module-resolver.ts";

function edge(importer: string, specifier: string, evidence: FactsModuleEdge["evidence"] = "unresolved"): FactsModuleEdge {
	return { importer, specifier, evidence };
}

test("classifies node: builtins as builtin", () => {
	assert.equal(classifyUnresolvedSpecifier("node:fs"), "builtin");
	assert.equal(classifyUnresolvedSpecifier("node:path"), "builtin");
});

test("classifies bare and scoped packages as external", () => {
	assert.equal(classifyUnresolvedSpecifier("typescript"), "external");
	assert.equal(classifyUnresolvedSpecifier("@scope/pkg"), "external");
});

test("classifies empty or non-string input as external", () => {
	assert.equal(classifyUnresolvedSpecifier(""), "external");
	assert.equal(classifyUnresolvedSpecifier(undefined as unknown as string), "external");
});

test("classifies relative and absolute specifiers as relative", () => {
	assert.equal(classifyUnresolvedSpecifier("./x"), "relative");
	assert.equal(classifyUnresolvedSpecifier("../y"), "relative");
	assert.equal(classifyUnresolvedSpecifier("/abs/z"), "relative");
});

test("formats a single summary line when nothing is unresolved", () => {
	const text = formatResolutionSummary([
		edge("src/a.ts", "./a2", "typescript"),
	]);
	assert.equal(text, "- Module resolution: 1 resolved, 0 unresolved (builtins 0, external 0, relative 0)");
});

test("omits example lines when only expected unresolved categories remain", () => {
	const text = formatResolutionSummary([edge("src/z.ts", "node:fs"), edge("src/z.ts", "lodash")]);
	assert.equal(text, "- Module resolution: 0 resolved, 2 unresolved (builtins 1, external 1, relative 0)");
});

test("formats one line plus up to three sorted relative examples", () => {
	const text = formatResolutionSummary([
		edge("src/z.ts", "node:fs"),
		edge("src/z.ts", "lodash"),
		edge("src/b.ts", "../out"),
		edge("src/a.ts", "./missing"),
		edge("src/a.ts", "../earlier"),
		edge("src/m.ts", "/root/abs"),
		edge("src/n.ts", "./fourth"),
	]);
	assert.equal(
		text,
		[
			"- Module resolution: 0 resolved, 7 unresolved (builtins 1, external 1, relative 5)",
			"  - src/a.ts -> ../earlier",
			"  - src/a.ts -> ./missing",
			"  - src/b.ts -> ../out",
		].join("\n"),
	);
});

test("produces identical output regardless of input edge order", () => {
	const edges = [
		edge("src/b.ts", "../out"),
		edge("src/a.ts", "./missing"),
		edge("src/a.ts", "../earlier"),
		edge("src/m.ts", "/root/abs"),
		edge("src/n.ts", "./fourth"),
	];
	assert.equal(formatResolutionSummary(edges), formatResolutionSummary([...edges].reverse()));
});
