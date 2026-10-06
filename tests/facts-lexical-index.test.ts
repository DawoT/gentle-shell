import assert from "node:assert/strict";
import test from "node:test";
import { FACTS_DATABASE_VERSION, type FactsDatabase, type FileFacts } from "../lib/facts/facts-types.ts";
import { buildLexicalIndex, lexicalSearch } from "../lib/facts/facts-lexical-index.ts";

function file(path: string, symbols: { name: string; isExported?: boolean; docstring?: string }[]): FileFacts {
  return {
    path,
    sha: `sha-${path}`,
    symbols: symbols.map((s, index) => ({
      name: s.name,
      kind: "function",
      isExported: s.isExported ?? true,
      startLine: index * 4 + 1,
      endLine: index * 4 + 3,
      signature: `function ${s.name}()`,
      ...(s.docstring ? { docstring: s.docstring } : {}),
    })),
    imports: [],
    exports: [],
  } as unknown as FileFacts;
}

function fixtureDb(): FactsDatabase {
  return {
    version: FACTS_DATABASE_VERSION,
    root: "/repo",
    updatedAt: 0,
    files: {
      "src/billing/calculate-total.ts": file("src/billing/calculate-total.ts", [
        { name: "calculateTotal", docstring: "Totals for the invoice after discounts." },
      ]),
      "src/billing/calculate-tax.ts": file("src/billing/calculate-tax.ts", [
        { name: "calculateTax", docstring: "Tax rate applied to the invoice totals." },
      ]),
      "src/user/format.ts": file("src/user/format.ts", [
        { name: "formatUser", docstring: "Formats the user display name." },
      ]),
      "src/user/unrelated.ts": file("src/user/unrelated.ts", [
        { name: "renderWidget", isExported: false, docstring: "Internal painter." },
      ]),
    },
  };
}

test("exact symbol matches rank first with full evidence", () => {
  const index = buildLexicalIndex(fixtureDb());
  const matches = lexicalSearch(index, "calculateTotal");
  assert.ok(matches.length >= 2);
  assert.equal(matches[0].kind, "symbol");
  assert.equal(matches[0].file, "src/billing/calculate-total.ts");
  assert.equal(matches[0].name, "calculateTotal");
  assert.equal(matches[0].match, "calculateTotal");
  assert.ok(matches[0].score > matches[1].score, "the exact match outranks prefix/trigram matches");
});

test("prefix search finds every entry starting with the query, case-insensitively", () => {
  const index = buildLexicalIndex(fixtureDb());
  for (const query of ["calcul", "CALCUL"]) {
    const matches = lexicalSearch(index, query);
    const names = matches.filter((m) => m.kind === "symbol").map((m) => m.name);
    assert.deepEqual([...names].sort(), ["calculateTax", "calculateTotal"], query);
    for (const match of matches) assert.ok(match.file.length > 0 && match.match.length > 0);
  }
});

test("token search intersects all query tokens across names and paths", () => {
  const index = buildLexicalIndex(fixtureDb());
  const matches = lexicalSearch(index, "user format");
  const files = new Set(matches.map((m) => m.file));
  assert.deepEqual([...files], ["src/user/format.ts"]);
});

test("trigram fuzzy finds typo'd names", () => {
  const index = buildLexicalIndex(fixtureDb());
  const matches = lexicalSearch(index, "calcualteTotal");
  assert.equal(matches[0].name, "calculateTotal");
  assert.equal(matches[0].kind, "symbol");
});

test("docstring matches carry the exact matched text as evidence", () => {
  const index = buildLexicalIndex(fixtureDb());
  const matches = lexicalSearch(index, "invoice");
  const docs = matches.filter((m) => m.kind === "docstring");
  assert.ok(docs.length >= 2, "both billing docstrings mention the invoice");
  for (const doc of docs) {
    assert.ok(
      ["src/billing/calculate-total.ts", "src/billing/calculate-tax.ts"].includes(doc.file),
      `docstring match points at a billing file: ${doc.file}`,
    );
    assert.match(doc.match, /[Ii]nvoice/);
    assert.equal(doc.name, doc.file.includes("total") ? "calculateTotal" : "calculateTax");
  }
});

test("ranking is a total order: score desc, then kind, file and name", () => {
  const index = buildLexicalIndex(fixtureDb());
  const matches = lexicalSearch(index, "calculate");
  const cmp = (a: (typeof matches)[number], b: (typeof matches)[number]) =>
    b.score - a.score ||
    a.kind.localeCompare(b.kind) ||
    a.file.localeCompare(b.file, "en") ||
    (a.name ?? "").localeCompare(b.name ?? "", "en");
  for (let i = 1; i < matches.length; i++) {
    assert.ok(cmp(matches[i - 1], matches[i]) <= 0, `ranking violated at ${i}`);
  }
});

test("limit caps the result count after ranking", () => {
  const index = buildLexicalIndex(fixtureDb());
  const all = lexicalSearch(index, "calculate");
  const capped = lexicalSearch(index, "calculate", { limit: 1 });
  assert.equal(capped.length, 1);
  assert.deepEqual(capped[0], all[0]);
});

test("empty and whitespace-only queries return no matches", () => {
  const index = buildLexicalIndex(fixtureDb());
  assert.deepEqual(lexicalSearch(index, ""), []);
  assert.deepEqual(lexicalSearch(index, "   "), []);
});

test("every symbol match exists in a naive linear scan of the database", () => {
  const db = fixtureDb();
  const index = buildLexicalIndex(db);
  for (const query of ["calcul", "total", "format", "widget", "user"]) {
    for (const match of lexicalSearch(index, query)) {
      if (match.kind !== "symbol" && match.kind !== "docstring") continue;
      const facts = db.files[match.file];
      assert.ok(facts, `match file ${match.file} exists in the db`);
      const symbol = facts.symbols.find((s) => s.name === match.name);
      assert.ok(symbol, `matched symbol ${match.name} exists in ${match.file}`);
      const haystack = `${match.name ?? ""} ${symbol.docstring ?? ""}`.toLowerCase();
      assert.ok(haystack.includes(query.toLowerCase()), `query "${query}" is present in the evidence for ${match.name}`);
    }
  }
});

test("a larger corpus keeps exact and prefix lookups fast through the token map", () => {
  // Scale property expressed structurally: 20k symbols must produce the same
  // result as a scan would, with the index built once.
  const db: FactsDatabase = { version: FACTS_DATABASE_VERSION, root: "/repo", updatedAt: 0, files: {} };
  for (let i = 0; i < 10000; i++) {
    db.files[`src/mod${i}.ts`] = file(`src/mod${i}.ts`, [
      { name: `symbol${i}Alpha` },
      { name: `symbol${i}Beta` },
      ...(i % 2500 === 0 ? [{ name: `needle${i}`, docstring: "the invoice needle" }] : []),
    ]);
  }
  const index = buildLexicalIndex(db);
  const hits = lexicalSearch(index, "needle");
  assert.equal(hits.filter((m) => m.kind === "symbol").length, 4);
  const invoice = lexicalSearch(index, "invoice");
  assert.equal(invoice.filter((m) => m.kind === "docstring").length, 4);
});
