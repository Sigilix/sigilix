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
import type { Env } from "../index"

// ─── Logging ─────────────────────────────────────────────────────

function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, system: "repo-graph", ...fields }))
}

// ─── Schema (lazy, idempotent) ───────────────────────────────────
//
// Applied via sql.exec on first use — CREATE TABLE IF NOT EXISTS
// guarantees idempotency across DO restarts.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_versions (
  graph_version TEXT PRIMARY KEY,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active')),
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE TABLE IF NOT EXISTS symbols (
  graph_version TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  scip_symbol TEXT,
  PRIMARY KEY (graph_version, symbol_id)
);
CREATE INDEX IF NOT EXISTS symbols_by_name ON symbols(graph_version, name, exported);
CREATE INDEX IF NOT EXISTS symbols_by_path ON symbols(graph_version, path, start_line);
CREATE TABLE IF NOT EXISTS file_edges (
  graph_version TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  edge_kind TEXT NOT NULL,
  specifier TEXT NOT NULL,
  imported_name TEXT,
  local_name TEXT,
  exported_name TEXT,
  target_path TEXT,
  target_symbol_id TEXT,
  resolution_status TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  PRIMARY KEY (graph_version, edge_id)
);
CREATE INDEX IF NOT EXISTS file_edges_source ON file_edges(graph_version, source_path);
CREATE INDEX IF NOT EXISTS file_edges_target_symbol ON file_edges(graph_version, target_symbol_id);
CREATE INDEX IF NOT EXISTS file_edges_target_path ON file_edges(graph_version, target_path);
CREATE TABLE IF NOT EXISTS call_edges (
  graph_version TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  caller_symbol_id TEXT,
  callee_symbol_id TEXT,
  callee_name TEXT NOT NULL,
  call_kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  PRIMARY KEY (graph_version, edge_id)
);
CREATE INDEX IF NOT EXISTS call_edges_callee ON call_edges(graph_version, callee_symbol_id);
CREATE INDEX IF NOT EXISTS call_edges_caller ON call_edges(graph_version, caller_symbol_id);
CREATE INDEX IF NOT EXISTS call_edges_source_line ON call_edges(graph_version, source_path, start_line);
`

// ─── Pure helpers ─────────────────────────────────────────────────

/**
 * Resolve a relative import specifier against the importing file's path.
 * Only handles specifiers that start with "." (relative). Bare/aliased
 * specifiers (e.g. "left-pad", "node:path", "@scope/pkg") return null
 * and are left unresolved in v1.
 *
 * Returns the joined path WITHOUT a file extension — the caller probes
 * CANDIDATE_EXTS to find the actual file in the symbol table.
 *
 * @example
 *   resolveRelative("src/a.ts", "./b")        // "src/b"
 *   resolveRelative("src/x/a.ts", "../b")     // "src/b"
 *   resolveRelative("src/a.ts", "left-pad")   // null
 */
export function resolveRelative(sourcePath: string, specifier: string): string | null {
  // Fix 1: only treat a specifier as relative if it is exactly "." or "..",
  // or starts with "./" or "../". Bare dotfiles like ".hidden" or "..b" are
  // NOT relative specifiers and should fall through to the null return.
  if (
    specifier !== "." &&
    specifier !== ".." &&
    !specifier.startsWith("./") &&
    !specifier.startsWith("../")
  ) {
    return null
  }
  // Build the directory segments of the source file.
  const dir = sourcePath.split("/").slice(0, -1)
  const parts = specifier.split("/")
  const stack = [...dir]
  for (const p of parts) {
    if (p === "." || p === "") continue
    else if (p === "..") {
      // Fix 2: if a ".." segment would pop an empty stack the path escapes
      // the repo root — treat as unresolvable.
      if (stack.length === 0) return null
      stack.pop()
    }
    else stack.push(p)
  }
  return stack.join("/")
}

/** Extensions to probe when looking up a resolved path in the symbol table. */
const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"]

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

    // Step 2: build symbol lookup and path set for this version.
    // This runs OUTSIDE the transaction so we can read the data without
    // nesting concerns (transactionSync wraps the mutation phase below).
    const symbolsByKey = new Map<string, string>() // "${path} ${name}" → symbol_id
    for (const row of sql.exec<{ path: string; name: string; symbol_id: string }>(
      "SELECT path, name, symbol_id FROM symbols WHERE graph_version = ?",
      runId,
    )) {
      symbolsByKey.set(`${row.path} ${row.name}`, row.symbol_id)
    }

    // Fix 4 (v1 limitation): pathExists is built from files that produced at
    // least one symbol. A file that exists in the repo but has NO indexable
    // symbols will never appear here, so any import whose resolved path lands
    // on such a file will stay 'unresolved'. Accepted v1 limitation — the
    // AST extractor skips files it cannot parse, and symbol-free files (e.g.
    // pure re-export barrels with no locally-declared symbols) fall into this
    // category. A future task can track all indexed paths independently.
    const pathExists = new Set<string>()
    for (const row of sql.exec<{ path: string }>(
      "SELECT DISTINCT path FROM symbols WHERE graph_version = ?",
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

        const targetSymbolId = e.imported_name
          ? (symbolsByKey.get(`${targetPath} ${e.imported_name}`) ?? null)
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

      // Step 5: GC old active version(s), then promote this version.
      // Fix 3: spread the cursor BEFORE the loop so the DELETE statements
      // inside do not mutate the table while a lazy/streaming cursor is still
      // open. Real Cloudflare DO SQLite cursors are lazy — iterating and
      // mutating the same table mid-cursor is a footgun even if it happens to
      // work in the Node test shim (which materialises results eagerly).
      for (const old of [...sql.exec<{ graph_version: string }>(
        "SELECT graph_version FROM graph_versions WHERE status = 'active' AND graph_version != ?",
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
}
