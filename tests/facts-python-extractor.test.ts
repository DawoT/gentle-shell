import assert from "node:assert/strict";
import { test } from "node:test";
import { extractPythonFacts } from "../lib/facts/facts-python-extractor.ts";

test("Python extracts async signatures, class interfaces and annotations without bodies", async () => {
  const facts = await extractPythonFacts("pkg/api.py", `from .models import User
import os.path
LIMIT: int = 5
_hidden = 1
async def fetch(name: str, /, *, retry: bool = True) -> User:
  """Load a user."""
  raise RuntimeError("never execute")
class Client(Base):
  """Client contract."""
  token: str
  def get(self, key: str) -> User:
    return dangerous()
`, "sha");
  assert.deepEqual(facts.imports, [".models", "os.path"]);
  assert.equal(facts.sha, "sha");
  const fn = facts.symbols.find((symbol) => symbol.name === "fetch")!;
  assert.equal(fn.signature, "async def fetch(name: str, /, *, retry: bool=True) -> User:");
  assert.equal(fn.docstring, "Load a user.");
  assert.equal(fn.startLine, 5);
  assert.equal(fn.endLine, 7);
  const cls = facts.symbols.find((symbol) => symbol.name === "Client")!;
  assert.match(cls.signature, /class Client\(Base\):/);
  assert.match(cls.signature, /def get\(self, key: str\) -> User:/);
  assert.doesNotMatch(cls.signature, /dangerous/);
  assert.equal(facts.symbols.find((symbol) => symbol.name === "LIMIT")?.kind, "constant");
  assert.equal(facts.symbols.find((symbol) => symbol.name === "_hidden")?.isExported, false);
});

test("Python static __all__ controls exported declarations", async () => {
  const facts = await extractPythonFacts("api.py", `__all__ = ["_entry"]
def _entry():
  pass
def helper():
  pass
`, "sha");
  assert.deepEqual(facts.exports, ["_entry"]);
  assert.equal(facts.symbols.find((symbol) => symbol.name === "helper")?.isExported, false);
});

test("Python parser never imports or executes project source", async () => {
  const facts = await extractPythonFacts("evil.py", `import absolutely_nonexistent_project_module
raise RuntimeError("EXECUTED")
def safe():
  pass
`, "sha");
  assert.equal(facts.symbols[0].name, "safe");
});

test("Python invalid syntax fails explicitly instead of publishing empty facts", async () => {
  await assert.rejects(extractPythonFacts("bad.py", "def (", "sha"), /Python.*syntax/i);
});

test("Python extraction respects caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractPythonFacts("a.py", "x = 1", "sha", controller.signal), { name: "AbortError" });
});

test("Python extraction rejects oversized source before spawning", async () => {
  await assert.rejects(extractPythonFacts("huge.py", "#".repeat(1024 * 1024 + 1), "sha"), /limit/i);
});
