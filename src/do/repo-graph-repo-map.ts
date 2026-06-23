// SIG-527: row-level "repo map" SQL for RepoGraphDO, lifted out of the DO class
// so `repo-graph.ts` stays within its 1,000-line file-size budget (COMPLIANCE.md
// §4) — the same leaf-helper precedent already proven on this file with
// `repo-graph-internals.ts` and `repo-graph-expansion.ts`. This is a pure query
// helper over the DO's (schema-initialised) SqlStorage handle: it holds no DO
// state; the caller passes the handle and the committed graph version in.
//
// The "repo map" (Aider-style) is a compact, dependency-ranked, NAVIGATION-ONLY
// list of the most-depended-on symbols — `path:line — kind name (importance)`,
// with NO bodies/signatures (those aren't indexed). It gives a small model
// orientation + coverage beyond the retrieved chunks.

import type { RepoMapEntry } from "@/src/shared/domain/graph-context"

type Sql = DurableObjectStorage["sql"]

/**
 * Score boost applied to a symbol whose file is in `biasPaths` (the current
 * turn's retrieval-hit paths). Pulls the symbols local to what the agent is
 * already looking at toward the top of the map, without overriding a genuinely
 * far-more-central symbol elsewhere. Tie-break ordering still applies underneath.
 */
const BIAS_BOOST = 5

/**
 * Hard upper bound on the rows the repo-map query may return, regardless of the
 * requested `limit`. The render's char cap bounds the eventual bytes, but the
 * SQL itself must stay bounded so a hostile/oversized `limit` can't pull a huge
 * rowset out of SQLite (Codex fix #3). Comfortably above any sane render size.
 */
export const MAX_REPO_MAP_ROWS = 200

/**
 * Build the dependency-ranked repo map for `graphVersion`: the `limit` most
 * depended-on symbols, NAVIGATION-ONLY (path/line/kind/name + the two counts).
 *
 *  - callerCount = COUNT(DISTINCT source_path) over `call_edges`, grouped by
 *    `callee_symbol_id` — matched on the RESOLVED id (not the bare name) so two
 *    same-named symbols in different files don't bleed their callers together.
 *  - importerCount = COUNT(DISTINCT source_path) over `file_edges`, grouped by
 *    `target_path` — coarse, file-level: how many files import the symbol's file.
 *    A file-centrality PRIOR, not proof the specific symbol is imported, so it
 *    enters the score and orders ties but does not, alone, beat caller count.
 *  - directImporterCount = COUNT(DISTINCT source_path) over `file_edges` grouped
 *    by the RESOLVED `target_symbol_id` — a sharper, symbol-level import signal
 *    (Codex fix #5). It contributes to the score; the file-level count is the
 *    weaker tie-breaker beneath it.
 *  - score = callerCount + directImporterCount + importerCount
 *            + (path ∈ biasPaths ? BIAS_BOOST : 0).
 *  - sort: score DESC, callerCount DESC, directImporterCount DESC,
 *    importerCount DESC, exported DESC, path ASC, line ASC, kind ASC, name ASC,
 *    symbol_id ASC — fully deterministic, so `LIMIT` is stable run-to-run.
 *
 * The counts kept on each entry stay the spec's two (caller + the file-level
 * importer) — the direct count is a ranking-only refinement, not a payload field.
 *
 * Private symbols ARE eligible (centrality, not visibility, is the signal —
 * `exported` only breaks ties). The query joins each aggregate as its OWN
 * subquery scoped to its key (caller→symbol_id, importer→path,
 * direct-importer→symbol_id) so the counts never multiply across a raw join
 * (Codex fix #1). Returns `RepoMapEntry[]`, most-central first.
 */
export function repoMapRows(
  sql: Sql,
  graphVersion: string,
  opts: { limit: number; biasPaths: readonly string[] },
): RepoMapEntry[] {
  const limit = opts.limit
  if (!Number.isFinite(limit) || limit < 1) return []

  // De-dup bias paths and build the IN(...) placeholder list (empty → no bias).
  const biasPaths = [...new Set(opts.biasPaths)]
  const biasPlaceholders = biasPaths.map(() => "?").join(",")
  const biasExpr =
    biasPaths.length > 0 ? `CASE WHEN s.path IN (${biasPlaceholders}) THEN ${BIAS_BOOST} ELSE 0 END` : "0"

  // Each aggregate is its OWN LEFT JOINed subquery keyed to the column it groups
  // on, so the counts can't multiply across one another; COALESCE turns a no-edge
  // symbol into 0 rather than dropping it from the map.
  const rows = [
    ...sql.exec<{
      path: string
      name: string
      kind: string
      start_line: number
      exported: number
      caller_count: number
      importer_count: number
    }>(
      `SELECT s.path AS path, s.name AS name, s.kind AS kind, s.start_line AS start_line, s.exported AS exported,
              COALESCE(cc.caller_count, 0) AS caller_count,
              COALESCE(ic.importer_count, 0) AS importer_count,
              COALESCE(dic.direct_importer_count, 0) AS direct_importer_count
         FROM symbols s
         LEFT JOIN (
           SELECT callee_symbol_id, COUNT(DISTINCT source_path) AS caller_count
             FROM call_edges
            WHERE graph_version = ? AND callee_symbol_id IS NOT NULL
            GROUP BY callee_symbol_id
         ) cc ON cc.callee_symbol_id = s.symbol_id
         LEFT JOIN (
           SELECT target_path, COUNT(DISTINCT source_path) AS importer_count
             FROM file_edges
            WHERE graph_version = ? AND target_path IS NOT NULL
            GROUP BY target_path
         ) ic ON ic.target_path = s.path
         LEFT JOIN (
           SELECT target_symbol_id, COUNT(DISTINCT source_path) AS direct_importer_count
             FROM file_edges
            WHERE graph_version = ? AND target_symbol_id IS NOT NULL
            GROUP BY target_symbol_id
         ) dic ON dic.target_symbol_id = s.symbol_id
        WHERE s.graph_version = ?
        ORDER BY (COALESCE(cc.caller_count, 0) + COALESCE(dic.direct_importer_count, 0) + COALESCE(ic.importer_count, 0) + ${biasExpr}) DESC,
                 caller_count DESC, direct_importer_count DESC, importer_count DESC, s.exported DESC,
                 s.path ASC, s.start_line ASC, s.kind ASC, s.name ASC, s.symbol_id ASC
        LIMIT ?`,
      graphVersion,
      graphVersion,
      graphVersion,
      graphVersion,
      ...biasPaths,
      limit,
    ),
  ]

  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    kind: r.kind,
    line: r.start_line,
    exported: r.exported !== 0,
    callerCount: r.caller_count,
    importerCount: r.importer_count,
  }))
}
