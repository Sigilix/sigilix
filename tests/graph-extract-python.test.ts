// SIG-146: Python graph extractor + extension-router coverage.
// The routing tests exercise the real entry point (`extractFileGraph`) the
// indexer calls, so a regression that stops routing .py — or that breaks the
// existing JS/TS path — fails here.

import { describe, expect, it } from "vitest"
import { extractPythonFileGraph } from "../src/lib/graph-extract-python"
import { extractFileGraph } from "../src/lib/graph-extract"

const names = (src: string) =>
  extractPythonFileGraph("m.py", src).symbols.map((s) => `${s.kind}:${s.name}:${s.exported}`)

describe("extractPythonFileGraph — symbols", () => {
  it("extracts a top-level def as an exported function", () => {
    const syms = extractPythonFileGraph("m.py", "def add(a, b):\n    return a + b\n").symbols
    expect(syms).toHaveLength(1)
    expect(syms[0]).toMatchObject({ kind: "function", name: "add", exported: true, startLine: 1, startCol: 0 })
    expect(syms[0]!.symbolId).toBe("m.py function add 1 0")
  })

  it("treats a leading-underscore top-level name as not exported", () => {
    expect(names("def _private():\n    pass\n")).toEqual(["function:_private:false"])
  })

  it("classifies a def inside a class as a method (not exported)", () => {
    const src = "class Foo:\n    def bar(self):\n        return 1\n"
    expect(names(src)).toEqual(["class:Foo:true", "method:bar:false"])
  })

  it("classifies a def nested in a def as a function (not exported)", () => {
    const src = "def outer():\n    def inner():\n        return 1\n    return inner\n"
    expect(names(src)).toEqual(["function:outer:true", "function:inner:false"])
  })

  it("handles async def and decorators", () => {
    const src = "@app.route('/x')\nasync def handler():\n    return 1\n"
    const syms = extractPythonFileGraph("m.py", src).symbols
    expect(syms).toEqual([
      expect.objectContaining({ kind: "function", name: "handler", exported: true, startLine: 2 }),
    ])
  })

  it("does not extract keywords inside a triple-quoted docstring", () => {
    const src = [
      "def real():",
      '    """',
      "    def fake_in_doc():",
      "    import not_real",
      '    """',
      "    return 1",
    ].join("\n")
    expect(names(src)).toEqual(["function:real:true"])
    expect(extractPythonFileGraph("m.py", src).fileEdgesRaw).toHaveLength(0)
  })

  it("does not extract a def that appears in a comment", () => {
    expect(names("# def commented():\nx = 1\n")).toEqual([])
  })

  it("a lone triple-quote inside a # comment does not swallow later defs", () => {
    // Regression: triple-quote detection must run on the comment-stripped
    // line, else this stray `"""` flips string state and drops `real`.
    const src = [
      'x = 1  # a stray """ in a comment',
      "def real():",
      "    return 2",
    ].join("\n")
    expect(names(src)).toEqual(["function:real:true"])
  })

  it("a triple delimiter inside an ordinary string literal does not swallow the file", () => {
    // CodeRabbit catch: `x = '"""'` must not enter triple-string state.
    const src = ["x = '\"\"\"'", "def real():", "    return 2"].join("\n")
    expect(names(src)).toEqual(["function:real:true"])
  })

  it("skips a ''' docstring as well as a \"\"\" one", () => {
    const src = [
      "def real():",
      "    '''",
      "    def fake_in_doc():",
      "    '''",
      "    return 1",
    ].join("\n")
    expect(names(src)).toEqual(["function:real:true"])
  })
})

describe("extractPythonFileGraph — import edges", () => {
  it("plain import and dotted import-as", () => {
    const edges = extractPythonFileGraph("m.py", "import os\nimport a.b as c\n").fileEdgesRaw
    expect(edges).toEqual([
      expect.objectContaining({ edgeKind: "import", specifier: "os", importedName: null, localName: "os" }),
      expect.objectContaining({ edgeKind: "import", specifier: "a.b", importedName: null, localName: "c" }),
    ])
  })

  it("comma-separated import becomes one edge per module", () => {
    const edges = extractPythonFileGraph("m.py", "import os, sys\n").fileEdgesRaw
    expect(edges.map((e) => e.specifier)).toEqual(["os", "sys"])
  })

  it("from-import with and without alias", () => {
    const edges = extractPythonFileGraph("m.py", "from x.y import a, b as c\n").fileEdgesRaw
    expect(edges).toEqual([
      expect.objectContaining({ specifier: "x.y", importedName: "a", localName: "a" }),
      expect.objectContaining({ specifier: "x.y", importedName: "b", localName: "c" }),
    ])
  })

  it("relative from-import", () => {
    const edges = extractPythonFileGraph("m.py", "from . import helpers\n").fileEdgesRaw
    expect(edges[0]).toMatchObject({ specifier: ".", importedName: "helpers", localName: "helpers" })
  })

  it("parenthesized single-line from-import", () => {
    const edges = extractPythonFileGraph("m.py", "from pkg import (a, b)\n").fileEdgesRaw
    expect(edges.map((e) => e.importedName)).toEqual(["a", "b"])
  })

  it("does not treat `import` inside a string assignment as an edge", () => {
    expect(extractPythonFileGraph("m.py", 'doc = "import os"\n').fileEdgesRaw).toHaveLength(0)
  })

  it("v1 emits no call edges", () => {
    expect(extractPythonFileGraph("m.py", "def f():\n    g()\n").callEdges).toEqual([])
  })

  it("multi-line parenthesized import is a documented v1 gap (no edges)", () => {
    // Known limitation (see docs/design/multi-language-code-graph.md): only the
    // single-line form is parsed. Pin the current behavior so a future fix is
    // a deliberate change, not an accident.
    const src = "from pkg import (\n    a,\n    b,\n)\n"
    expect(extractPythonFileGraph("m.py", src).fileEdgesRaw).toEqual([])
  })
})

describe("extractFileGraph — extension router (SIG-146)", () => {
  it("routes .py to the Python extractor", () => {
    const fg = extractFileGraph("svc/app.py", "def handler():\n    return 1\n")
    expect(fg.symbols).toEqual([expect.objectContaining({ name: "handler", kind: "function" })])
  })

  it("still extracts JS/TS via acorn (unchanged)", () => {
    const fg = extractFileGraph("src/math.ts", "export function add(a: number, b: number) { return a + b }\n")
    expect(fg.symbols.map((s) => s.name)).toContain("add")
    expect(fg.symbols.find((s) => s.name === "add")?.exported).toBe(true)
  })

  it("returns an empty graph for an unsupported extension", () => {
    expect(extractFileGraph("notes.txt", "def add(): pass")).toEqual({ symbols: [], fileEdgesRaw: [], callEdges: [] })
  })
})
