import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { classifyUnresolvedSpecifier, formatResolutionSummary, resolveFactsModules } from "../lib/facts/facts-module-resolver.ts";
import type { FactsModuleEdge } from "../lib/facts/facts-module-resolver.ts";
import type { FileFacts } from "../lib/facts/facts-types.ts";

function edge(importer: string, specifier: string, evidence: FactsModuleEdge["evidence"] = "unresolved"): FactsModuleEdge {
	return { importer, specifier, evidence };
}

async function fixture(t: test.TestContext, entries: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "facts-classification-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const [path, text] of Object.entries(entries)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}

function facts(path: string, imports: string[] = []): FileFacts {
	return { path, sha: "test", symbols: [], imports, exports: [] };
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

test("counts a relative specifier whose file exists as filesystem evidence, not unresolved", async (t) => {
	const root = await fixture(t, {
		"src/runtime-metrics-native.ts": "",
		"src/telemetry.json": "{}",
		"contracts/telemetry/runtime-aggregate-v1.schema.json": "{}",
	});
	const edges = resolveFactsModules(root, {
		"src/runtime-metrics-native.ts": facts("src/runtime-metrics-native.ts", [
			"./telemetry.json",
			"../contracts/telemetry/runtime-aggregate-v1.schema.json",
			"./missing.json",
		]),
	});
	const sibling = edges.find((candidate) => candidate.specifier === "./telemetry.json");
	assert.equal(sibling?.evidence, "filesystem");
	assert.equal(sibling?.target, "src/telemetry.json");
	const schema = edges.find((candidate) => candidate.specifier === "../contracts/telemetry/runtime-aggregate-v1.schema.json");
	assert.equal(schema?.evidence, "filesystem");
	assert.equal(schema?.target, "contracts/telemetry/runtime-aggregate-v1.schema.json");
	const missing = edges.find((candidate) => candidate.specifier === "./missing.json");
	assert.equal(missing?.evidence, "unresolved");
	assert.equal(missing?.reason, "module-not-found");
	const text = formatResolutionSummary(edges);
	assert.match(text, /^- Module resolution: 2 resolved, 1 unresolved \(builtins 0, external 0, relative 1\)$/m);
	assert.match(text, /  - src\/runtime-metrics-native\.ts -> \.\/missing\.json$/m);
	assert.doesNotMatch(text, /telemetry\.json ->|-> \.\.\/contracts/);
});

test("summary counts filesystem evidence as resolved and keeps relative examples unresolved-only", () => {
	const text = formatResolutionSummary([
		edge("src/a.ts", "./data.json", "filesystem"),
		edge("src/b.ts", "./missing", "unresolved"),
		edge("src/c.ts", "./found.ts", "typescript"),
	]);
	assert.equal(text, [
		"- Module resolution: 2 resolved, 1 unresolved (builtins 0, external 0, relative 1)",
		"  - src/b.ts -> ./missing",
	].join("\n"));
});

test("does not treat an existing directory as a resolved module", async (t) => {
	const root = await fixture(t, { "src/main.ts": "", "src/data/keep.txt": "" });
	const [target] = resolveFactsModules(root, { "src/main.ts": facts("src/main.ts", ["./data"]) });
	assert.equal(target.evidence, "unresolved");
});

test("leaves absolute specifiers unresolved even when the path exists", async (t) => {
	const root = await fixture(t, { "main.ts": "", "data.json": "{}" });
	const [target] = resolveFactsModules(root, { "main.ts": facts("main.ts", [join(root, "data.json")]) });
	assert.equal(target.evidence, "unresolved");
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
