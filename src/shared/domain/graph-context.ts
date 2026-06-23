// SIG-363: the graph payload vocabulary lifted from the RepoGraph DO so ports
// (`@/lib/ensemble/ports/graph`) and domain code can reference these contract
// types without importing the `@/do/repo-graph` infra layer. The DO re-exports
// every symbol, so existing importers are unchanged.
//
// Leaf module: imports nothing.

/**
 * A single node returned by `contextForVectorHits`.
 *
 * v1 returns file-level neighbors only — symbolId and name are always null.
 * Symbol-level enrichment is reserved for a future phase; the fields are kept
 * in the interface for forward-compat without requiring callers to change.
 */
export interface GraphContextNode {
  path: string
  /** Reserved for future symbol-level enrichment. Always null in v1. */
  symbolId: string | null
  /** Reserved for future symbol-level enrichment. Always null in v1. */
  name: string | null
  /** BFS hop count from the seed paths (1 = direct neighbor, 2 = neighbor-of-neighbor). */
  hop: number
  /** The `edge_kind` value from the file_edge that connected this node. */
  edgeKind: string
}

/** A changed symbol's declaration span in the active graph version. */
export interface GraphDefinitionRow {
  symbolId: string
  path: string
  name: string
  kind: string
  startLine: number
  endLine: number
}

/**
 * A call site of a changed symbol. `callerSymbolId` (and its span, when the
 * caller resolves to a known symbol) lets the consumer render the WHOLE caller
 * body instead of a bare window around the call line.
 *
 * Matched on `callee_symbol_id`, which `commitGraphVersion` sets for `same_file`
 * calls AND (SIG-286) for `imported_binding` cross-file calls whose import
 * resolves to an exported symbol — so a resolved cross-file caller IS returned
 * here. Unresolved imports (barrels / `export *`, default, namespace) keep a
 * null `callee_symbol_id` and are omitted: a deliberate high-precision,
 * lower-recall signal (prefer-missing-over-false), distinct from blastRadius's
 * name-based caller paths.
 */
export interface GraphCallerRow {
  sourcePath: string
  calleeName: string
  callKind: string
  startLine: number
  startCol: number
  callerSymbolId: string | null
  callerStartLine: number | null
  callerEndLine: number | null
}

/** An import edge that references a changed symbol (or a changed file). */
export interface GraphImportRow {
  sourcePath: string
  importedName: string | null
  startLine: number
}

/**
 * Result of contextExpansionForChangedSymbols. `graphAvailable=false` (with
 * empty rows) when there is no active graph version — mirrors the graceful
 * degrade in blastRadius / contextForVectorHits.
 */
export interface GraphContextExpansion {
  graphAvailable: boolean
  definitionRows: GraphDefinitionRow[]
  callerRows: GraphCallerRow[]
  importRows: GraphImportRow[]
}

/**
 * SIG-407: result of `enclosingSymbolsForHits` — the coordinate-keyed sibling of
 * `GraphContextExpansion`. Same row vocabulary, plus the active version's
 * `headSha` so the @-mention Q&A consumer can detect line-drift (the graph was
 * indexed at a different HEAD than the question) and fall back to the raw slice.
 * `headSha` is null exactly when `graphAvailable` is false (no active version).
 */
export interface GraphHitExpansion extends GraphContextExpansion {
  headSha: string | null
}

/**
 * SIG-527: one entry in the dependency-ranked "repo map" — a NAVIGATION-ONLY
 * pointer to a central symbol (no body, no signature; those aren't indexed).
 * `callerCount` is the number of distinct files that call the symbol (resolved
 * `callee_symbol_id`, so same-name symbols don't bleed together); `importerCount`
 * is the coarser number of distinct files that import the symbol's file. Together
 * they rank how depended-on a symbol is, giving a small model orientation +
 * coverage beyond the retrieved chunks.
 */
export interface RepoMapEntry {
  path: string
  name: string
  kind: string
  line: number
  exported: boolean
  callerCount: number
  importerCount: number
}

/** A dependency-ranked repo map: `RepoMapEntry[]`, most-depended-on first. */
export type RepoMap = RepoMapEntry[]
