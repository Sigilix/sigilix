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

      // Insert symbols.
      for (const s of args.symbols) {
        sql.exec(
          "INSERT INTO symbols (graph_version, symbol_id, path, name, kind, exported, start_line, start_col, end_line, end_col) VALUES (?,?,?,?,?,?,?,?,?,?)",
          args.runId, s.symbolId, s.path, s.name, s.kind,
          s.exported ? 1 : 0,
          s.startLine, s.startCol, s.endLine, s.endCol,
        )
      }

      // Insert raw file edges. target_path + target_symbol_id are NULL
      // until commitGraphVersion() resolves them (Task 5).
      for (const e of args.fileEdgesRaw) {
        const edgeId = this.edgeId(
          "fe", e.sourcePath, e.startLine, e.startCol,
          `${e.specifier}|${e.importedName ?? ""}`,
        )
        sql.exec(
          "INSERT INTO file_edges (graph_version, edge_id, source_path, edge_kind, specifier, imported_name, local_name, exported_name, resolution_status, start_line, start_col) VALUES (?,?,?,?,?,?,?,?,'raw',?,?)",
          args.runId, edgeId, e.sourcePath, e.edgeKind, e.specifier,
          e.importedName, e.localName, e.exportedName,
          e.startLine, e.startCol,
        )
      }

      // Insert call edges. caller_symbol_id + callee_symbol_id are NULL
      // until commitGraphVersion() resolves them (Task 5).
      for (const c of args.callEdges) {
        const edgeId = this.edgeId(
          "ce", c.sourcePath, c.startLine, c.startCol, c.calleeName,
        )
        sql.exec(
          "INSERT INTO call_edges (graph_version, edge_id, source_path, callee_name, call_kind, start_line, start_col) VALUES (?,?,?,?,?,?,?)",
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
}
