// SIG-138 T1: Per-file code/dependency graph extraction.
//
// Pure, synchronous module — no I/O. Called once per file by the indexer
// (T7). T2 (file import edges) and T3 (call edges) extend the same
// FileGraph shape by populating fileEdgesRaw and callEdges respectively;
// this file owns only symbol extraction.
//
// Export-detection approach: TWO-PASS.
// acorn-walk.simple is post-order: children fire before their enclosing
// parent. ExportNamedDeclaration/ExportDefaultDeclaration therefore fires
// AFTER the FunctionDeclaration/VariableDeclaration inside it has already
// been visited. A single-pass _exported-flag approach would always miss the
// inner declaration. We instead do:
//   Pass 1 — collect all exported declaration nodes into a Set<object>.
//   Pass 2 — walk for FunctionDeclaration / ClassDeclaration /
//             MethodDefinition / VariableDeclaration and check Set membership.
// This is O(2n) on AST nodes but both passes are cheap and O(n) memory.

import { parseSource, type SourceExt } from "./ast-rules/parser"
import { walkAst, type AstNode } from "./ast-rules/walker"

export type SymbolKind = "function" | "class" | "method" | "variable"

export interface GraphSymbol {
  symbolId: string
  path: string
  name: string
  kind: SymbolKind
  exported: boolean
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

// T2/T3 fill these; stubs so FileGraph compiles before those tasks land.
// Record<string, never> is the empty-object-friendly alternative to an
// empty interface (avoids @typescript-eslint/no-empty-interface if that
// rule is ever added).
export type FileEdgeRaw = Record<string, never>
export type CallEdge = Record<string, never>

export interface FileGraph {
  symbols: GraphSymbol[]
  fileEdgesRaw: FileEdgeRaw[]
  callEdges: CallEdge[]
}

/** Natural-key composite string used as symbolId. Synchronous, no hashing. */
export function computeSymbolId(
  path: string,
  kind: SymbolKind,
  name: string,
  startLine: number,
  startCol: number,
): string {
  return `${path} ${kind} ${name} ${startLine} ${startCol}`
}

const KNOWN_EXTS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
])

function sourceExt(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(ext) ? (ext as SourceExt) : null
}

/**
 * Extract the symbol table (and stub edges) for a single source file.
 * Returns an empty FileGraph on unsupported extensions or parse failure —
 * never throws. Prefers missing symbols over false ones.
 */
export function extractFileGraph(path: string, content: string): FileGraph {
  const empty: FileGraph = { symbols: [], fileEdgesRaw: [], callEdges: [] }

  const ext = sourceExt(path)
  if (!ext) return empty

  const parsed = parseSource(content, ext)
  if (!parsed.ok) return empty

  const ast = parsed.ast as AstNode

  // Pass 1: collect exported declaration nodes → their wrapper node.
  // ExportNamedDeclaration.declaration holds the inner FunctionDeclaration /
  // ClassDeclaration / VariableDeclaration. We map declaration→wrapper so
  // Pass 2 can use the wrapper's loc (which starts at col 0, covering the
  // `export` keyword) instead of the inner declaration's loc (which starts
  // at the `function`/`class` keyword offset). The test expectation
  // "src/math.ts function add 1 0" confirms the outer export-wrapper loc
  // is what callers consider the symbol's source position.
  const exportedDecls = new Map<object, AstNode>()
  walkAst(ast, {
    ExportNamedDeclaration(node: AstNode) {
      if (node.declaration != null) exportedDecls.set(node.declaration, node)
    },
    ExportDefaultDeclaration(node: AstNode) {
      if (node.declaration != null) exportedDecls.set(node.declaration, node)
    },
  })

  // Pass 2: collect symbols. loc.start.line is 1-based (acorn with
  // locations:true). column is 0-based.
  const symbols: GraphSymbol[] = []
  const push = (
    name: string,
    kind: SymbolKind,
    locNode: AstNode,
    exported: boolean,
  ): void => {
    if (!name) return
    const s = locNode.loc.start
    const e = locNode.loc.end
    symbols.push({
      symbolId: computeSymbolId(path, kind, name, s.line, s.column),
      path,
      name,
      kind,
      exported,
      startLine: s.line,
      startCol: s.column,
      endLine: e.line,
      endCol: e.column,
    })
  }

  walkAst(ast, {
    FunctionDeclaration(node: AstNode) {
      const name: unknown = node.id?.name
      if (typeof name === "string" && name.length > 0) {
        const wrapper = exportedDecls.get(node)
        // Use wrapper loc when exported so startCol covers `export` keyword
        // (e.g. col 0), matching the test expectation for symbolId.
        push(name, "function", wrapper ?? node, wrapper != null)
      }
    },
    ClassDeclaration(node: AstNode) {
      const name: unknown = node.id?.name
      if (typeof name === "string" && name.length > 0) {
        const wrapper = exportedDecls.get(node)
        push(name, "class", wrapper ?? node, wrapper != null)
      }
    },
    MethodDefinition(node: AstNode) {
      // key.name for identifier keys; key.value for string-literal keys.
      const name = node.key?.name ?? (typeof node.key?.value === "string" ? node.key.value : undefined)
      if (typeof name === "string" && name.length > 0) {
        // Methods are never directly exported (export lives on the class).
        push(name, "method", node, false)
      }
    },
    VariableDeclaration(node: AstNode) {
      const wrapper = exportedDecls.get(node)
      if (wrapper == null) return
      for (const decl of node.declarations ?? []) {
        if (decl.id?.type === "Identifier") {
          const name: unknown = decl.id.name
          if (typeof name === "string" && name.length > 0) {
            // Use the export-wrapper loc for the same reason as
            // FunctionDeclaration above: startCol 0 covers `export`.
            push(name, "variable", wrapper, true)
          }
        }
      }
    },
  })

  return { symbols, fileEdgesRaw: [], callEdges: [] }
}
