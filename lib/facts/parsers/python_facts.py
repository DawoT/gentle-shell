"""Parse source text with the standard AST; never import the inspected project."""
import ast
import copy
import json
import sys


def signature(node):
  if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
    stub = copy.copy(node)
    stub.body = [ast.Pass()]
    stub.decorator_list = []
    return ast.unparse(stub).rsplit("\n", 1)[0]
  if isinstance(node, ast.ClassDef):
    stub = copy.copy(node)
    stub.body = [ast.Pass()]
    stub.decorator_list = []
    header = ast.unparse(stub).rsplit("\n", 1)[0]
    members = []
    for member in node.body:
      if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
        members.append(signature(member))
      elif isinstance(member, ast.AnnAssign):
        members.append(ast.unparse(member.target) + ": " + ast.unparse(member.annotation))
    return header + "".join("\n  " + line for line in members)
  return ast.unparse(node)


def extract(request):
  tree = ast.parse(request["source"], filename=request["path"])
  explicit = None
  for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in node.targets):
      try:
        value = ast.literal_eval(node.value)
        if isinstance(value, (list, tuple)) and all(isinstance(item, str) for item in value):
          explicit = set(value)
      except (ValueError, TypeError):
        pass
  symbols = []
  imports = []
  exports = []
  for node in tree.body:
    if isinstance(node, ast.Import):
      imports.extend(alias.name for alias in node.names)
    elif isinstance(node, ast.ImportFrom):
      imports.append("." * node.level + (node.module or ""))
    names = []
    kind = "variable"
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
      names = [node.name]
      kind = "class" if isinstance(node, ast.ClassDef) else "function"
    elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
      names = [node.target.id]
    elif isinstance(node, ast.Assign):
      names = [target.id for target in node.targets if isinstance(target, ast.Name)]
    for name in names:
      exported = name in explicit if explicit is not None else not name.startswith("_")
      symbol = {
        "name": name,
        "kind": "constant" if kind == "variable" and name.isupper() else kind,
        "signature": signature(node),
        "startLine": node.lineno,
        "endLine": node.end_lineno,
        "isExported": exported,
      }
      if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        doc = ast.get_docstring(node)
        if doc:
          symbol["docstring"] = doc
      symbols.append(symbol)
      if exported:
        exports.append(name)
  return {"path": request["path"], "sha": request["sha"], "symbols": symbols, "imports": imports, "exports": exports}


try:
  request = json.load(sys.stdin)
  json.dump(extract(request), sys.stdout, ensure_ascii=False)
except SyntaxError as error:
  print(f"Python syntax error at line {error.lineno}: {error.msg}", file=sys.stderr)
  sys.exit(1)
except Exception as error:
  print(f"Python parser error: {type(error).__name__}: {error}", file=sys.stderr)
  sys.exit(1)
