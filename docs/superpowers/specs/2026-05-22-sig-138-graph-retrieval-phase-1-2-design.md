# SIG-138 — Code/dependency graph for grounded retrieval (Phase 1+2 slice)

**Status:** Design approved (founder approved scope/storage/validation 2026-05-22; Codex architecture sign-off same day).
**Ticket:** [SIG-138](https://linear.app/sigilix/issue/SIG-138) (Medium, 8 pts, Engine — EPIC).
**This spec covers:** Phase 1 (graph writer in the indexer, shadow) + Phase 2 (graph expansion of vector hits in PR review, shadow). Deferred phases are listed under Scope boundaries.
**Builds on:** SIG-121 (AST symbol extraction), SIG-136 (run-lease + manifest activation), SIG-132 (owner/repo keying), SIG-129 (branch-aware retrieval).
**Greenlit approaches:** Codex design review 2026-05-22 (session `019e4d68-6c22-7f70-9274-cd3b93f77d7e`).

## Context

Retrieval today is pure vector similarity (`retrieval.ts::retrieveChunks`, `TOP_K=6`) plus SIG-121 query-time symbol extraction (`symbol-retrieval.ts::extractChangedSymbols`, which keeps symbol **names only**). Vector search finds the right *area* but misses the concrete *adjacent* code — most damagingly, the caller two files away that a diff breaks but that is neither lexically nor semantically similar to the changed lines, so it never enters the top-K.

A code/dependency graph grounds retrieval in real symbol relationships: a changed exported function deterministically yields its definition + direct callers + import dependents. This is the #1 remaining indexing gap vs Greptile and is a force multiplier on the existing role-specialized ensemble (logic/tests/security/perf + synthesizer) — blast radius routes the right specialists rather than relying on cosine similarity to surface impact.

## Goals & non-goals

**In scope (lean slice):**
- Symbol definitions with kind + line/col ranges + exported flag.
- File dependency edges: static `import`/`export…from`, **relative-path resolution only**.
- Best-effort call/ref edges: same-file unique-symbol calls + imported-binding calls.
- `RepoGraphDO` (first `new_sqlite_classes` DO) with versioned, lease-gated, manifest-activated writes.
- k-hop BFS expansion (K=2) of vector hits, hybrid-scored, injected as a separate labeled prompt section.
- PR blast radius → logic + tests specialists + synthesizer.
- GDPR delete of the repo graph.

**Out of scope (deferred phases):**
- Re-export / `export *` fixpoint resolution (transitive re-export chains).
- tsconfig `paths` / `@/` alias resolution.
- `obj.method()` low-confidence `calls_name` edges (schema reserves space; not emitted in v1).
- SCIP / tsc / tree-sitter extraction (schema is SCIP-importable later; v1 stays acorn-based).

**Bias throughout: prefer missing edges over false edges.** `walkAst` treats unknown TS node types as terminal (`ast-rules/walker.ts:20-31`); ambiguous or shadowed bindings drop to `resolution_status='unresolved'` (telemetry-only weight) rather than guess.

## Approach

**Phase 1 — two-phase write within the indexer run (Approach A, Codex-confirmed).** During the existing per-file streaming pass in `indexer.ts::processSlice` (`:851-870`, content already fetched once), extract symbol defs + raw import/export records + intra-file call edges and `upsertFileGraph` them into `RepoGraphDO` tagged `graph_version=runId` with status `pending`. After all shards finish — gated identically to the index manifest — a single `commitGraphVersion(runId)` resolves relative-path import edges (the full symbol table now exists), flips the version `active`, and GCs the prior version. Imports are unresolved until the final shard by design; **commit is the only resolver** (the ticket's "coordinated batch pass").

Rejected alternatives: **B (resolve at query time)** puts path resolution on the retrieval hot path and makes the stored graph unverifiable, killing the Phase 1 sanity bar; **C (separate graph-build job)** re-fetches files, can drift from the indexed SHA, and re-invents the SIG-136 lease.

**Phase 2 — additive graph expansion at retrieval.** After the per-pass merge in `triage-pr-review-ensemble.ts` (`~:1455-1538`) produces a vector-hit set, expand its symbols/paths against the active graph via BFS, hybrid-score, and inject the result as a new `[GRAPH CONTEXT]` labeled block in `pr-review-specialists.ts:586-600`. Additive only: if the graph is absent or fails, retrieval is unchanged.

### Approaches considered (edge resolution)

| Approach | Verdict |
|---|---|
| **A — two-phase within the run** (chosen) | Reuses the single file fetch; resolution has the complete symbol table; activation atomic with the manifest, so partial failure never activates a partial graph. Codex-recommended; matches ticket language. |
| B — resolve at query time | Rejected — pushes resolution onto the `TOP_K=6` retrieval hot path; stored graph can't be validated (defeats the Phase 1 bar). |
| C — separate graph-build job | Rejected — second full repo fetch (rate limits), SHA drift, duplicates SIG-136 lease logic, two version systems. |

## Components

### 1. New DO `src/do/repo-graph.ts` — `RepoGraphDO extends DurableObject<Env>`

First `new_sqlite_classes` DO. Mirrors `PrReviewRunDO`'s shape (class extends `DurableObject<Env>`, `fetch` route dispatch on `url.pathname`, pure decision helpers exported separately, `emit()` JSON-log helper) but uses `this.ctx.storage.sql.exec(...)`. **DO instance name = `indexNamespace(owner, repo)`** (`repo-index-manifest.ts:46-48`) — per-tenant isolation; no owner/repo columns inside.

**Schema** (created on first `fetch` via `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE graph_versions (
  graph_version TEXT PRIMARY KEY,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active')),
  created_at TEXT NOT NULL,
  committed_at TEXT
);

CREATE TABLE symbols (
  graph_version TEXT NOT NULL,
  symbol_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported INTEGER NOT NULL CHECK (exported IN (0,1)),
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_col INTEGER NOT NULL,
  scip_symbol TEXT,
  PRIMARY KEY (graph_version, symbol_id)
);
CREATE INDEX symbols_by_name ON symbols(graph_version, name, exported);
CREATE INDEX symbols_by_path ON symbols(graph_version, path, start_line);

CREATE TABLE file_edges (
  graph_version TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  edge_kind TEXT NOT NULL CHECK (edge_kind IN ('import','export','reexport','star_reexport')),
  specifier TEXT NOT NULL,
  imported_name TEXT,
  local_name TEXT,
  exported_name TEXT,
  target_path TEXT,
  target_symbol_id TEXT,
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('raw','resolved','unresolved','ambiguous')),
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  PRIMARY KEY (graph_version, edge_id)
);
CREATE INDEX file_edges_source ON file_edges(graph_version, source_path);
CREATE INDEX file_edges_target_symbol ON file_edges(graph_version, target_symbol_id);
CREATE INDEX file_edges_target_path ON file_edges(graph_version, target_path);

CREATE TABLE call_edges (
  graph_version TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  caller_symbol_id TEXT,
  callee_symbol_id TEXT,
  callee_name TEXT NOT NULL,
  call_kind TEXT NOT NULL CHECK (call_kind IN ('same_file','imported_binding')),
  start_line INTEGER NOT NULL,
  start_col INTEGER NOT NULL,
  PRIMARY KEY (graph_version, edge_id)
);
CREATE INDEX call_edges_callee ON call_edges(graph_version, callee_symbol_id);
CREATE INDEX call_edges_caller ON call_edges(graph_version, caller_symbol_id);
CREATE INDEX call_edges_source_line ON call_edges(graph_version, source_path, start_line);
```

`reexport` (named re-exports, e.g. `export { X } from './y'`) is **resolved to its direct target** in v1 exactly like an `import` edge — `target_path` and `target_symbol_id` are set during `commitGraphVersion`. `star_reexport` (`export * from '…'`) is stored raw and left unresolved in v1; the transitive re-export FIXPOINT is deferred to a future task. `symbol_id` = `s:` + `sha256(path \0 kind \0 name \0 start_line \0 start_col)`. `scip_symbol` stays nullable so a later SCIP import maps onto the same identity scheme without a rewrite.

**API (`fetch` routes + exported pure helpers):**

- `upsertFileGraph(graph_version, head_sha, path, { symbols, file_edges_raw, call_edges })` — replaces one file's rows for that version in **one SQLite transaction** (delete-then-insert; batched per file, never per edge, to avoid write amplification). Inserts a `pending` `graph_versions` row on first call for the version.
- `commitGraphVersion(runId)` — verify the pending version exists; in one transaction mark prior `active`→deleted, set this version `active` + `committed_at`, then GC all non-active version rows. Lease + manifest preconditions checked by the caller (see §3).
- `contextForVectorHits({ hits, k, caps })` — Phase 2 BFS expansion (see §4). Reads `active` version only.
- `blastRadius({ changedSymbols })` — for a set of changed `symbol_id`s, return direct callers (`call_edges_callee`) + import dependents (`file_edges_target_symbol`/`target_path`). Reads `active` version only.
- `deleteRepoGraph()` — drop all rows / dispose the DO (GDPR; see §5).

### 2. Extraction — extend SIG-121's walker (`src/lib/graph-extract.ts`, new)

SIG-121's `extractChangedSymbols` walks the AST but discards kind/loc/exported. New module reuses `ast-rules/parser.ts` (acorn@8.14 + acorn-typescript, `locations:true`) + `walkAst` and **retains** them. Pure function: `extractFileGraph(path, content) → { symbols, file_edges_raw, call_edges }`.

- **symbols:** `FunctionDeclaration`, `ClassDeclaration`, `MethodDefinition`, exported `VariableDeclaration` bindings — with `kind`, `loc` start/end line+col, `exported` flag (from enclosing `ExportNamedDeclaration`/`ExportDefaultDeclaration`).
- **file_edges_raw:** `ImportDeclaration` + `ExportNamedDeclaration`/`ExportAllDeclaration` with a `source` — capture `specifier`, imported/local/exported names, `edge_kind`. Resolution deferred to commit.
- **call_edges:** `CallExpression` where the callee resolves to a same-file symbol (`same_file`) or an imported binding (`imported_binding`). Ambiguous/shadowed → dropped (prefer missing over false). Never throws (regex-free; parse failure → empty result, logged).

### 3. Indexer wiring (`src/lib/indexer.ts`) — lease-gated, manifest-gated

- **Per-file write:** inside `processSlice` (`:851-870`), after the file content is fetched, call `extractFileGraph` and `upsertFileGraph(runId, headSha, path, …)`. Gated by `OPENCLAW_GRAPH_INDEX` (off → skip entirely). Best-effort per file: an extraction/DO error on one file logs + continues (never fails the index job).
- **Commit:** at the same point the index manifest is finalized (single-shard `:565` / multi-shard final write), and **only after** the manifest write **actually succeeds**, call `commitGraphVersion(runId)`. This closes a real gap: manifest writes are currently best-effort/logged-only (`repo-index-manifest.ts:193-212`, `indexer.ts:1024-1030`); "activated only after manifest commits" requires checking the write result, not assuming it.
- **Lease gate:** the SIG-136 lease lives in KV, so the **indexer** (not the DO) reads `activeRunId` and gates the commit call on `shouldFinalize(activeRunId, runId)`, mirroring `computeMerge`'s lease-first check (`repo-index-vectors.ts:203-211`). A superseded run never calls `commitGraphVersion` (writes nothing, flips nothing); its pending rows are GC'd by the next successful commit.
- **Empty repo:** when the indexer writes an empty manifest, `commitGraphVersion` commits an empty active version (which GCs any prior active graph) — never leaves a stale graph behind.

### 4. Phase 2 expansion (`src/lib/graph-retrieval.ts`, new) + ensemble wiring

`contextForVectorHits` runs K=2 BFS from the vector-hit seed symbols/paths over `call_edges` (callers) + `file_edges` (dependents), capped per the ticket: ~8 files / 12 symbols / 6 edges per symbol. Hybrid score:

```
final      = 0.70 * vector_norm + 0.30 * graph_norm      # λ = 0.70 (vector weight)
vector_norm = min-max over the candidate set; if range≈0 → 1.0 for vector hits, 0 for graph-only
graph_raw   = max over paths from seed hits of: seed_vector_norm * edge_weight * hop_decay
graph_norm  = graph_raw / max(graph_raw) in this query
```

Edge weights: same-file call `1.00`, imported-binding call `0.85`, direct import/export `0.65`, unresolved/ambiguous/raw `0.20` (telemetry-only by default). Hop decay: hop1 `1.00`, hop2 `0.55`; cap at 2 hops. **Graph-only additions capped at 4 chunks per role snapshot** initially.

- **Injection:** add a field to `SpecialistInitialMessageCtx` (`pr-review-specialists.ts` ~`:468`) and a `lines.push("[GRAPH CONTEXT]…")` block at `:586-600`, alongside `[RETRIEVAL SNAPSHOT]` — following SIG-121's `[LOGIC SYMBOL CONTEXT]` labeling precedent (`symbol-retrieval.ts::mergeLogicSnapshot`).
- **Blast radius routing:** changed symbols → `blastRadius` → direct callers + import dependents fed to the logic + tests specialists + synthesizer (per-role selection at `triage-pr-review-ensemble.ts:1959-1974`).
- **Gating + bake-off:** `OPENCLAW_GRAPH_RETRIEVAL` (off|shadow|post). In shadow, emit a `pr-review-graph-retrieval` telemetry event (overlap/jaccard vs vector-only, added-context rate, hop/edge-type distribution) for the SIG-86 bake-off, following SIG-121/129/110's `pr-review-*-retrieval` event pattern. No enforcement flip until founder reviews telemetry.

### 5. GDPR delete (`src/lib/index-delete.ts`)

Add a graph-delete arm to `deleteRepoIndex` under the existing owner-mismatch guard (`safeToTouchRepoOnlyState`), calling `RepoGraphDO(indexNamespace(owner,repo)).deleteRepoGraph()`. **Ungated by `OPENCLAW_INDEXER_ENABLED`** — delete is compliance and runs even when the indexer is off (consistent with `index-delete.ts:36-38`).

### 6. `wrangler.toml`

New `[[migrations]]` block with `new_sqlite_classes = ["RepoGraphDO"]` + a `[[durable_objects.bindings]]` entry (legacy-prefixed binding name per existing convention). New `[vars]`: `OPENCLAW_GRAPH_INDEX`, `OPENCLAW_GRAPH_RETRIEVAL` (default `off`).

## Data flow

```text
PHASE 1 (write)
push → index-repo job → processSlice (per shard, content fetched once):
  for each file: extractFileGraph → upsertFileGraph(runId, headSha, path)  [pending rows, txn per file]
  (lease refreshed per shard via SIG-136; superseded shard aborts, writes nothing)
final shard → persistManifest → IF manifest write succeeded AND shouldFinalize(activeRunId, runId):
  commitGraphVersion(runId): resolve relative-path import edges → flip version active → GC old version
  (lease mismatch OR manifest-write failure → abort commit; prior active graph stays serving)
empty repo → empty manifest → commitGraphVersion commits empty active version → clears stale graph

PHASE 2 (read, additive)
PR review → vector retrieve (TOP_K=6) → per-pass merge (SIG-129 branch-aware)
  → contextForVectorHits(merged hits): K=2 BFS, capped, hybrid score (λ=0.70) → top graph-only ≤4
  → inject [GRAPH CONTEXT] block (pr-review-specialists.ts:586-600)
  → blastRadius(changed symbols) → logic + tests specialists + synthesizer
  (graph absent/error → no block, retrieval unchanged)
  shadow → emit pr-review-graph-retrieval telemetry for SIG-86 bake-off
```

## Error handling / edge cases

- **Per-file extraction error** → log + skip that file's graph rows; index job unaffected (graph is best-effort, additive).
- **`upsertFileGraph` DO error** → log + continue; the version simply lacks that file. (A version missing files still commits; quality shows in telemetry.)
- **Superseded run at commit** → indexer's `shouldFinalize` is false → `commitGraphVersion` is never called; the run's pending rows are GC'd by the next successful commit's cleanup.
- **Manifest write failed** → do not commit the graph version (prevents an active graph with no manifest).
- **Retried same-run shard** → `upsertFileGraph` deletes that file's rows for the version then re-inserts (idempotent).
- **Commit never happens (crash mid-run)** → pending rows linger; the prior `active` version keeps serving; the next run's commit GCs stale pending rows.
- **Graph read error during PR review** → swallow → no `[GRAPH CONTEXT]` block (additive guarantee).
- **First deploy** → no active version → Phase 2 finds nothing → behaves exactly as today until the first index commits a graph.

## Testing

Per the founder's bar (sanity + telemetry) **plus** Codex's fixture-test set:

- **Extraction (`graph-extract.ts`):** fixtures for function/class/method/exported-var symbol capture (kind+loc+exported); relative import/export edge capture; same-file + imported-binding call edges; **shadowed/ambiguous binding → no edge** (prefer-missing bias); parse failure → empty result, no throw.
- **`RepoGraphDO`:** retry idempotence (re-`upsertFileGraph` same file → identical rows); stale-commit rejection (`commitGraphVersion` aborts when lease ≠ runId); pending→active flip + old-version GC; empty-repo commit clears prior active graph; `blastRadius` returns callers + dependents; `deleteRepoGraph` empties storage.
- **Phase 2 scoring (pure helper):** λ blend, min-max normalization (incl. range≈0 fallback), edge-weight × hop-decay, 2-hop cap, ≤4 graph-only cap.
- **Indexer wiring:** `commitGraphVersion` called only after manifest-write success + lease held; `OPENCLAW_GRAPH_INDEX=off` → no graph writes.
- **Delete:** graph-delete arm fires under the owner guard, ungated by indexer flag.
- **Phase 1 acceptance:** run on the Sigilix repo itself; assert sane counts (defs/edges per file in expected ranges, zero parse crashes, build within index budget); hand spot-check ~20 known edges (callers/dependents) against source.
- **Phase 2 acceptance:** shadow telemetry shows non-trivial overlap/added-context vs vector-only on real PRs before any enforcement discussion.
- Build gate: `npm run build` (tsc + eslint + full vitest).

## Scope boundaries

- **Worker indexer + PR-review path only.** The CLI `scripts/index-repo.mjs` is not changed (consistent with SIG-132/133/136).
- **No manifest/chunker/embedding changes.** Graph writes are a parallel, additive side-channel in `processSlice`.
- **Shadow only.** Both flags default `off`; neither phase changes posted review output until the founder flips them after telemetry review.
- **Deferred to later phases (epic, not this slice):** re-export/star fixpoint resolution, tsconfig `paths`/`@/` alias resolution, `obj.method()` low-confidence `calls_name` edges, and any SCIP/tsc/tree-sitter extraction. The schema (`reexport` edge kinds, nullable `scip_symbol`) reserves space for these without a future rewrite.
