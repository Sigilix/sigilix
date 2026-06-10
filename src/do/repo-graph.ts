// SIG-138: RepoGraphDO — per-repo code/dependency graph in SQLite.
//
// Spec:  docs/superpowers/specs/2026-05-22-sig-138-graph-retrieval-phase-1-2-design.md
// Plan:  docs/superpowers/plans/2026-05-22-sig-138-graph-retrieval-phase-1-2.md Task 4
//
// Each DO instance holds ONE repo's graph, keyed by
// `indexNamespace(owner, repo)`. Data is versioned by `graph_version`
// (= the indexer's runId). The Phase 1 write path:
//   1. Indexer calls upsertFileGraph() per file — rows land `pending`.
//   2. After manifest commits, commitGraphVersion() resolves import
//      edges, flips the version `active`, GCs the old one. (Task 5)
//
// Later tasks add blastRadius + contextForVectorHits read methods
// (Tasks 10/11) and deleteRepoGraph (Task 6). The class is designed
// so those slot in as additional public methods.

import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
// SIG-376 (Tier-1 2/8): the DO's pure internals — its structured-log
// emitter, the lazy SQLite schema, the relative-import resolver, and the
// bounding constants — were lifted into a leaf module so this file stays
// under the 1,000-line budget. The three previously-public symbols
// (`resolveRelative`, `MAX_BLAST_IDS`, `DEFAULT_EXPANSION_ROWS`) are
// re-exported below so every importer of `@/do/repo-graph` is unchanged.
// This follows the SIG-363 precedent already proven on this file (the
// graph-context payload types live in `shared/domain/graph-context`).
import {
  emit,
  SCHEMA,
  resolveRelative,
  CANDIDATE_EXTS,
  MAX_BLAST_IDS,
  DEFAULT_EXPANSION_ROWS,
} from "./repo-graph-internals"
export { resolveRelative, MAX_BLAST_IDS, DEFAULT_EXPANSION_ROWS }

// ─── Public result types ──────────────────────────────────────────
//
// SIG-363: the result + context-expansion row types moved to a shared/domain
// leaf so ports/domain can reference the graph payload vocabulary without
// importing this DO (which would invert the dependency rule). Re-exported here
// so the existing importers of this module are unchanged.
//
//   - `GraphContextNode` is the per-node result of `contextForVectorHits`
//     (file-level neighbors; v1 leaves symbolId/name null).
//   - `GraphDefinitionRow`/`GraphCallerRow`/`GraphImportRow`/
//     `GraphContextExpansion` are the SIG-286 context-expansion rows:
//     `contextExpansionForChangedSymbols` returns LOCATIONS only (no body
//     text) — the DO never stores source; the ensemble slices bodies from
//     filesByPath / fetched content.
import type {
  GraphContextNode,
  GraphDefinitionRow,
  GraphCallerRow,
  GraphImportRow,
  GraphContextExpansion,
} from "@/src/shared/domain/graph-context"
export type {
  GraphContextNode,
  GraphDefinitionRow,
  GraphCallerRow,
  GraphImportRow,
  GraphContextExpansion,
}

// ─── Public arg types ─────────────────────────────────────────────

export interface UpsertFileGraphArgs {
  /** Indexer run ID — becomes the graph_version key. */
  runId: string
  /** HEAD SHA at index time. */
  headSha: string
  /** Repo-relative file path, e.g. "src/lib/foo.ts". */
  path: string
  symbols: Array<{
    symbolId: string
    path: string
    name: string
    kind: string
    exported: boolean
    startLine: number
    startCol: number
    endLine: number
    endCol: number
  }>
  fileEdgesRaw: Array<{
    sourcePath: string
    edgeKind: string
    specifier: string
    importedName: string | null
    localName: string | null
    exportedName: string | null
    startLine: number
    startCol: number
  }>
  callEdges: Array<{
    sourcePath: string
    calleeName: string
    callKind: string
    startLine: number
    startCol: number
  }>
}

// ─── DO class ────────────────────────────────────────────────────

export class RepoGraphDO extends DurableObject<Env> {
  /** Set to true after the first sql() call initialises the schema. */
  private ready = false

  /** Lazily initialise schema and return the sql handle. */
  private sql(): DurableObjectStorage["sql"] {
    if (!this.ready) {
      this.ctx.storage.sql.exec(SCHEMA)
      this.ready = true
    }
    return this.ctx.storage.sql
  }

  /** Deterministic edge identifier. */
  private edgeId(prefix: string, path: string, line: number, col: number, extra: string): string {
    return `${prefix}:${path}:${line}:${col}:${extra}`
  }

  /**
   * Write one file's symbols + edges for a pending graph version.
   *
   * Idempotent: deletes this file's existing rows for the version
   * before re-inserting, so a retry after a partial write produces the
   * same result with no duplicates.
   *
   * Runs inside a single transactionSync so the caller never observes
   * partial state.
   */
  async upsertFileGraph(args: UpsertFileGraphArgs): Promise<void> {
    const sql = this.sql()
    const now = new Date().toISOString()

    this.ctx.storage.transactionSync(() => {
      // Ensure version row exists (pending). Idempotent — DO NOTHING on
      // retry so we never overwrite a committed_at that Task 5 will set.
      sql.exec(
        "INSERT INTO graph_versions (graph_version, head_sha, status, created_at) VALUES (?, ?, 'pending', ?) ON CONFLICT(graph_version) DO NOTHING",
        args.runId, args.headSha, now,
      )

      // Delete this file's existing rows for this version so the
      // subsequent inserts are the sole source of truth (idempotent).
      sql.exec(
        "DELETE FROM symbols WHERE graph_version = ? AND path = ?",
        args.runId, args.path,
      )
      sql.exec(
        "DELETE FROM file_edges WHERE graph_version = ? AND source_path = ?",
        args.runId, args.path,
      )
      sql.exec(
        "DELETE FROM call_edges WHERE graph_version = ? AND source_path = ?",
        args.runId, args.path,
      )

      // Insert symbols. ON CONFLICT DO NOTHING: a duplicate symbol_id
      // within one payload (same file, same symbolId) is silently
      // ignored rather than aborting the entire file write.
      for (const s of args.symbols) {
        sql.exec(
          "INSERT INTO symbols (graph_version, symbol_id, path, name, kind, exported, start_line, start_col, end_line, end_col) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          args.runId, s.symbolId, s.path, s.name, s.kind,
          s.exported ? 1 : 0,
          s.startLine, s.startCol, s.endLine, s.endCol,
        )
      }

      // Insert raw file edges. target_path + target_symbol_id are NULL
      // until commitGraphVersion() resolves them (Task 5).
      // ON CONFLICT DO NOTHING: duplicate edge_id within one payload is
      // silently ignored rather than aborting the file write.
      for (const e of args.fileEdgesRaw) {
        const edgeId = this.edgeId(
          "fe", e.sourcePath, e.startLine, e.startCol,
          `${e.specifier}|${e.importedName ?? ""}`,
        )
        sql.exec(
          "INSERT INTO file_edges (graph_version, edge_id, source_path, edge_kind, specifier, imported_name, local_name, exported_name, resolution_status, start_line, start_col) VALUES (?,?,?,?,?,?,?,?,'raw',?,?) ON CONFLICT DO NOTHING",
          args.runId, edgeId, e.sourcePath, e.edgeKind, e.specifier,
          e.importedName, e.localName, e.exportedName,
          e.startLine, e.startCol,
        )
      }

      // Insert call edges. caller_symbol_id + callee_symbol_id are NULL
      // until commitGraphVersion() resolves them (Task 5).
      // ON CONFLICT DO NOTHING: duplicate edge_id within one payload is
      // silently ignored rather than aborting the file write.
      for (const c of args.callEdges) {
        const edgeId = this.edgeId(
          "ce", c.sourcePath, c.startLine, c.startCol, c.calleeName,
        )
        sql.exec(
          "INSERT INTO call_edges (graph_version, edge_id, source_path, callee_name, call_kind, start_line, start_col) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          args.runId, edgeId, c.sourcePath, c.calleeName, c.callKind,
          c.startLine, c.startCol,
        )
      }
    })

    emit("graph-file-upserted", {
      runId: args.runId, path: args.path,
      symbols: args.symbols.length,
      fileEdges: args.fileEdgesRaw.length,
      callEdges: args.callEdges.length,
    })
  }

  /**
   * Return row counts by type for a graph version, plus the version's
   * status string. Used by tests; also useful for ops introspection.
   */
  async debugCounts(graphVersion: string): Promise<{
    symbols: number
    fileEdges: number
    callEdges: number
    status: string | null
  }> {
    const sql = this.sql()

    const one = (query: string): number =>
      ([...sql.exec<{ n: number }>(query, graphVersion)][0]?.n ?? 0)

    const statusRows = [
      ...sql.exec<{ status: string }>(
        "SELECT status FROM graph_versions WHERE graph_version = ?",
        graphVersion,
      ),
    ]

    return {
      symbols: one("SELECT COUNT(*) n FROM symbols WHERE graph_version = ?"),
      fileEdges: one("SELECT COUNT(*) n FROM file_edges WHERE graph_version = ?"),
      callEdges: one("SELECT COUNT(*) n FROM call_edges WHERE graph_version = ?"),
      status: statusRows[0]?.status ?? null,
    }
  }

  /**
   * Resolve import/reexport edges for the pending `runId`, flip the
   * version active, and GC any previously-active version.
   *
   * Steps (single transactionSync after the symbol lookup is built):
   *  1. Ensure graph_versions row exists (empty-repo: insert with empty
   *     head_sha, ON CONFLICT DO NOTHING so a prior upsertFileGraph row
   *     is preserved).
   *  2. Build the symbol lookup for this version:
   *       `"${path} ${name}" → symbol_id`
   *     and the set of paths that have at least one symbol (used to
   *     probe candidate extensions).
   *  3. Resolve file_edges of kind 'import' and named 'reexport'
   *     (export { X } from '…'). Both behave identically:
   *     - Relative specifier → resolveRelative() → probe CANDIDATE_EXTS
   *       against the known-paths set.
   *     - No matching path → resolution_status='unresolved'.
   *     - Path found + importedName in lookup → 'resolved'
   *       (target_path + target_symbol_id set).
   *     - Path found but symbol not pinned → 'ambiguous'
   *       (target_path set, target_symbol_id null).
   *     - 'star_reexport' (export * from '…') edges are left 'raw' in v1;
   *       transitive re-export FIXPOINT is deferred to a future task.
   *  4. Resolve same_file call edges: set callee_symbol_id from lookup.
   *  4b. Resolve imported_binding (cross-file) call edges: set callee_symbol_id
   *     from the import binding Step 3 resolved (SIG-286).
   *  5. Flip: DELETE all rows for the old active version, then set this
   *     version status='active', committed_at=now.
   *  6. Emit 'graph-version-committed'.
   */
  async commitGraphVersion(runId: string): Promise<void> {
    const sql = this.sql()
    const now = new Date().toISOString()

    // Step 1: ensure the version row exists even for an empty repo.
    sql.exec(
      "INSERT INTO graph_versions (graph_version, head_sha, status, created_at) VALUES (?, '', 'pending', ?) ON CONFLICT(graph_version) DO NOTHING",
      runId, now,
    )

    // Step 2: build symbol lookups and path set for this version.
    // This runs OUTSIDE the transaction so we can read the data without
    // nesting concerns (transactionSync wraps the mutation phase below).
    //
    // Two lookups:
    //   symbolsByKey        — ALL symbols (exported + private). Used ONLY for
    //                         same_file call-edge resolution (calls can target
    //                         private functions — that is correct).
    //   exportedSymbolsByKey — EXPORTED symbols only. Used for import/reexport
    //                         target_symbol_id resolution: a module binding can
    //                         only resolve to a symbol the target file actually
    //                         exports. Resolving to a private declaration is a
    //                         false edge (Fix B — prefer-missing-over-false).
    const symbolsByKey = new Map<string, string>() // "${path} ${name}" → symbol_id (all)
    const exportedSymbolsByKey = new Map<string, string>() // "${path} ${name}" → symbol_id (exported only)
    for (const row of sql.exec<{ path: string; name: string; symbol_id: string; exported: number }>(
      "SELECT path, name, symbol_id, exported FROM symbols WHERE graph_version = ?",
      runId,
    )) {
      symbolsByKey.set(`${row.path} ${row.name}`, row.symbol_id)
      if (row.exported === 1) {
        exportedSymbolsByKey.set(`${row.path} ${row.name}`, row.symbol_id)
      }
    }

    // pathExists: union of ALL paths seen across symbols, file_edges (source),
    // and call_edges (source). This ensures barrel files and side-effect
    // modules that have edges but no symbols are still valid resolution
    // targets. Without the union, imports to edge-only files stay 'unresolved'
    // even though the file is known to the graph.
    const pathExists = new Set<string>()
    for (const row of sql.exec<{ path: string }>(
      "SELECT DISTINCT path FROM symbols WHERE graph_version = ?",
      runId,
    )) {
      pathExists.add(row.path)
    }
    for (const row of sql.exec<{ path: string }>(
      "SELECT DISTINCT source_path AS path FROM file_edges WHERE graph_version = ?",
      runId,
    )) {
      pathExists.add(row.path)
    }
    for (const row of sql.exec<{ path: string }>(
      "SELECT DISTINCT source_path AS path FROM call_edges WHERE graph_version = ?",
      runId,
    )) {
      pathExists.add(row.path)
    }

    // Helper: probe candidate extensions to find the actual target path.
    const resolveTargetPath = (base: string): string | null => {
      for (const ext of CANDIDATE_EXTS) {
        if (pathExists.has(base + ext)) return base + ext
      }
      return null
    }

    // Steps 3–5 in a single transaction.
    this.ctx.storage.transactionSync(() => {
      // Step 3: resolve import and named-reexport file edges.
      for (const e of sql.exec<{
        edge_id: string
        source_path: string
        specifier: string
        imported_name: string | null
      }>(
        "SELECT edge_id, source_path, specifier, imported_name FROM file_edges WHERE graph_version = ? AND edge_kind IN ('import','reexport')",
        runId,
      )) {
        const base = resolveRelative(e.source_path, e.specifier)
        const targetPath = base ? resolveTargetPath(base) : null

        if (!targetPath) {
          sql.exec(
            "UPDATE file_edges SET resolution_status = 'unresolved' WHERE graph_version = ? AND edge_id = ?",
            runId, e.edge_id,
          )
          continue
        }

        // Fix B: look up the target symbol ONLY in the exported set.
        // A module binding (`import { x } from "./a"`) can only resolve to
        // a symbol that `a` actually exports. Resolving to a private
        // declaration is a false edge — prefer ambiguous over false-resolved.
        const targetSymbolId = e.imported_name
          ? (exportedSymbolsByKey.get(`${targetPath} ${e.imported_name}`) ?? null)
          : null

        const resolutionStatus = targetSymbolId ? "resolved" : "ambiguous"

        sql.exec(
          "UPDATE file_edges SET target_path = ?, target_symbol_id = ?, resolution_status = ? WHERE graph_version = ? AND edge_id = ?",
          targetPath, targetSymbolId, resolutionStatus, runId, e.edge_id,
        )
      }

      // Step 4: resolve same_file call edges — set callee_symbol_id from lookup.
      for (const c of sql.exec<{
        edge_id: string
        source_path: string
        callee_name: string
      }>(
        "SELECT edge_id, source_path, callee_name FROM call_edges WHERE graph_version = ? AND call_kind = 'same_file'",
        runId,
      )) {
        const calleeSymbolId = symbolsByKey.get(`${c.source_path} ${c.callee_name}`) ?? null
        if (calleeSymbolId !== null) {
          sql.exec(
            "UPDATE call_edges SET callee_symbol_id = ? WHERE graph_version = ? AND edge_id = ?",
            calleeSymbolId, runId, c.edge_id,
          )
        }
      }

      // Step 4b (SIG-286): resolve imported_binding call edges — a CROSS-FILE
      // call to an imported name (`import { foo } from "./a"; foo()`). The
      // extractor already emits these edges but their callee_symbol_id stayed
      // NULL, so cross-file callers were invisible to
      // contextExpansionForChangedSymbols (which filters on callee_symbol_id).
      // Reuse the import resolution Step 3 just computed: map each RESOLVED
      // import binding `(source_path, local_name) → target_symbol_id` (local_name
      // so an alias `import { foo as bar }` matches the call site `bar()`), then
      // set callee_symbol_id on the matching imported_binding call edge. Only
      // edges whose import resolved to a real EXPORTED symbol are set; barrels /
      // default / namespace imports stay NULL (prefer-missing-over-false).
      const importBindingSymbol = new Map<string, string>() // "${source_path} ${local_name}" → symbol_id
      for (const e of sql.exec<{
        source_path: string
        local_name: string | null
        target_symbol_id: string | null
      }>(
        "SELECT source_path, local_name, target_symbol_id FROM file_edges WHERE graph_version = ? AND edge_kind = 'import' AND target_symbol_id IS NOT NULL AND local_name IS NOT NULL",
        runId,
      )) {
        if (e.local_name && e.target_symbol_id) {
          importBindingSymbol.set(`${e.source_path} ${e.local_name}`, e.target_symbol_id)
        }
      }
      for (const c of sql.exec<{
        edge_id: string
        source_path: string
        callee_name: string
      }>(
        "SELECT edge_id, source_path, callee_name FROM call_edges WHERE graph_version = ? AND call_kind = 'imported_binding'",
        runId,
      )) {
        const calleeSymbolId = importBindingSymbol.get(`${c.source_path} ${c.callee_name}`) ?? null
        if (calleeSymbolId !== null) {
          sql.exec(
            "UPDATE call_edges SET callee_symbol_id = ? WHERE graph_version = ? AND edge_id = ?",
            calleeSymbolId, runId, c.edge_id,
          )
        }
      }

      // Step 5: GC ALL versions other than the one being committed, then
      // promote this version.  The original code only deleted status='active'
      // versions, leaving superseded/retried/aborted PENDING rows to accumulate
      // unboundedly. A concurrent run that lost the lease will abort its own
      // commit via the indexer's lease gate, so wiping its pending rows here
      // is safe (Fix A). Fix 3 spread is retained: spread the cursor BEFORE
      // the loop so the DELETE statements inside do not mutate the table while
      // a lazy/streaming cursor is still open.
      for (const old of [...sql.exec<{ graph_version: string }>(
        "SELECT graph_version FROM graph_versions WHERE graph_version != ?",
        runId,
      )]) {
        const ov = old.graph_version
        sql.exec("DELETE FROM call_edges WHERE graph_version = ?", ov)
        sql.exec("DELETE FROM file_edges WHERE graph_version = ?", ov)
        sql.exec("DELETE FROM symbols WHERE graph_version = ?", ov)
        sql.exec("DELETE FROM graph_versions WHERE graph_version = ?", ov)
      }

      sql.exec(
        "UPDATE graph_versions SET status = 'active', committed_at = ? WHERE graph_version = ?",
        now, runId,
      )
    })

    emit("graph-version-committed", { runId })
  }

  /**
   * Return resolved edge rows for a source path. Used by tests to
   * inspect edge resolution after commitGraphVersion.
   */
  async debugResolvedEdges(sourcePath: string): Promise<Array<{
    targetPath: string | null
    targetSymbolId: string | null
    resolutionStatus: string
  }>> {
    const sql = this.sql()
    return [
      ...sql.exec<{ target_path: string | null; target_symbol_id: string | null; resolution_status: string }>(
        "SELECT target_path, target_symbol_id, resolution_status FROM file_edges WHERE source_path = ?",
        sourcePath,
      ),
    ].map((row) => ({
      targetPath: row.target_path,
      targetSymbolId: row.target_symbol_id,
      resolutionStatus: row.resolution_status,
    }))
  }

  /**
   * Return call_edges rows for a source path in the active version.
   * Used by tests to inspect callee resolution after commitGraphVersion.
   */
  async debugCallEdges(sourcePath: string): Promise<Array<{
    calleeName: string
    callKind: string
    calleeSymbolId: string | null
  }>> {
    const sql = this.sql()
    // Find the active graph version first.
    const versionRows = [...sql.exec<{ graph_version: string }>(
      "SELECT graph_version FROM graph_versions WHERE status = 'active'",
    )]
    const activeVersion = versionRows[0]?.graph_version
    if (!activeVersion) return []
    return [...sql.exec<{ callee_name: string; call_kind: string; callee_symbol_id: string | null }>(
      "SELECT callee_name, call_kind, callee_symbol_id FROM call_edges WHERE graph_version = ? AND source_path = ?",
      activeVersion, sourcePath,
    )].map((row) => ({
      calleeName: row.callee_name,
      callKind: row.call_kind,
      calleeSymbolId: row.callee_symbol_id,
    }))
  }

  /**
   * Return the graph_version string of the currently-active version,
   * or null if no version is active. Used by tests.
   */
  async debugActiveVersion(): Promise<string | null> {
    const sql = this.sql()
    const rows = [
      ...sql.exec<{ graph_version: string }>(
        "SELECT graph_version FROM graph_versions WHERE status = 'active'",
      ),
    ]
    return rows[0]?.graph_version ?? null
  }

  /**
   * Given a set of changed symbol IDs, return the files that directly call
   * those symbols and the files that import them — both scoped to the ACTIVE
   * graph version.
   *
   * - importDependents: DISTINCT source_path from file_edges where
   *   target_symbol_id is one of the changed symbols.
   * - callerPaths: resolve the changed symbols' NAMES, then DISTINCT
   *   source_path from call_edges where callee_name is in that name set.
   *
   * Returns { callerPaths: [], importDependents: [] } when there is no active
   * version or changedSymbolIds is empty.
   */
  async blastRadius(args: { changedSymbolIds: string[] }): Promise<{
    callerPaths: string[]
    importDependents: string[]
  }> {
    const empty = { callerPaths: [], importDependents: [] }
    if (args.changedSymbolIds.length === 0) return empty

    const active = await this.debugActiveVersion()
    if (!active) return empty

    return this.blastRadiusForIds(active, args.changedSymbolIds)
  }

  /**
   * Name-based blast radius (SIG-143). The ensemble extracts changed symbol
   * NAMES from the diff (extractChangedSymbols) but does not reconstruct the
   * composite symbol_ids. This resolves those names to symbol_ids in the
   * ACTIVE version — SCOPED to the changed files — then reuses the same
   * import-dependent + caller computation as blastRadius.
   *
   * Scoping to `changedPaths` is the name-collision guard: a bare name like
   * `handle` can be declared in many files, but only the declaration in a file
   * the PR actually changed is a changed symbol. Without the path scope a
   * common name would inflate the blast radius with unrelated same-named
   * symbols. The resolved id set is additionally capped at MAX_BLAST_IDS as a
   * defensive bound.
   *
   * A changed name with no matching declaration in a changed file resolves to
   * no id and contributes nothing — a deliberate recall gap consistent with
   * the prefer-missing-over-false philosophy of blastRadius.
   *
   * Returns { callerPaths: [], importDependents: [] } when there is no active
   * version, changedNames is empty, or changedPaths is empty.
   */
  async blastRadiusByNames(args: { changedNames: string[]; changedPaths: string[] }): Promise<{
    callerPaths: string[]
    importDependents: string[]
  }> {
    const empty = { callerPaths: [], importDependents: [] }
    if (args.changedNames.length === 0 || args.changedPaths.length === 0) return empty

    const active = await this.debugActiveVersion()
    if (!active) return empty

    const sql = this.sql()
    const names = args.changedNames
    const paths = args.changedPaths
    const namePlaceholders = names.map(() => "?").join(",")
    const pathPlaceholders = paths.map(() => "?").join(",")
    const ids = [
      ...sql.exec<{ symbol_id: string }>(
        // ORDER BY before LIMIT so the capped id set is deterministic when
        // matches exceed MAX_BLAST_IDS (otherwise the kept ids vary by plan).
        `SELECT DISTINCT symbol_id FROM symbols WHERE graph_version = ? AND name IN (${namePlaceholders}) AND path IN (${pathPlaceholders}) ORDER BY symbol_id LIMIT ?`,
        active, ...names, ...paths, MAX_BLAST_IDS,
      ),
    ].map((r) => r.symbol_id)

    return this.blastRadiusForIds(active, ids)
  }

  /**
   * Shared blast-radius computation over already-resolved symbol ids within
   * the given active graph version. Both blastRadius (id-based) and
   * blastRadiusByNames (name-based) delegate here so the import-dependent +
   * caller logic lives in one place. Returns empty when `ids` is empty.
   */
  private blastRadiusForIds(active: string, ids: string[]): {
    callerPaths: string[]
    importDependents: string[]
  } {
    const empty = { callerPaths: [], importDependents: [] }
    if (ids.length === 0) return empty

    const sql = this.sql()
    const idPlaceholders = ids.map(() => "?").join(",")

    // import dependents: files that import a changed symbol (resolved target_symbol_id).
    // importDependents matches only RESOLVED import edges (target_symbol_id set);
    // ambiguous/unresolved import edges have null target_symbol_id and won't appear —
    // a known recall gap by design (prefer-missing-over-false), consistent with the
    // extractor's best-effort call edges.
    const importDependents = new Set<string>()
    for (const row of sql.exec<{ source_path: string }>(
      `SELECT DISTINCT source_path FROM file_edges WHERE graph_version = ? AND target_symbol_id IN (${idPlaceholders})`,
      active, ...ids,
    )) {
      importDependents.add(row.source_path)
    }

    // callerPaths: resolve changed symbol IDs → names, then find call sites by callee_name
    const names: string[] = [
      ...sql.exec<{ name: string }>(
        `SELECT name FROM symbols WHERE graph_version = ? AND symbol_id IN (${idPlaceholders})`,
        active, ...ids,
      ),
    ].map((r) => r.name)

    const callerPaths = new Set<string>()
    if (names.length > 0) {
      const namePlaceholders = names.map(() => "?").join(",")
      for (const row of sql.exec<{ source_path: string }>(
        `SELECT DISTINCT source_path FROM call_edges WHERE graph_version = ? AND callee_name IN (${namePlaceholders})`,
        active, ...names,
      )) {
        callerPaths.add(row.source_path)
      }
    }

    return {
      callerPaths: [...callerPaths],
      importDependents: [...importDependents],
    }
  }

  /**
   * K=2 BFS over the ACTIVE graph that expands seed file paths to their
   * graph neighbors via resolved file edges (target_path IS NOT NULL).
   *
   * Both `resolved` and `ambiguous` edges have a non-null target_path and are
   * traversed — either status represents a real file dependency. Only
   * `unresolved` edges (target_path = null) are excluded.
   *
   * v1 returns file-level neighbors only (symbolId/name are null on every
   * node). `maxSymbolsPerHit` is reserved for a future symbol-level
   * enrichment phase and is intentionally unused in this version; it is kept
   * in the signature for forward-compat.
   *
   * Returns `{ nodes: [] }` when:
   *  - There is no active version, OR
   *  - `seedPaths` is empty.
   *
   * BFS mechanics:
   *  1. Pre-seed `seen` with all `seedPaths` so they never appear as output nodes.
   *  2. For each hop (1, 2) while `nodes.length < maxFiles`:
   *     a. Query outgoing resolved edges for every path in the current frontier:
   *        `SELECT target_path, edge_kind FROM file_edges WHERE graph_version=<active>
   *         AND source_path = ? AND target_path IS NOT NULL LIMIT <maxEdgesPerSymbol>`
   *     b. For each unseen target: mark seen, push to `nodes`, enqueue for next hop.
   *  3. Stop after hop 2 (hard K=2 cap) or when `nodes.length >= maxFiles`.
   */
  async contextForVectorHits(args: {
    seedPaths: string[]
    maxFiles: number
    /** Reserved for future symbol-level enrichment — unused in v1. */
    maxSymbolsPerHit: number
    maxEdgesPerSymbol: number
  }): Promise<{ nodes: GraphContextNode[] }> {
    if (args.seedPaths.length === 0) return { nodes: [] }

    const active = await this.debugActiveVersion()
    if (!active) return { nodes: [] }

    const sql = this.sql()
    const seen = new Set<string>(args.seedPaths)
    const nodes: GraphContextNode[] = []
    let frontier = [...args.seedPaths]

    for (let hop = 1; hop <= 2 && nodes.length < args.maxFiles; hop++) {
      const next: string[] = []

      for (const path of frontier) {
        if (nodes.length >= args.maxFiles) break

        const rows = [
          ...sql.exec<{ target_path: string; edge_kind: string }>(
            "SELECT target_path, edge_kind FROM file_edges WHERE graph_version = ? AND source_path = ? AND target_path IS NOT NULL ORDER BY target_path, edge_kind LIMIT ?",
            active, path, args.maxEdgesPerSymbol,
          ),
        ]

        for (const row of rows) {
          if (nodes.length >= args.maxFiles) break
          const tp = row.target_path
          if (seen.has(tp)) continue
          seen.add(tp)
          next.push(tp)
          nodes.push({ path: tp, symbolId: null, name: null, hop, edgeKind: row.edge_kind })
        }
      }

      frontier = next
    }

    return { nodes }
  }

  /**
   * SIG-286: row-level context expansion for a PR's changed symbols, scoped to
   * the ACTIVE graph version. Unlike blastRadiusByNames (which returns only
   * caller/import-dependent PATHS), this returns the LOCATIONS needed to render
   * bounded body snippets: definition spans, call sites (same-file + resolved
   * cross-file imported_binding callers, SIG-286), and import
   * reference lines.
   *
   * Resolution mirrors blastRadiusByNames: changed NAMES are resolved to
   * symbol_ids SCOPED to `changedPaths` (the name-collision guard — a bare name
   * like `handle` resolves only where the PR declared it), capped at
   * MAX_BLAST_IDS. Each row list is additionally capped at `maxRows`.
   *
   * Rows:
   *   - definitionRows: symbols matching the resolved changed ids → spans.
   *   - callerRows: call_edges whose callee_symbol_id ∈ changed ids (same-file
   *     calls only — see GraphCallerRow), joined to the caller symbol's span
   *     when caller_symbol_id resolves.
   *   - importRows: file_edges whose target_symbol_id ∈ changed ids OR whose
   *     target_path ∈ changedPaths → import reference lines.
   *
   * Returns `{ graphAvailable: false, …empty }` when there is no active version
   * or `changedNames`/`changedPaths` is empty — graceful degrade.
   */
  async contextExpansionForChangedSymbols(args: {
    changedNames: string[]
    changedPaths: string[]
    maxRows?: number
  }): Promise<GraphContextExpansion> {
    const empty: GraphContextExpansion = {
      graphAvailable: false,
      definitionRows: [],
      callerRows: [],
      importRows: [],
    }
    if (args.changedNames.length === 0 || args.changedPaths.length === 0) return empty

    const active = await this.debugActiveVersion()
    if (!active) return empty

    // Floor + clamp to ≥1: a positive fractional arg (e.g. 0.5) must not floor
    // to 0 and turn every row query into LIMIT 0 (CodeRabbit). Non-finite/<1 → default.
    const maxRowsReq = Math.floor(args.maxRows ?? DEFAULT_EXPANSION_ROWS)
    const maxRows = Number.isFinite(maxRowsReq) && maxRowsReq >= 1 ? maxRowsReq : DEFAULT_EXPANSION_ROWS
    const sql = this.sql()
    const names = args.changedNames
    const paths = args.changedPaths
    const namePlaceholders = names.map(() => "?").join(",")
    const pathPlaceholders = paths.map(() => "?").join(",")

    // Resolve changed NAMES → symbol_ids, scoped to changed files. Same query
    // as blastRadiusByNames (ORDER BY before LIMIT → deterministic cap).
    const ids = [
      ...sql.exec<{ symbol_id: string }>(
        `SELECT DISTINCT symbol_id FROM symbols WHERE graph_version = ? AND name IN (${namePlaceholders}) AND path IN (${pathPlaceholders}) ORDER BY symbol_id LIMIT ?`,
        active, ...names, ...paths, MAX_BLAST_IDS,
      ),
    ].map((r) => r.symbol_id)

    if (ids.length === 0) {
      // Active version exists but nothing resolved — still "available".
      return { graphAvailable: true, definitionRows: [], callerRows: [], importRows: [] }
    }

    const idPlaceholders = ids.map(() => "?").join(",")

    // definitionRows: the changed symbols' own declaration spans.
    const definitionRows: GraphDefinitionRow[] = [
      ...sql.exec<{
        symbol_id: string; path: string; name: string; kind: string
        start_line: number; end_line: number
      }>(
        `SELECT symbol_id, path, name, kind, start_line, end_line FROM symbols WHERE graph_version = ? AND symbol_id IN (${idPlaceholders}) ORDER BY path, start_line LIMIT ?`,
        active, ...ids, maxRows,
      ),
    ].map((r) => ({
      symbolId: r.symbol_id,
      path: r.path,
      name: r.name,
      kind: r.kind,
      startLine: r.start_line,
      endLine: r.end_line,
    }))

    // callerRows: call sites of a changed symbol (same-file + SIG-286 resolved
    // cross-file imported_binding callers, both matched on callee_symbol_id),
    // LEFT JOINed to the caller symbol's span so the consumer can render the
    // whole caller body.
    const callerRows: GraphCallerRow[] = [
      ...sql.exec<{
        source_path: string; callee_name: string; call_kind: string
        start_line: number; start_col: number
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
        active, ...ids, maxRows,
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

    // importRows: import edges referencing a changed symbol (resolved
    // target_symbol_id) OR a changed file (target_path). Matching either side
    // captures both symbol-resolved and ambiguous-but-path-resolved importers.
    const importRows: GraphImportRow[] = [
      ...sql.exec<{ source_path: string; imported_name: string | null; start_line: number }>(
        `SELECT DISTINCT source_path, imported_name, start_line FROM file_edges WHERE graph_version = ? AND (target_symbol_id IN (${idPlaceholders}) OR target_path IN (${pathPlaceholders})) ORDER BY source_path, start_line LIMIT ?`,
        active, ...ids, ...paths, maxRows,
      ),
    ].map((r) => ({
      sourcePath: r.source_path,
      importedName: r.imported_name,
      startLine: r.start_line,
    }))

    return { graphAvailable: true, definitionRows, callerRows, importRows }
  }

  /**
   * Wipe ALL data from this DO instance — every row in every table.
   * Used by the GDPR delete path (T8) when an installation is removed.
   *
   * Runs inside a single transactionSync so the caller never observes
   * partial state. Emits 'graph-deleted' for audit telemetry.
   */
  async deleteRepoGraph(): Promise<void> {
    const sql = this.sql()

    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM symbols")
      sql.exec("DELETE FROM file_edges")
      sql.exec("DELETE FROM call_edges")
      sql.exec("DELETE FROM graph_versions")
    })

    emit("graph-deleted", { instance: this.ctx.id.toString() })
  }
}
