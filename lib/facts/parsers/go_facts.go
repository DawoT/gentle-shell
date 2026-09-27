package main

import (
  "bytes"
  "encoding/json"
  "fmt"
  "go/ast"
  "go/parser"
  "go/printer"
  "go/token"
  "os"
  "strconv"
  "strings"
)

type Request struct {
  Path string `json:"path"`
  Source string `json:"source"`
  Sha string `json:"sha"`
}

type Symbol struct {
  Name string `json:"name"`
  Kind string `json:"kind"`
  Signature string `json:"signature"`
  Docstring string `json:"docstring,omitempty"`
  StartLine int `json:"startLine"`
  EndLine int `json:"endLine"`
  IsExported bool `json:"isExported"`
}

type Facts struct {
  Path string `json:"path"`
  Sha string `json:"sha"`
  Symbols []Symbol `json:"symbols"`
  Imports []string `json:"imports"`
  Exports []string `json:"exports"`
}

func receiverName(expr ast.Expr) string {
  switch node := expr.(type) {
  case *ast.Ident:
    return node.Name
  case *ast.StarExpr:
    return receiverName(node.X)
  case *ast.IndexExpr:
    return receiverName(node.X)
  case *ast.IndexListExpr:
    return receiverName(node.X)
  }
  return ""
}

func main() {
  var request Request
  if err := json.NewDecoder(os.Stdin).Decode(&request); err != nil {
    fmt.Fprintln(os.Stderr, "Go parser request:", err)
    os.Exit(1)
  }
  positions := token.NewFileSet()
  file, err := parser.ParseFile(positions, request.Path, request.Source, parser.ParseComments|parser.AllErrors)
  if err != nil {
    fmt.Fprintln(os.Stderr, "Go parse error:", err)
    os.Exit(1)
  }
  facts := Facts{Path: request.Path, Sha: request.Sha, Symbols: []Symbol{}, Imports: []string{}, Exports: []string{}}
  printNode := func(node interface{}) string {
    var output bytes.Buffer
    printer.Fprint(&output, positions, node)
    return output.String()
  }
  add := func(name, kind, signature string, node ast.Node, doc *ast.CommentGroup, exported bool) {
    text := ""
    if doc != nil {
      text = strings.TrimSpace(doc.Text())
    }
    facts.Symbols = append(facts.Symbols, Symbol{name, kind, signature, text, positions.Position(node.Pos()).Line, positions.Position(node.End()).Line, exported})
    if exported {
      facts.Exports = append(facts.Exports, name)
    }
  }
  for _, declaration := range file.Decls {
    switch node := declaration.(type) {
    case *ast.FuncDecl:
      name := node.Name.Name
      exported := ast.IsExported(name)
      if node.Recv != nil && len(node.Recv.List) > 0 {
        receiver := receiverName(node.Recv.List[0].Type)
        name = receiver + "." + name
        exported = exported && ast.IsExported(receiver)
      }
      copy := *node
      copy.Body = nil
      copy.Doc = nil
      add(name, "function", printNode(&copy), node, node.Doc, exported)
    case *ast.GenDecl:
      for _, spec := range node.Specs {
        switch item := spec.(type) {
        case *ast.ImportSpec:
          value, err := strconv.Unquote(item.Path.Value)
          if err == nil {
            facts.Imports = append(facts.Imports, value)
          }
        case *ast.TypeSpec:
          kind := "typeAlias"
          switch item.Type.(type) {
          case *ast.StructType:
            kind = "class"
          case *ast.InterfaceType:
            kind = "interface"
          }
          doc := item.Doc
          if doc == nil {
            doc = node.Doc
          }
          copy := *item
          copy.Doc = nil
          copy.Comment = nil
          add(item.Name.Name, kind, "type " + printNode(&copy), item, doc, ast.IsExported(item.Name.Name))
        case *ast.ValueSpec:
          kind := "variable"
          if node.Tok == token.CONST {
            kind = "constant"
          }
          doc := item.Doc
          if doc == nil {
            doc = node.Doc
          }
          copy := *item
          copy.Doc = nil
          copy.Comment = nil
          for _, name := range item.Names {
            add(name.Name, kind, node.Tok.String() + " " + printNode(&copy), item, doc, ast.IsExported(name.Name))
          }
        }
      }
    }
  }
  if err := json.NewEncoder(os.Stdout).Encode(facts); err != nil {
    fmt.Fprintln(os.Stderr, "Go parser output:", err)
    os.Exit(1)
  }
}
