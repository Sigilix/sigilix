// SIG-146: Python code/dependency graph extraction.
//
// Pure, synchronous, Workers-compatible (no deps, no WASM) — the same
// contract as the acorn JS/TS extractor in graph-extract.ts. Produces the
// language-neutral FileGraph shape so the existing writeFileGraph + retrieval
// path handle Python with zero changes.
//
// v1 scope (mirrors JS/TS T1+T2): symbols (def/class, indentation-nested) +
// import edges. Call edges are deferred (resolution needs import-binding
// analysis — JS/TS shipped those as a separate task too), so callEdges is [].
//
// Why line-based and not a real parser: see docs/design/multi-language-code-graph.md.
// A real parser for Python (tree-sitter) is WASM and would force this module
// async. We anchor keyword matches at logical-line start and track triple-
// quoted strings, which avoids the common false-positive classes (keywords
// inside docstrings or string literals). Best-effort: never throws.

import {
  computeSymbolId,
  type FileGraph,
  type GraphSymbol,
  type FileEdgeRaw,
  type SymbolKind,
} from "./graph-extract-types"

interface Scope {
  /** Indentation width (count of leading whitespace chars) of the `def`/
   *  `class` keyword that opened this scope. */
  indent: number
  kind: "class" | "def"
}

/** Leading-whitespace width. Tabs count as one column (Python style is
 *  spaces; mixed indentation is rare and only affects method-vs-function
 *  classification, never correctness of the symbol itself). */
function indentWidth(line: string): number {
  let i = 0
  while (i < line.length && (line[i] === " " || line[i] === "\t")) i++
  return i
}

const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
const CLASS_RE = /^class\s+([A-Za-z_]\w*)\s*[:(]/
const IMPORT_RE = /^import\s+(.+)$/
const FROM_RE = /^from\s+(\.*[\w.]*)\s+import\s+(.+)$/

/**
 * Strip a Python comment from a line WITHOUT cutting inside a string.
 * Tracks single/double quotes; a `#` outside quotes starts a comment.
 * Returns the code portion (trailing whitespace preserved by caller's use).
 */
function stripComment(line: string): string {
  let inS: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inS) {
      if (c === "\\") { i++; continue }
      if (c === inS) inS = null
    } else if (c === '"' || c === "'") {
      inS = c
    } else if (c === "#") {
      return line.slice(0, i)
    }
  }
  return line
}

/** Count unescaped occurrences of a triple-quote delimiter in a line. */
function countTriple(line: string, delim: string): number {
  let n = 0
  let i = 0
  while ((i = line.indexOf(delim, i)) !== -1) { n++; i += 3 }
  return n
}

/** Split a comma list, respecting nothing fancy (Python import lists are flat
 *  identifiers, optionally `as`-aliased). Parens are stripped by the caller. */
function splitList(s: string): string[] {
  return s.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
}

function parseImportClause(clause: string): { specifier: string; localName: string } {
  // `a.b.c as d` | `a.b.c`
  const m = clause.match(/^([\w.]+)(?:\s+as\s+([A-Za-z_]\w*))?$/)
  if (!m) return { specifier: clause, localName: clause }
  return { specifier: m[1]!, localName: m[2] ?? m[1]! }
}

function parseFromName(name: string): { importedName: string; localName: string } | null {
  if (name === "*") return { importedName: "*", localName: "*" }
  const m = name.match(/^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/)
  if (!m) return null
  return { importedName: m[1]!, localName: m[2] ?? m[1]! }
}

/**
 * Extract symbols + import edges from a Python source file.
 * Pure + synchronous; returns an empty FileGraph for empty/whitespace input.
 */
export function extractPythonFileGraph(path: string, content: string): FileGraph {
  const symbols: GraphSymbol[] = []
  const fileEdgesRaw: FileEdgeRaw[] = []

  const rawLines = content.split("\n")
  const scopes: Scope[] = []
  // Triple-quoted string state: which delimiter we are currently inside, or
  // null. Spans multiple physical lines.
  let inTriple: '"""' | "'''" | null = null

  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx]!
    const lineNo = idx + 1

    // --- triple-quote state machine (skip docstring/string interiors) ---
    if (inTriple) {
      // Inside a multi-line string; only an odd count of the active delimiter
      // closes it. Nothing on this line is code we care about.
      if (countTriple(raw, inTriple) % 2 === 1) inTriple = null
      continue
    }
    // Not currently inside a triple string. Strip the trailing comment FIRST,
    // THEN detect a triple that opens (odd count) on this line — otherwise a
    // lone `"""`/`'''` sitting inside a `#` comment would flip string state
    // and swallow the rest of the file. `stripComment` is quote-aware, so it
    // will not cut a `#` that sits inside a string literal on this line.
    // (The close-detection branch above runs on `raw`, since inside an open
    // triple a `#` is literal string content, not a comment.)
    const code = stripComment(raw)
    for (const delim of ['"""', "'''"] as const) {
      if (countTriple(code, delim) % 2 === 1) { inTriple = delim; break }
    }

    const trimmed = code.trim()
    if (trimmed.length === 0) continue
    // If a triple string opened on this line, treat the line as string-ish and
    // skip structural parsing (avoids `x = """def foo()` false positives).
    if (inTriple) continue

    const indent = indentWidth(code)

    // Pop scopes we have dedented out of.
    while (scopes.length > 0 && indent <= scopes[scopes.length - 1]!.indent) {
      scopes.pop()
    }

    // --- imports (module-level or nested; both are real dependency edges) ---
    const fromM = trimmed.match(FROM_RE)
    if (fromM) {
      const specifier = fromM[1]!
      const names = splitList(fromM[2]!.replace(/[()]/g, ""))
      for (const n of names) {
        const parsed = parseFromName(n)
        if (!parsed) continue
        fileEdgesRaw.push({
          sourcePath: path,
          edgeKind: "import",
          specifier,
          importedName: parsed.importedName,
          localName: parsed.localName,
          exportedName: null,
          startLine: lineNo,
          startCol: indent,
        })
      }
      continue
    }
    const importM = trimmed.match(IMPORT_RE)
    if (importM) {
      for (const clause of splitList(importM[1]!)) {
        const { specifier, localName } = parseImportClause(clause)
        fileEdgesRaw.push({
          sourcePath: path,
          edgeKind: "import",
          specifier,
          importedName: null,
          localName,
          exportedName: null,
          startLine: lineNo,
          startCol: indent,
        })
      }
      continue
    }

    // --- symbols ---
    const classM = trimmed.match(CLASS_RE)
    if (classM) {
      pushSymbol(symbols, path, classM[1]!, "class", lineNo, indent, scopes)
      scopes.push({ indent, kind: "class" })
      continue
    }
    const defM = trimmed.match(DEF_RE)
    if (defM) {
      // A def lexically inside a class is a method; otherwise a function.
      const inClass = scopes.length > 0 && scopes[scopes.length - 1]!.kind === "class"
      pushSymbol(symbols, path, defM[1]!, inClass ? "method" : "function", lineNo, indent, scopes)
      scopes.push({ indent, kind: "def" })
      continue
    }
  }

  return { symbols, fileEdgesRaw, callEdges: [] }
}

function pushSymbol(
  symbols: GraphSymbol[],
  path: string,
  name: string,
  kind: SymbolKind,
  startLine: number,
  startCol: number,
  scopes: readonly Scope[],
): void {
  // `exported` ≈ importable cross-file: module-level (top of scope stack) and
  // not name-mangled/private (no leading underscore). Methods/nested are not.
  const topLevel = scopes.length === 0
  const exported = topLevel && !name.startsWith("_")
  symbols.push({
    symbolId: computeSymbolId(path, kind, name, startLine, startCol),
    path,
    name,
    kind,
    exported,
    startLine,
    startCol,
    // v1 records the declaration line as a point; block-extent end is not
    // needed by retrieval (which keys on start position) and computing it
    // adds indentation-tracking complexity for no current consumer.
    endLine: startLine,
    endCol: startCol,
  })
}
