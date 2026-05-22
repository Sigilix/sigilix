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

// T2: file import/export edges (raw, unresolved specifiers).
// T3 fills callEdges; stub kept until that task lands.
export type FileEdgeKind = "import" | "export" | "reexport" | "star_reexport"

export interface FileEdgeRaw {
  sourcePath: string
  edgeKind: FileEdgeKind
  specifier: string
  importedName: string | null
  localName: string | null
  exportedName: string | null
  startLine: number
  startCol: number
}

export type CallKind = "same_file" | "imported_binding"

export interface CallEdge {
  sourcePath: string
  callerSymbolId: string | null
  calleeSymbolId: string | null
  calleeName: string
  callKind: CallKind
  startLine: number
  startCol: number
}

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
      const wrapper = exportedDecls.get(node)
      const name: unknown = node.id?.name ?? (wrapper?.type === "ExportDefaultDeclaration" ? "default" : undefined)
      if (typeof name === "string" && name.length > 0) {
        // Use wrapper loc when exported so startCol covers `export` keyword
        // (e.g. col 0), matching the test expectation for symbolId.
        push(name, "function", wrapper ?? node, wrapper != null)
      }
    },
    ClassDeclaration(node: AstNode) {
      const wrapper = exportedDecls.get(node)
      const name: unknown = node.id?.name ?? (wrapper?.type === "ExportDefaultDeclaration" ? "default" : undefined)
      if (typeof name === "string" && name.length > 0) {
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

  // Pass 3: collect raw file edges (import / re-export declarations).
  // ExportNamedDeclaration with a declaration (local `export function f(){}`)
  // is intentionally skipped here — those are already captured as symbols in
  // Pass 2 and produce no file edge. Only source-bearing export nodes create
  // edges (re-exports). Bare `export { x }` without a source is also skipped.
  const fileEdgesRaw: FileEdgeRaw[] = []

  const pushEdge = (
    edgeKind: FileEdgeKind,
    specifier: string,
    importedName: string | null,
    localName: string | null,
    exportedName: string | null,
    node: AstNode,
  ): void => {
    const s = node.loc.start
    fileEdgesRaw.push({
      sourcePath: path,
      edgeKind,
      specifier,
      importedName,
      localName,
      exportedName,
      startLine: s.line,
      startCol: s.column,
    })
  }

  walkAst(ast, {
    ImportDeclaration(node: AstNode) {
      const specifier: string = node.source?.value ?? ""
      if (!specifier) return
      const specifiers: AstNode[] = node.specifiers ?? []
      if (specifiers.length === 0) {
        // Side-effect import: `import './polyfill'`
        pushEdge("import", specifier, null, null, null, node)
        return
      }
      for (const spec of specifiers) {
        let importedName: string | null = null
        const localName: string | null = spec.local?.name ?? null
        if (spec.type === "ImportDefaultSpecifier") {
          // `import Default from './m'` — imported binding is "default"
          importedName = "default"
        } else if (spec.type === "ImportNamespaceSpecifier") {
          // `import * as ns from './m'` — no single importedName
          importedName = null
        } else {
          // ImportSpecifier: `import { add }` or `import { sub as minus }`
          // spec.imported holds the source name; spec.local holds the local alias.
          importedName = spec.imported?.name ?? spec.imported?.value ?? null
        }
        pushEdge("import", specifier, importedName, localName, null, node)
      }
    },

    ExportNamedDeclaration(node: AstNode) {
      // Only source-bearing re-exports create file edges; local export
      // declarations (`export function f(){}`) are handled by the symbol pass.
      if (!node.source) return
      const specifier: string = node.source?.value ?? ""
      if (!specifier) return
      const specifiers: AstNode[] = node.specifiers ?? []
      for (const spec of specifiers) {
        // spec.local is the name in the source module; spec.exported is the
        // name re-exported from this module.
        const importedName: string | null = spec.local?.name ?? spec.local?.value ?? null
        const exportedName: string | null = spec.exported?.name ?? spec.exported?.value ?? null
        pushEdge("reexport", specifier, importedName, null, exportedName, node)
      }
    },

    ExportAllDeclaration(node: AstNode) {
      // `export * from './all'` or `export * as ns from './all'`
      const specifier: string = node.source?.value ?? ""
      if (!specifier) return
      const exportedName: string | null = node.exported?.name ?? node.exported?.value ?? null
      pushEdge("star_reexport", specifier, null, null, exportedName, node)
    },
  })

  // Pass 4: collect call edges (best-effort, raw — callerSymbolId/calleeSymbolId
  // resolved in Task 5 inside the DO). Only tracks `CallExpression` nodes whose
  // callee is a plain `Identifier` — member calls (`obj.method()`) and computed
  // calls are intentionally dropped (prefer missing over false positives).
  //
  // Resolution order: local function name wins over an imported binding with the
  // same name (same_file takes precedence). This matches static scoping: a local
  // declaration shadows the import.
  // Exclude namespace imports (importedName === null, e.g. `import * as ns`)
  // from the importedNames set. Namespace object refs are not callable as
  // bare imported bindings; including them causes false imported_binding edges.
  const importedNames = new Set(
    fileEdgesRaw
      .filter((e) => e.edgeKind === "import" && e.importedName !== null && e.localName != null)
      .map((e) => e.localName as string),
  )
  // NOTE: same_file calls are matched against function declarations only. Calls to
  // arrow-function consts (kind "variable", e.g. `const f = () => {}`) are NOT captured
  // here — a known recall gap, deferred pending Phase 2 shadow telemetry. Prefer-missing
  // over false: widening to "variable" risks false edges for non-callable consts.
  const localFns = new Set(
    symbols.filter((s) => s.kind === "function").map((s) => s.name),
  )

  const callEdges: CallEdge[] = []
  walkAst(ast, {
    CallExpression(node: AstNode) {
      if (node.callee?.type !== "Identifier") return
      const name: string = node.callee.name as string
      if (!name) return
      const s = node.loc.start
      if (localFns.has(name)) {
        callEdges.push({
          sourcePath: path,
          callerSymbolId: null,
          calleeSymbolId: null,
          calleeName: name,
          callKind: "same_file",
          startLine: s.line,
          startCol: s.column,
        })
      } else if (importedNames.has(name)) {
        callEdges.push({
          sourcePath: path,
          callerSymbolId: null,
          calleeSymbolId: null,
          calleeName: name,
          callKind: "imported_binding",
          startLine: s.line,
          startCol: s.column,
        })
      }
      // Unknown free identifier — skip (prefer missing over false positive)
    },
  })

  return { symbols, fileEdgesRaw, callEdges }
}
