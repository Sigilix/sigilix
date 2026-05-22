# SIG-131 — AST-aware chunking (v1: top-level interval partition)

**Status:** Design approved (founder approved rollout + granularity + v1 deferral 2026-05-21; design incorporates Codex's architecture review).
**Ticket:** [SIG-131](https://linear.app/sigilix/issue/SIG-131) — indexer/retrieval-parity cluster.
**Builds on:** SIG-121 (acorn infra: `parseSource`/`walkAst`), SIG-133 (split-not-drop chunker, `splitOversizedWindow`), **SIG-136 (re-index lease — makes the flag→`CHUNKER_VERSION`→re-index rollout actually work; was Codex's #1 blocker)**.

## Problem

The indexer chunks every file with **fixed 30-line windows** (10 overlap, 1400-char cap) in `indexer.ts:chunkFile`. It is blind to code structure: it slices through function/class bodies and separates signatures from implementations. A retrieval for `validateUserToken` can return the bottom half of the function with no signature/params → the model reasons on a fragment (missed issues, "param doesn't exist"). Worst in typed languages. Industry leaders (Greptile, CodeRabbit) chunk on syntax boundaries; fixed-window is the gap.

## Approach (Codex-reviewed)

A new pure module chunks JS/TS at AST boundaries via a **coalesced line-interval partition**; the existing line-window chunker stays as the fallback for non-JS/TS files **and** parse failures. Flag-gated (`OPENCLAW_AST_CHUNKING`, default off) folded into `CHUNKER_VERSION`, so flipping it re-indexes under the chosen scheme.

**v1 scope (founder ruling):** ship **top-level interval-partitioning only**. An oversized class/function falls back to `splitOversizedWindow` (line-split). Per-method class decomposition is a follow-up once the interval logic is proven by coverage tests — it stacks recursive interval logic on the (also-new) base partition and is the higher-risk part.

**Why interval-partition, not a node-walk (Codex MAJOR):** naively emitting "a chunk per declaration + gap chunks" risks overlaps (nested decls, same-line, export-wrapper-vs-inner) and dropped lines. The only way to guarantee the SIG-133 no-loss invariant is a sorted, coalesced, gap-filled line-interval partition with coverage tests.

## Components

### 1. `src/lib/chunk-core.ts` (extracted — breaks the import cycle)

Move from `indexer.ts`: the `Chunk` interface, `MAX_CHUNK_CHARS`, `CHUNK_LINES`, `CHUNK_OVERLAP`, `splitOversizedWindow`, and the line-window `chunkFile`. `indexer.ts` **re-exports** `chunkFile` + `Chunk` so existing importers (`branch-retrieval.ts` imports both) keep working unchanged. `ast-chunker.ts` imports the primitives from `chunk-core.ts`. (Without this, `indexer.ts` → `ast-chunker.ts` → `indexer.ts` is a runtime cycle; `chunk-core.ts` is the clean break — Codex confirmed.)

### 2. `src/lib/ast-chunker.ts` (pure) — `chunkFileAst(path, content, ext): Chunk[] | null`

1. `parseSource(content, ext)`; on failure → **return `null`** (signals the dispatcher to fall back). Wrap the whole body so any internal throw also → `null`.
2. Collect each top-level `Program.body` statement's line range `[node.loc.start.line, node.loc.end.line]`.
3. **Coalesce** into a sorted, non-overlapping interval list: sort by start; merge any interval that overlaps or is adjacent to the previous (covers nested decls, same-line statements, an export wrapper whose `loc` differs from the inner decl).
4. **Gap-fill from a cursor** (line 1 → `lineCount`): walk the coalesced intervals in order; for each, emit any lines *between* the cursor and the interval start as gap chunk(s) (imports, blank lines, leading comments acorn doesn't attach), then emit the interval as a chunk, advance the cursor past it. After the last interval, emit a trailing gap chunk for any remaining lines. **Result: every line ∈ exactly one chunk** (no gap, no overlap).
5. Any emitted chunk whose content exceeds `MAX_CHUNK_CHARS` → replace it with `splitOversizedWindow(itsLines, itsStartLine)` (line-split — this is where an oversized class/function degrades; per-method deferred).
6. Gap chunks are built directly from the line slice (NOT via `chunkFile`, which **skips whitespace-only windows** — that would drop blank lines and break no-loss, Codex). A gap over `MAX_CHUNK_CHARS` also goes through `splitOversizedWindow`.

Reuses `Chunk`/`MAX_CHUNK_CHARS`/`splitOversizedWindow` from `chunk-core.ts`. Mirrors `symbol-retrieval.ts` purity/JSDoc style.

### 3. Dispatcher (indexer chunk step)

In `processSlice` (where `chunkFile(file.path, content)` is called at `indexer.ts:870`), route:
```
astOn && isJsTs(ext) && (chunkFileAst(...) returns non-null)  →  AST chunks
otherwise (non-JS/TS, AST off, or parse failure)             →  line-window chunkFile
```
`astOn` is read from the flag and threaded into `processSlice` (alongside the run's other config). `isJsTs` matches the `SourceExt` set (`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`).

### 4. `CHUNKER_VERSION` coupling + multi-shard consistency

Add `effectiveChunkerVersion(astOn: boolean): number` = `astOn ? 3 : 2`. Replace the `CHUNKER_VERSION` const reads (currently `indexer.ts:454/459` bootstrap runId, `:472` freshness, `:664` shard config-drift recompute, `:1020` manifest write) with `effectiveChunkerVersion(astOn)`, where `astOn` is read from `OPENCLAW_AST_CHUNKING` at the handler level.

**Multi-shard flag-flip handled by the EXISTING config-drift guard (no payload change):** the shard already recomputes `runId` from the live config at `:659-672` and aborts (`index-shard-config-drift`) BEFORE any tree-fetch/chunking if it ≠ the carried `shard.runId`. With the version now flag-derived, a flag flip mid-chain makes the shard's recomputed `runId` mismatch → clean abort before any work (no orphaned upserts) → the chain heals on the next push under the new scheme. This is leaner than capturing the config in the shard payload and aborts earlier (Codex's BLOCKING multi-shard concern resolved via existing machinery).

Note: `chunkerVersion` identifies the chunker *config* (astOn mode), not a per-file outcome — a file that falls back to line-window under `astOn` (parse failure / non-JS-TS) is deterministic, so the whole-run version stays coherent.

### 5. Telemetry

Per-run `index-chunking` event: `ast_chunk_files`, `line_chunk_files`, `parse_fallback_files`, `ast_on`. Feeds the SIG-86 bake-off precision comparison (line-window baseline vs AST).

## Coverage invariant (load-bearing correctness)

For any input file, `union(chunk line-ranges) == [1..lineCount]` with **no gaps and no overlaps**. Tested exhaustively against fixtures: nested declarations, same-line statements, an `export`-wrapped declaration, leading comments, blank lines between declarations, a file ending mid-declaration, and an oversized declaration (post-`splitOversizedWindow` the union still covers exactly). This is the SIG-133 no-loss guarantee re-expressed as a partition.

## Error handling / edge cases

- Parse failure → `chunkFileAst` returns `null` → line-window fallback (file never lost). Any internal AST-walk throw → caught → `null` → fallback.
- Non-JS/TS extensions (`.rs/.py/.go/.sql/.md/.toml`) → never enter the AST path → line-window.
- Empty / single-line files → one chunk (or none for empty), coverage trivially holds.
- A `Program.body` with zero statements (comment-only / empty) → the whole file is one gap chunk → covered.
- Oversized interval / oversized gap → `splitOversizedWindow` (fragment ids preserved, SIG-133).
- Flag flip mid-multi-shard-chain → existing config-drift guard aborts the chain cleanly; next push re-indexes (acceptable for a deliberate operator rollout — a chunker change re-indexes everything anyway).

## Testing

Unit (pure, no I/O):
- **Coverage invariant** helper-asserted across all fixtures above (the load-bearing test).
- Interval coalesce: overlapping ranges, adjacent ranges, same-line, export-wrapper-vs-inner all merge correctly.
- Small function/class → one chunk (signature+body together).
- Oversized declaration → line-split, union still exact.
- `parseSource` failure → `null`; non-JS/TS → not handled by AST (dispatcher's job).
- Gap chunks preserve blank lines (NOT dropped — the `chunkFile`-skips-whitespace trap).
- `effectiveChunkerVersion(true) === 3`, `(false) === 2`.
- Dispatcher: flag on + JS/TS + parse-ok → AST; flag off / non-JS/TS / parse-fail → line-window.
- Multi-shard drift: a shard whose effective version differs from the carried `runId` aborts (extend/confirm the existing `index-shard-config-drift` test).
- Build gate: `npm run build` (tsc + eslint + full vitest); existing indexer/`chunkFile` tests stay green after the `chunk-core` extraction (re-exports preserve the public surface).

## Scope boundaries (v1)

- **Worker indexer only** (`src/lib/indexer.ts`); CLI `scripts/index-repo.mjs` stays line-window (consistent with SIG-133; the freshness gate re-indexes via the Worker).
- **JS/TS subset only**; other indexed extensions → line-window.
- **Per-method class decomposition DEFERRED** (oversized class → line-split); follow-up ticket once the interval partition is proven.
- **Flag default off**; the SIG-86 bake-off validates the precision improvement before the flag flips on.
- `MAX_CHUNK_CHARS=1400` unchanged (token re-tuning out of scope).
