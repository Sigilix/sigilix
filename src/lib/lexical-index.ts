// SIG-45 — hybrid lexical (BM25) retrieval backend.
//
// Sigilix retrieval is pure-vector (Vectorize) today. Vector search misses
// exact-identifier matches, error strings, and log lines that a lexical
// index catches reliably. This module is the lexical half: a Cloudflare D1
// table with an FTS5 (BM25) full-text index over the SAME chunk content the
// indexer upserts to Vectorize, queried in parallel at review time and
// merged with the vector hits via reciprocal-rank fusion (RRF).
//
// Why D1 + FTS5 (not Algolia/Meili/OpenSearch): keeps the stack on CF
// primitives (no new vendor, no egress), and SQLite's FTS5 ships BM25
// ranking built in. Per-language tokenizer tuning is out of scope — FTS5's
// default `unicode61` tokenizer handles ~90% of source-code identifiers.
//
// The whole path is gated behind OPENCLAW_RETRIEVAL_HYBRID (default off):
// when off, nothing here is read at review time and the dual-write is a
// cheap no-op-on-failure (a lexical-index outage must never block the
// Vectorize upsert the GDPR delete ledger depends on).

// ---------------------------------------------------------------------
// Flag
// ---------------------------------------------------------------------

/**
 * Hybrid retrieval is on only when the flag is exactly "on" (matches the
 * sibling OPENCLAW_*_RETRIEVAL boolean flags). Anything else — unset,
 * "off", "shadow", garbage — keeps it dark. Reads tolerate a missing
 * binding so a deploy that hasn't provisioned D1 yet stays vector-only.
 */
export function hybridRetrievalEnabled(env: {
  OPENCLAW_RETRIEVAL_HYBRID?: string
  OPENCLAW_LEXICAL_INDEX?: D1Database
}): boolean {
  return (env.OPENCLAW_RETRIEVAL_HYBRID ?? "").trim().toLowerCase() === "on" && env.OPENCLAW_LEXICAL_INDEX != null
}

// ---------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------

/**
 * One row written to the lexical index. Field-for-field the subset of the
 * Vectorize record this backend needs — same `id` (the deterministic
 * `chunkId`) so a chunk can be deduplicated across the two backends, same
 * `namespace` so a query scopes to one repo, same content the embedder saw.
 */
export interface LexicalChunk {
  id: string
  namespace: string
  path: string
  lineStart: number
  lineEnd: number
  content: string
}

/** A lexical hit. `score` is the raw BM25 score (lower = better match). */
export interface LexicalMatch {
  id: string
  path: string
  lineStart: number
  lineEnd: number
  content: string
  /** BM25 score from FTS5 — more negative is a stronger match. */
  score: number
}

// ---------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------

// A single standalone FTS5 table (not external-content): UNINDEXED columns
// carry the metadata we return, `content` is the one full-text column.
// `namespace` is UNINDEXED but still usable as an `=` filter alongside a
// MATCH, which is exactly the per-repo scoping query we run. Storing id as
// the disambiguator lets us idempotently DELETE-then-INSERT on re-index
// (FTS5 has no UPSERT / PRIMARY KEY).
const CREATE_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS lexical_chunks USING fts5(
  id UNINDEXED,
  namespace UNINDEXED,
  path UNINDEXED,
  line_start UNINDEXED,
  line_end UNINDEXED,
  content,
  tokenize = 'unicode61'
)`.trim()
const D1_BATCH_LIMIT = 100

// Schema bootstrap is idempotent and cheap; we run it lazily once per
// isolate rather than depending on a migration step that a fresh preview
// deploy might skip. `D1Database` has no DDL-only fast path, so this rides
// the normal exec.
let schemaReady: WeakSet<D1Database> = new WeakSet()

export async function ensureLexicalSchema(db: D1Database): Promise<void> {
  if (schemaReady.has(db)) return
  await db.exec(CREATE_TABLE_SQL.replace(/\n\s*/g, " "))
  schemaReady.add(db)
}

/** Test-only: drop the per-isolate "schema already created" memo. */
export function _resetSchemaMemoForTests(): void {
  schemaReady = new WeakSet()
}

// ---------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------

/**
 * Idempotently write a batch of chunks to the lexical index. Called from
 * the indexer's streaming upsert loop, right beside the Vectorize upsert,
 * with the SAME records — so the two backends stay in lock-step.
 *
 * NOT best-effort in the sense that it surfaces failure to the caller, but
 * the caller (indexer) treats a lexical-write failure as soft: the
 * Vectorize upsert + its delete-coverage ledger are load-bearing for GDPR
 * deletion and must not be blocked by a lexical-index hiccup. So this
 * returns a boolean rather than throwing, and the caller logs-and-continues.
 *
 * FTS5 has no UPSERT, so each id is DELETE-then-INSERT to stay idempotent
 * across queue redelivery / re-index of the same content.
 */
export async function upsertLexicalChunks(db: D1Database, chunks: ReadonlyArray<LexicalChunk>): Promise<boolean> {
  if (chunks.length === 0) return true
  try {
    await ensureLexicalSchema(db)
    const del = db.prepare("DELETE FROM lexical_chunks WHERE id = ?")
    const ins = db.prepare(
      "INSERT INTO lexical_chunks (id, namespace, path, line_start, line_end, content) VALUES (?, ?, ?, ?, ?, ?)",
    )
    const stmts: D1PreparedStatement[] = []
    for (const c of chunks) {
      stmts.push(del.bind(c.id))
      stmts.push(ins.bind(c.id, c.namespace, c.path, c.lineStart, c.lineEnd, c.content))
    }
    await db.batch(stmts)
    return true
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "lexical-upsert-failed",
        count: chunks.length,
        namespace: chunks[0]?.namespace,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}

/**
 * Delete every lexical row for a namespace. Wired into the GDPR uninstall /
 * repos-removed delete fan-out (index-delete.ts) so the lexical index
 * doesn't retain customer code after the Vectorize namespace is purged.
 * Soft-fails (logs) for the same reason the rest of that path is tolerant —
 * one backend's delete failure shouldn't abort the others.
 */
export async function deleteLexicalNamespace(db: D1Database, namespace: string): Promise<number> {
  try {
    await ensureLexicalSchema(db)
    const res = await db.prepare("DELETE FROM lexical_chunks WHERE namespace = ?").bind(namespace).run()
    return res.meta?.changes ?? 0
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "lexical-delete-failed",
        namespace,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return 0
  }
}

export async function deleteLexicalIds(db: D1Database, ids: ReadonlyArray<string>): Promise<number> {
  if (ids.length === 0) return 0
  try {
    await ensureLexicalSchema(db)
    const del = db.prepare("DELETE FROM lexical_chunks WHERE id = ?")
    let deleted = 0
    for (let i = 0; i < ids.length; i += D1_BATCH_LIMIT) {
      const results = await db.batch(ids.slice(i, i + D1_BATCH_LIMIT).map((id) => del.bind(id)))
      deleted += results.reduce((sum, result) => sum + (result.meta?.changes ?? 0), 0)
    }
    return deleted
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "lexical-delete-ids-failed",
        count: ids.length,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return 0
  }
}

// ---------------------------------------------------------------------
// Query path
// ---------------------------------------------------------------------

/**
 * Build a safe FTS5 MATCH expression from free-form query text.
 *
 * Raw text can't go straight into MATCH: FTS5 treats `"`, `*`, `:`, `-`,
 * `(`, `^`, and the bareword `AND`/`OR`/`NOT`/`NEAR` as query operators, so
 * an identifier like `user-id` or a snippet with a stray quote would either
 * throw a syntax error or silently change semantics. We tokenize to
 * alphanumeric/underscore runs, drop 1-char noise, double-quote each term
 * (so it's a literal, not an operator), and OR them together. Returns null
 * when nothing usable survives — caller then skips the lexical leg.
 */
export function buildFtsQuery(text: string): string | null {
  const terms = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length >= 2)
  if (terms.length === 0) return null
  // Cap term count so a huge changed-symbol query doesn't build a
  // pathological MATCH expression.
  const capped = Array.from(new Set(terms)).slice(0, 64)
  return capped.map((t) => `"${t}"`).join(" OR ")
}

/**
 * Query the lexical index for the top-K BM25 matches in a namespace.
 * Returns [] on any failure (missing schema, malformed query, D1 outage) —
 * retrieval is a soft dependency; the vector leg still runs.
 */
export async function queryLexical(
  db: D1Database,
  namespace: string,
  queryText: string,
  topK: number,
): Promise<LexicalMatch[]> {
  const match = buildFtsQuery(queryText)
  if (!match) return []
  try {
    await ensureLexicalSchema(db)
    const res = await db
      .prepare(
        `SELECT id, path, line_start AS lineStart, line_end AS lineEnd, content, bm25(lexical_chunks) AS score
         FROM lexical_chunks
         WHERE namespace = ? AND lexical_chunks MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .bind(namespace, match, topK)
      .all<{
        id: string
        path: string
        lineStart: number
        lineEnd: number
        content: string
        score: number
      }>()
    return (res.results ?? []).map((r) => ({
      id: r.id,
      path: r.path,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      content: r.content,
      score: r.score,
    }))
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "lexical-query-failed",
        namespace,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return []
  }
}

// ---------------------------------------------------------------------
// Reciprocal-rank fusion
// ---------------------------------------------------------------------

/**
 * Minimal shape RRF needs: a stable dedup key + the payload to return.
 * Both the vector and lexical legs map onto this before fusion.
 */
export interface RankedItem<T> {
  /** Dedup key — the chunk id when available, else path:lineStart-lineEnd. */
  key: string
  item: T
}

export interface FusedItem<T> {
  item: T
  /** Summed RRF contribution across the lists the item appeared in. */
  rrfScore: number
}

/**
 * Reciprocal-rank fusion. Each list contributes `1 / (k + rank)` (rank is
 * 1-based) for every item, summed per dedup key across lists. An item in
 * both the vector and lexical lists therefore outranks one in only a single
 * list — the whole point of hybrid retrieval. `k` (default 60, the value
 * from the original Cormack RRF paper and every production write-up since)
 * damps the contribution of deep-rank hits so the head of each list
 * dominates.
 *
 * Pure + deterministic: ties broken by first-seen order (vector list is
 * passed first by convention, so a semantic hit wins an exact rrf tie). The
 * winning item payload is whichever list surfaced the key first.
 */
export function reciprocalRankFusion<T>(lists: ReadonlyArray<ReadonlyArray<RankedItem<T>>>, k = 60): FusedItem<T>[] {
  const acc = new Map<string, { item: T; score: number; order: number }>()
  let order = 0
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const { key, item } = list[rank]!
      const contribution = 1 / (k + rank + 1)
      const existing = acc.get(key)
      if (existing) {
        existing.score += contribution
      } else {
        acc.set(key, { item, score: contribution, order: order++ })
      }
    }
  }
  return Array.from(acc.values())
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((e) => ({ item: e.item, rrfScore: e.score }))
}
