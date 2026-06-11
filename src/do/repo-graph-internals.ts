// SIG-376 (SIG-318 Tier-1 2/8): the RepoGraphDO's pure internals — its
// structured-log emitter, the lazy SQLite schema, the relative-import
// resolver, and the bounding constants — lifted out of `repo-graph.ts` so
// that DO file stays under the 1,000-line budget. Bodies are byte-identical
// to their prior in-file definitions; only the `export` keywords (so the DO
// can import them) differ.
//
// The DO re-exports the three previously-public symbols (`resolveRelative`,
// `MAX_BLAST_IDS`, `DEFAULT_EXPANSION_ROWS`) so every importer of
// `@/do/repo-graph` — including the co-located test — is unchanged.
//
// Leaf module: imports nothing. Following the SIG-363 precedent already
// proven on this file (the graph-context payload types live in
// `shared/domain/graph-context`), this keeps the DO infra layer thin without
// inverting the dependency rule.

// ─── Logging ─────────────────────────────────────────────────────

export function emit(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, system: "repo-graph", ...fields }))
}

// ─── Schema (lazy, idempotent) ───────────────────────────────────
//
// Applied via sql.exec on first use — CREATE TABLE IF NOT EXISTS
// guarantees idempotency across DO restarts.

export const SCHEMA = `
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
  if (specifier !== "." && specifier !== ".." && !specifier.startsWith("./") && !specifier.startsWith("../")) {
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
    } else stack.push(p)
  }
  return stack.join("/")
}

/**
 * Extensions to probe when looking up a resolved path in the symbol table.
 *
 * Coverage rationale (Fix C):
 *  - INDEXED_EXTENSIONS (indexer.ts) ingests: .ts .tsx .mjs .js .jsx
 *    (.rs .sql .md .py .go .toml are also indexed but the graph extractor
 *    produces no symbols for them — they can never be resolution targets)
 *  - SourceExt / KNOWN_EXTS (graph-extract.ts) also knows .cjs/.mts/.cts
 *    but the indexer does NOT ingest those, so they're excluded here.
 *  - Intersection = .ts .tsx .mjs .js .jsx
 * "" must stay first so an already-extensioned specifier short-circuits.
 */
export const CANDIDATE_EXTS = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
  "/index.mjs",
]

/**
 * Defensive upper bound on the number of symbol_ids a name-based blast-radius
 * query resolves (SIG-143). Input names are already capped upstream
 * (extractChangedSymbols → MAX_SYMBOLS=30) and scoped to changed files, so
 * this only guards a pathological changed file with many same-named symbols.
 */
export const MAX_BLAST_IDS = 200

/**
 * SIG-286: default per-list row cap for contextExpansionForChangedSymbols.
 * Bounds the definition / caller / import row lists independently so a
 * widely-called changed symbol can't return an unbounded edge set.
 */
export const DEFAULT_EXPANSION_ROWS = 40
