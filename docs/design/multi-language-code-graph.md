# Multi-language code graph — extraction plan beyond JS/TS

**Status:** Decision documented; Python (symbols + import edges) implemented in this PR. Go/Java are phase 2.
**Owner:** Sigilix Engine.
**Linear:** [SIG-146](https://linear.app/sigilix/issue/SIG-146). Epic: SIG-138 (code/dependency graph). Prereq: SIG-138 graph proven in prod.

---

## Problem

`RepoGraphDO` (SIG-138) extracts JS/TS only, via `acorn` in `src/lib/graph-extract.ts`. Multi-language support is needed for parity with Sourcegraph (SCIP breadth) and Greptile (multi-lang). The `RepoGraphDO` schema is already SCIP-importable by design, and `FileGraph` (`symbols` / `fileEdgesRaw` / `callEdges`) is language-neutral — so the extractor is the only language-specific layer.

## The load-bearing constraint

`extractFileGraph(path, content): FileGraph` is **pure and synchronous**, and the whole engine is a **Cloudflare Worker**. `parser.ts` is deliberately pure-JS ESM (acorn + acorn-typescript) "with no Node-only APIs" so it runs in the isolate. **tree-sitter changes this**: `web-tree-sitter` is WASM, which means (a) bundling per-grammar `.wasm`, and (b) async instantiation — forcing `extractFileGraph` to become async and threading that through the indexer hot path. That cost is the crux of the decision below.

Also relevant: the indexer already lists `.py` and `.go` in `INDEXED_EXTENSIONS`, so those files **already flow through** fetch → chunk → `extractFileGraph` (which silently returns empty for them today) → `writeFileGraph` → retrieval. A new extractor needs no new plumbing — it only has to produce the `FileGraph` shape.

## Options considered

| Option | Fidelity | Worker fit | Code to own | Build/runtime dep |
|---|---|---|---|---|
| **A. tree-sitter per language** (`web-tree-sitter` + grammar `.wasm`) | High (real parse) | **Poor** — WASM bundling + makes extraction **async** | N grammar integrations | `.wasm` assets in the bundle |
| **B. SCIP import** (scip-python/go/java) | Highest (compiler-grade, cross-file resolved) | **N/A** — ingested out-of-band, no Worker parsing | Thin importer + ingest endpoint | Customer/CI runs the SCIP indexer |
| **C. Pure-JS per-language extractor** (heuristic, like acorn for JS) | Medium (symbols + imports solid; call-edge resolution limited) | **Best** — stays pure + sync, zero new deps | One module per language | none |

## Decision — hybrid, sequenced by where each option is strongest

1. **Python now → Option C (pure-JS extractor).** Keeps the pure/sync Worker interface, zero new deps, and ships immediately behind the existing `graphIndexEnabled` flag. `scip-python` coverage is still immature (noted on SIG-146), so SCIP-import buys little here. Symbols + import edges land in this PR; **call-edge resolution is deferred** to a follow-up — mirroring how JS/TS shipped (symbols = T1, file edges = T2, call edges = T3 as separate tasks).
2. **Go / Java → Option B (SCIP import), phase 2.** `scip-go` and `scip-java` (Sourcegraph) are mature and compiler-accurate; re-implementing that in pure JS would be low-fidelity. These ingest pre-built SCIP indexes out-of-band into the already-SCIP-importable `RepoGraphDO` — no Worker parsing, no async refactor.
3. **tree-sitter (Option A) is deferred, not rejected.** It becomes the right call only if/when (a) we accept async extraction in the indexer, and (b) per-language fidelity beyond symbols+imports is demanded for a local-first/no-build language without good SCIP tooling. Revisit then; the router below makes it a drop-in.

## Architecture — extension router

A thin dispatch layer in `graph-extract.ts` keyed by file extension. Each language is an extractor module behind the same `(path, content) => FileGraph` contract; adding a language is adding one module + one routing entry.

```text
extractFileGraph(path, content)
  → ext = lower(extname(path))
  → .js/.ts/.jsx/.tsx/.mjs/.cjs/.mts/.cts → extractJsTsFileGraph (acorn, existing)
  → .py                                   → extractPythonFileGraph (this PR)
  → .go / .java                           → SCIP import (phase 2, out-of-band)
  → else                                  → empty FileGraph
```

All extractors are best-effort and **never throw** (empty `FileGraph` on parse failure) — the indexer's graph write is already best-effort/additive.

## Python extractor v1 — scope & semantics

- **Symbols:** `def` / `async def` → `function` (or `method` when lexically nested in a `class`), `class` → `class`. Indentation-aware nesting; decorators tolerated.
- **`exported`:** Python has no `export`; mapped to **module-level (indent 0) public** names (not `_`-prefixed) — i.e. what is importable cross-file. Methods/nested are not exported.
- **Import edges (`fileEdgesRaw`, kind `import`):** `import a`, `import a.b as c`, `from x import y`, `from x import y as z`, `from . import y`. Single-line forms (incl. parenthesized lists on one line); multi-line parenthesized imports are a known v1 gap.
- **Call edges:** empty in v1 (resolution needs import-binding analysis — deferred, as for JS/TS T3).
- **Robustness:** triple-quoted strings/docstrings are tracked and skipped so `def`/`import` inside them are not mis-extracted; keyword matches are anchored at logical-line start.

## Queryability (AC #4)

Free: the Python extractor emits the same `FileGraph` shape, written by the same `writeFileGraph` into the same `RepoGraphDO`, and read by the same retrieval path (`symbol-retrieval.ts` / graph expansion). No retrieval changes.

## Rollout

Ships dark behind `graphIndexEnabled` (same gate as JS/TS). Validation against real Python repos via the e2e fixtures. Full SIG-146 "Done" still gated on SIG-138 proven in prod (prereq) + Go/Java phase 2.
