// SIG-407: row-level graph-expansion SQL for RepoGraphDO, lifted out of the DO
// class so `repo-graph.ts` stays within its 1,000-line file-size budget
// (COMPLIANCE.md §4) — the same split precedent already proven on this file with
// `repo-graph-internals.ts`. These are pure query helpers over the DO's
// (schema-initialised) SqlStorage handle: they hold no DO state, and the caller
// passes the handle in. Both the name-keyed (`contextExpansionForChangedSymbols`)
// and coordinate-keyed (`enclosingSymbolsForHits`) entries delegate here so the
// edge SQL lives in exactly one place.

import type { GraphDefinitionRow, GraphCallerRow, GraphImportRow } from "@/src/shared/domain/graph-context"

type Sql = DurableObjectStorage["sql"]

/**
 * SIG-286 / SIG-407: the shared expansion tail. Given symbol `ids` already
 * resolved within `active` and the `paths` in scope, return the definition
 * spans, caller rows, and import rows — each independently capped at `maxRows`.
 * Callers guarantee `ids` and `paths` are non-empty.
 */
export function expansionForIds(
  sql: Sql,
  active: string,
  ids: string[],
  paths: string[],
  maxRows: number,
): { definitionRows: GraphDefinitionRow[]; callerRows: GraphCallerRow[]; importRows: GraphImportRow[] } {
  const idPlaceholders = ids.map(() => "?").join(",")
  const pathPlaceholders = paths.map(() => "?").join(",")

  // definitionRows: the resolved symbols' own declaration spans.
  const definitionRows: GraphDefinitionRow[] = [
    ...sql.exec<{
      symbol_id: string
      path: string
      name: string
      kind: string
      start_line: number
      end_line: number
    }>(
      `SELECT symbol_id, path, name, kind, start_line, end_line FROM symbols WHERE graph_version = ? AND symbol_id IN (${idPlaceholders}) ORDER BY path, start_line LIMIT ?`,
      active,
      ...ids,
      maxRows,
    ),
  ].map((r) => ({
    symbolId: r.symbol_id,
    path: r.path,
    name: r.name,
    kind: r.kind,
    startLine: r.start_line,
    endLine: r.end_line,
  }))

  // callerRows: call sites of a resolved symbol (same-file + SIG-286 resolved
  // cross-file imported_binding callers, both matched on callee_symbol_id),
  // LEFT JOINed to the caller symbol's span so the consumer can render the
  // whole caller body.
  const callerRows: GraphCallerRow[] = [
    ...sql.exec<{
      source_path: string
      callee_name: string
      call_kind: string
      start_line: number
      start_col: number
      caller_symbol_id: string | null
      caller_start_line: number | null
      caller_end_line: number | null
    }>(
      `SELECT ce.source_path, ce.callee_name, ce.call_kind, ce.start_line, ce.start_col,
              ce.caller_symbol_id,
              cs.start_line AS caller_start_line, cs.end_line AS caller_end_line
         FROM call_edges ce
         LEFT JOIN symbols cs
           ON cs.graph_version = ce.graph_version AND cs.symbol_id = ce.caller_symbol_id
        WHERE ce.graph_version = ? AND ce.callee_symbol_id IN (${idPlaceholders})
        ORDER BY ce.source_path, ce.start_line
        LIMIT ?`,
      active,
      ...ids,
      maxRows,
    ),
  ].map((r) => ({
    sourcePath: r.source_path,
    calleeName: r.callee_name,
    callKind: r.call_kind,
    startLine: r.start_line,
    startCol: r.start_col,
    callerSymbolId: r.caller_symbol_id,
    callerStartLine: r.caller_start_line,
    callerEndLine: r.caller_end_line,
  }))

  // importRows: import edges referencing a resolved symbol (resolved
  // target_symbol_id) OR a path in scope (target_path). Matching either side
  // captures both symbol-resolved and ambiguous-but-path-resolved importers.
  const importRows: GraphImportRow[] = [
    ...sql.exec<{ source_path: string; imported_name: string | null; start_line: number }>(
      `SELECT DISTINCT source_path, imported_name, start_line FROM file_edges WHERE graph_version = ? AND (target_symbol_id IN (${idPlaceholders}) OR target_path IN (${pathPlaceholders})) ORDER BY source_path, start_line LIMIT ?`,
      active,
      ...ids,
      ...paths,
      maxRows,
    ),
  ].map((r) => ({
    sourcePath: r.source_path,
    importedName: r.imported_name,
    startLine: r.start_line,
  }))

  return { definitionRows, callerRows, importRows }
}

/**
 * SIG-407: resolve a single retrieval hit (path + line range) to the symbol_id
 * of its ENCLOSING symbol in `graphVersion`, or null when the hit lands in no
 * symbol (e.g. a non-indexed file). The enclosing symbol is the one whose
 * declaration span has the GREATEST line overlap with the hit; ties broken by
 * the INNERMOST (smallest) span, then the lowest start_line — fully
 * deterministic. Range-aware on purpose: hits are arbitrary ~30-line windows /
 * AST chunks, so a single-line lookup would mis-home a hit that straddles a
 * symbol boundary.
 */
export function resolveEnclosingSymbolId(
  sql: Sql,
  graphVersion: string,
  hit: { path: string; lineStart: number; lineEnd: number },
): string | null {
  // Guard a malformed/zero-width range: a swapped hit (lineEnd < lineStart) would
  // still satisfy the overlap predicate and mis-home onto an arbitrary nearby
  // symbol, so treat it as "no enclosing symbol."
  if (hit.lineEnd < hit.lineStart) return null
  const rows = [
    ...sql.exec<{ symbol_id: string }>(
      // Enclosing = span overlaps the hit range (start_line <= hitEnd AND
      // end_line >= hitStart). Rank by overlap length DESC, then innermost span
      // ASC, then start_line ASC. MIN/MAX are the 2-arg SCALAR forms (not
      // aggregates — there is no GROUP BY).
      `SELECT symbol_id FROM symbols
        WHERE graph_version = ? AND path = ? AND start_line <= ? AND end_line >= ?
        ORDER BY (MIN(end_line, ?) - MAX(start_line, ?) + 1) DESC, (end_line - start_line) ASC, start_line ASC
        LIMIT 1`,
      graphVersion,
      hit.path,
      hit.lineEnd,
      hit.lineStart,
      hit.lineEnd,
      hit.lineStart,
    ),
  ]
  return rows[0]?.symbol_id ?? null
}
