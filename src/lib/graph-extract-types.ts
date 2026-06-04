// SIG-146: shared contract for per-language graph extractors.
//
// The language-neutral FileGraph shape + symbolId key live here so each
// extractor module (JS/TS via acorn, Python via graph-extract-python, future
// SCIP importers) can depend on the contract WITHOUT importing each other —
// `graph-extract.ts` (the router) imports the language modules, and the
// language modules import only this. Keeps the dependency graph acyclic.

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

// File import/export edges (raw, unresolved specifiers).
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
