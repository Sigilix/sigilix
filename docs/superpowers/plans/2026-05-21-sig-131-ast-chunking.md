# SIG-131 AST-Aware Chunking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chunk JS/TS files at AST boundaries (function/class signature+body together) via a coalesced line-interval partition, flag-gated and version-coupled, with line-window fallback for non-JS/TS and parse failures.

**Architecture:** Extract the line-window chunker into `chunk-core.ts` (breaks the import cycle), add a pure `ast-chunker.ts` that interval-partitions the file with 100% non-blank coverage, dispatch AST-vs-line in the indexer's chunk step behind `OPENCLAW_AST_CHUNKING` folded into `CHUNKER_VERSION`; the existing config-drift guard handles mid-run flag flips.

**Tech Stack:** TypeScript, Cloudflare Workers, acorn (`ast-rules/parser`), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-sig-131-ast-chunking-design.md`

**Verified facts (do not re-derive):**
- `indexer.ts` currently owns: `interface Chunk` (`{path,lineStart,lineEnd,content,fragmentIndex?}`), `CHUNK_LINES=30`, `CHUNK_OVERLAP=10`, `MAX_CHUNK_CHARS=1400`, `splitOversizedWindow(lines: ReadonlyArray<string>, windowStartLine: number): Chunk[]`, `chunkFile(path, content): Chunk[]`, `CHUNKER_VERSION=2`.
- Importers of those from `./indexer`: `src/lib/branch-retrieval.ts` (`chunkFile`, `Chunk`); `tests/indexer-pure.test.ts` (`chunkFile`, `splitOversizedWindow`, + likely `Chunk`/constants). **Re-exporting from `indexer.ts` keeps both working unchanged.**
- `parseSource(code, ext): {ok:true,ast}|{ok:false,reason}` and `SourceExt` (`.js .mjs .cjs .jsx .ts .mts .cts .tsx`) from `src/lib/ast-rules/parser.ts`. acorn returns an ESTree `Program`; `(ast as any).body` is the top-level statement array; each node has `node.loc.start.line` / `node.loc.end.line` (1-based) — `symbol-retrieval.ts` already relies on `node.loc`.
- `embedTexts`/`embedText` **throw on whitespace-only input** — so a chunk's content must never be blank. `chunkFile` already skips whitespace-only windows; the AST chunker must too.
- `computeRunId({owner,repo,headSha,modelId,chunkerVersion})` (`indexer.ts:381`). `CHUNKER_VERSION` is read at: bootstrap runId (`:454`/`:459`), freshness `currentChunkerVersion` (`:472`), shard config-drift recompute (`:664`), `persistManifest` (`:1020`). The shard drift guard (`:659-672`) recomputes runId and aborts on mismatch BEFORE any chunking.
- `processSlice` (`:844`) calls `chunkFile(file.path, content)` (`:870`); it's invoked at `:548` (bootstrap) and `:733` (shard). `persistManifest` (args object) hardcodes `chunkerVersion: CHUNKER_VERSION` and `windowLines: CHUNK_LINES`/`overlapLines: CHUNK_OVERLAP`.
- Repo uses `noUncheckedIndexedAccess`. Tests in `tests/`. Full gate: `npm run build` (tsc + eslint + vitest).

---

## File Structure

- **Create** `src/lib/chunk-core.ts` — `Chunk`, `CHUNK_LINES`, `CHUNK_OVERLAP`, `MAX_CHUNK_CHARS`, `splitOversizedWindow`, `chunkFile` (moved verbatim from indexer.ts).
- **Create** `src/lib/ast-chunker.ts` — `chunkFileAst`, `jsTsExtOf` (interval partition; pure; never throws).
- **Create** `tests/ast-chunker.test.ts`.
- **Modify** `src/lib/indexer.ts` — import the moved primitives from `chunk-core`, **re-export** `chunkFile`/`splitOversizedWindow`/`Chunk`; add `effectiveChunkerVersion`; add `OPENCLAW_AST_CHUNKING` read; thread `astOn` into runId/freshness/drift/manifest; dispatch AST-vs-line in `processSlice` + telemetry.
- **Modify** `src/index.ts` — add `OPENCLAW_AST_CHUNKING?: string` to `Env`.

---

## Task 1: Extract `chunk-core.ts` (pure refactor, no behavior change)

**Files:** Create `src/lib/chunk-core.ts`; Modify `src/lib/indexer.ts`.

- [ ] **Step 1: Create `src/lib/chunk-core.ts`** — move the block verbatim from `indexer.ts`. READ `indexer.ts` lines ~114-347 first and cut exactly these symbols (keep their bodies + comments byte-for-byte):
  - `interface Chunk` (with `fragmentIndex?`)
  - `const CHUNK_LINES = 30`, `const CHUNK_OVERLAP = 10`, `const MAX_CHUNK_CHARS = 1_400`
  - `export function splitOversizedWindow(...)`
  - `export function chunkFile(...)`
  Add `export` to `Chunk`, `CHUNK_LINES`, `CHUNK_OVERLAP`, `MAX_CHUNK_CHARS` (chunkFile/splitOversizedWindow are already exported). Header comment:
```typescript
// SIG-131: chunking primitives extracted from indexer.ts so the AST chunker
// (ast-chunker.ts) and the indexer can both depend on them without a cycle.
// The line-window chunker is the fallback for non-JS/TS files + parse failures.
```

- [ ] **Step 2: Update `indexer.ts`** — delete the moved definitions; import them from `chunk-core` and re-export for existing consumers (`branch-retrieval.ts`, `indexer-pure.test.ts` import from `./indexer`):
```typescript
import {
  type Chunk,
  CHUNK_LINES,
  CHUNK_OVERLAP,
  MAX_CHUNK_CHARS,
  splitOversizedWindow,
  chunkFile,
} from "./chunk-core"

export { chunkFile, splitOversizedWindow } from "./chunk-core"
export type { Chunk } from "./chunk-core"
```
Keep `CHUNKER_VERSION`, `EMBED_BATCH`, etc. in `indexer.ts`. `MAX_FILE_BYTES` stays too (it's not a chunk primitive). Confirm `chunkId`, `processSlice`, and `persistManifest` still resolve `Chunk`/`CHUNK_LINES`/`CHUNK_OVERLAP`/`MAX_CHUNK_CHARS`/`splitOversizedWindow` via the new imports.

- [ ] **Step 3: Verify (no behavior change)** — `npx tsc --noEmit` clean; `npx vitest run tests/indexer-pure.test.ts tests/branch-retrieval.test.ts` PASS (these import from `./indexer` and must be unchanged); `npm run build` PASS.

- [ ] **Step 4: Commit**
```bash
git add src/lib/chunk-core.ts src/lib/indexer.ts
git commit -m "refactor(sig-131): extract chunk-core (chunkFile/splitOversizedWindow/Chunk) from indexer"
```

---

## Task 2: `ast-chunker.ts` — interval-partition AST chunking

**Files:** Create `src/lib/ast-chunker.ts`, `tests/ast-chunker.test.ts`.

> **Algorithm/coverage checkpoint:** this is the load-bearing correctness task. At review it gets `verify-algo` + Codex conformance. The coverage-invariant test is the floor.

- [ ] **Step 1: Write the failing tests** (`tests/ast-chunker.test.ts`):

```typescript
import { describe, expect, it } from "vitest"
import { chunkFileAst, jsTsExtOf } from "../src/lib/ast-chunker"
import type { Chunk } from "../src/lib/chunk-core"

// Coverage invariant: every NON-blank line of `content` is covered by exactly
// one chunk, chunks don't overlap, and no chunk is whitespace-only.
function assertCoverage(content: string, chunks: Chunk[] | null) {
  expect(chunks).not.toBeNull()
  const lines = content.split("\n")
  const covered = new Map<number, number>() // line -> times covered
  for (const c of chunks!) {
    expect(c.content.trim().length).toBeGreaterThan(0) // no blank chunks (embedder throws on blank)
    for (let ln = c.lineStart; ln <= c.lineEnd; ln++) covered.set(ln, (covered.get(ln) ?? 0) + 1)
  }
  for (let ln = 1; ln <= lines.length; ln++) {
    const isBlank = (lines[ln - 1] ?? "").trim().length === 0
    const times = covered.get(ln) ?? 0
    if (isBlank) expect(times).toBeLessThanOrEqual(1)        // blank lines: 0 or 1 (never required)
    else expect(times).toBe(1)                              // non-blank: exactly once
  }
}

describe("jsTsExtOf", () => {
  it("recognizes JS/TS extensions, rejects others", () => {
    expect(jsTsExtOf("a/b.ts")).toBe(".ts")
    expect(jsTsExtOf("a/b.tsx")).toBe(".tsx")
    expect(jsTsExtOf("a/b.mjs")).toBe(".mjs")
    expect(jsTsExtOf("a/b.py")).toBeNull()
    expect(jsTsExtOf("a/b.rs")).toBeNull()
    expect(jsTsExtOf("Makefile")).toBeNull()
  })
})

describe("chunkFileAst", () => {
  it("returns null on parse failure (caller falls back)", () => {
    expect(chunkFileAst("x.ts", "const = = =", ".ts")).toBeNull()
  })

  it("keeps a small function's signature + body in one chunk", () => {
    const content = [
      `import { z } from "./z"`,                 // 1
      ``,                                          // 2 (blank)
      `export function compute(width: number) {`,  // 3
      `  return width * 0.0144`,                   // 4
      `}`,                                          // 5
    ].join("\n")
    const chunks = chunkFileAst("x.ts", content, ".ts")
    assertCoverage(content, chunks)
    const fn = chunks!.find((c) => c.content.includes("function compute"))!
    expect(fn.content).toContain("export function compute")  // signature
    expect(fn.content).toContain("return width * 0.0144")    // body — together
  })

  it("covers a file with multiple declarations, imports, and blank-line gaps", () => {
    const content = [
      `import a from "a"`,             // 1
      `import b from "b"`,             // 2
      ``,                              // 3 blank
      `export const K = 6`,            // 4
      ``,                              // 5 blank
      `function f() {`,                // 6
      `  return K`,                    // 7
      `}`,                             // 8
      `class C {`,                     // 9
      `  m() { return 1 }`,            // 10
      `}`,                             // 11
    ].join("\n")
    assertCoverage(content, chunkFileAst("x.ts", content, ".ts"))
  })

  it("line-splits an oversized declaration (still exact coverage, no blank chunks)", () => {
    const bigBody = Array.from({ length: 400 }, (_, i) => `  const x${i} = ${i} // ${"y".repeat(20)}`).join("\n")
    const content = `function big() {\n${bigBody}\n}`
    const chunks = chunkFileAst("x.ts", content, ".ts")
    assertCoverage(content, chunks)
    expect(chunks!.length).toBeGreaterThan(1)                 // split occurred
    for (const c of chunks!) expect(c.content.length).toBeLessThanOrEqual(1400)
  })

  it("comment-only / empty body still covered (no crash, no blank chunk)", () => {
    expect(chunkFileAst("x.ts", "", ".ts")).toEqual([])       // empty file
    const onlyComments = "// a\n// b\n"
    assertCoverage(onlyComments, chunkFileAst("x.ts", onlyComments, ".ts"))
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/ast-chunker.test.ts`).

- [ ] **Step 3: Implement** — create `src/lib/ast-chunker.ts`:

```typescript
// SIG-131: AST-aware chunking for JS/TS. Produces chunks via a coalesced
// line-interval partition of the file — every NON-blank line lands in exactly
// one chunk, no overlaps, top-level declarations kept whole (signature+body).
// Pure + never throws: any failure returns null so the indexer falls back to
// the line-window chunker. Per-method class decomposition is deferred (SIG-131
// follow-up); an oversized declaration line-splits via splitOversizedWindow.

import { type Chunk, MAX_CHUNK_CHARS, splitOversizedWindow } from "./chunk-core"
import { parseSource, type SourceExt } from "./ast-rules/parser"

const JS_TS_EXTS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
])

/** The JS/TS SourceExt for a path, or null (non-JS/TS → line-window fallback). */
export function jsTsExtOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const e = path.slice(dot).toLowerCase()
  return JS_TS_EXTS.has(e) ? (e as SourceExt) : null
}

/**
 * Chunk `content` at AST boundaries. Returns null on parse failure / any
 * internal error (caller falls back to line-window). Never throws.
 */
export function chunkFileAst(path: string, content: string, ext: SourceExt): Chunk[] | null {
  let parsed: ReturnType<typeof parseSource>
  try {
    parsed = parseSource(content, ext)
  } catch {
    return null
  }
  if (!parsed.ok) return null

  const lines = content.split("\n")
  const lineCount = lines.length

  // 1. Top-level statement intervals [startLine, endLine] (1-based inclusive).
  let body: unknown
  try {
    body = (parsed.ast as { body?: unknown }).body
  } catch {
    return null
  }
  if (!Array.isArray(body)) return null

  const intervals: Array<[number, number]> = []
  for (const node of body as Array<{ loc?: { start?: { line?: unknown }; end?: { line?: unknown } } }>) {
    const s = node?.loc?.start?.line
    const e = node?.loc?.end?.line
    if (typeof s !== "number" || typeof e !== "number") continue
    if (s < 1 || e < s) continue
    intervals.push([s, Math.min(e, lineCount)])
  }

  // 2. Coalesce: sort by start, merge overlapping OR adjacent ranges (export
  //    wrapper vs inner decl, same-line statements, nested decls all merge).
  intervals.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  const merged: Array<[number, number]> = []
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1] + 1) {
      if (e > last[1]) last[1] = e
    } else {
      merged.push([s, e])
    }
  }

  // 3. Gap-fill from a cursor → cover [1..lineCount] with no gap/overlap.
  //    A slice that is whitespace-only is skipped (the embedder throws on blank
  //    input; chunkFile skips blank windows too — so blank-only regions are
  //    intentionally uncovered, never dropped CONTENT).
  const out: Chunk[] = []
  const emit = (startLine: number, endLine: number): void => {
    if (endLine < startLine) return
    const slice = lines.slice(startLine - 1, endLine) // 0-based slice, inclusive end
    const text = slice.join("\n")
    if (text.trim().length === 0) return // skip whitespace-only (no blank chunks)
    if (text.length > MAX_CHUNK_CHARS) {
      for (const sub of splitOversizedWindow(slice, startLine)) out.push({ ...sub, path })
    } else {
      out.push({ path, lineStart: startLine, lineEnd: endLine, content: text })
    }
  }

  let cursor = 1
  for (const [s, e] of merged) {
    if (s > cursor) emit(cursor, s - 1) // gap before this interval (imports, blanks, comments)
    emit(s, e)
    cursor = e + 1
  }
  if (cursor <= lineCount) emit(cursor, lineCount) // trailing gap
  return out
}
```

- [ ] **Step 4: Run → PASS** (`npx vitest run tests/ast-chunker.test.ts`); `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add src/lib/ast-chunker.ts tests/ast-chunker.test.ts
git commit -m "feat(sig-131): ast-chunker — coalesced line-interval partition (100% non-blank coverage)"
```

---

## Task 3: `effectiveChunkerVersion` + flag plumbing + version coupling

**Files:** Modify `src/index.ts`, `src/lib/indexer.ts`.

- [ ] **Step 1: Env flag** — in `src/index.ts`, after the existing `OPENCLAW_*?: string` env fields, add:
```typescript
  // SIG-131: AST-aware chunking. When "on", JS/TS files chunk on AST
  // boundaries (CHUNKER_VERSION effectively 3) and repos re-index under the
  // new scheme; default off (line-window, version 2). Flip via
  // `wrangler secret put OPENCLAW_AST_CHUNKING on`.
  OPENCLAW_AST_CHUNKING?: string
```

- [ ] **Step 2: `effectiveChunkerVersion` + flag read** — in `indexer.ts`, near `CHUNKER_VERSION`:
```typescript
/** SIG-131: the chunker config version, folded with the AST-chunking flag.
 *  off → 2 (line-window), on → 3 (AST). Flipping the flag changes the
 *  effective version → runId/manifest/freshness all shift → repos re-index. */
export function effectiveChunkerVersion(astChunkingOn: boolean): number {
  return astChunkingOn ? 3 : CHUNKER_VERSION
}

/** Read the AST-chunking flag from env (case-insensitive "on"). */
export function astChunkingEnabled(env: Env): boolean {
  return (env.OPENCLAW_AST_CHUNKING ?? "").trim().toLowerCase() === "on"
}
```

- [ ] **Step 3: Thread the effective version through the four read sites.** READ `indexer.ts` and at EACH site replace `CHUNKER_VERSION` with `effectiveChunkerVersion(astChunkingEnabled(env))` (compute `const astOn = astChunkingEnabled(env)` once at the top of the bootstrap and shard handlers, reuse it):
  - bootstrap runId compute (`~:454/459`): `chunkerVersion: effectiveChunkerVersion(astOn)`.
  - bootstrap freshness check `currentChunkerVersion` (`~:472`): `effectiveChunkerVersion(astOn)`.
  - shard config-drift recompute (`~:664`): `chunkerVersion: effectiveChunkerVersion(astOn)`. (This is what makes a mid-chain flag flip abort the chain cleanly — the recomputed runId mismatches the carried `shard.runId`.)
  - `persistManifest`: it currently sets `chunkerVersion: CHUNKER_VERSION`. Add `chunkerVersion: number` to `PersistManifestArgs` and pass `effectiveChunkerVersion(astOn)` from both call sites; inside `persistManifest` use `args.chunkerVersion`. Leave `windowLines: CHUNK_LINES`/`overlapLines: CHUNK_OVERLAP` as-is (forensic, unchanged).

- [ ] **Step 4: Test** — add to `tests/indexer-pure.test.ts`:
```typescript
import { effectiveChunkerVersion } from "../src/lib/indexer"
describe("effectiveChunkerVersion (SIG-131)", () => {
  it("is 2 when AST chunking off, 3 when on", () => {
    expect(effectiveChunkerVersion(false)).toBe(2)
    expect(effectiveChunkerVersion(true)).toBe(3)
  })
})
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm run build` PASS (existing indexer-consumer tests must stay green — if any assert a hardcoded `chunkerVersion: 2` in a manifest/runId with the flag implicitly off, they still pass since `effectiveChunkerVersion(false) === 2`).

- [ ] **Step 6: Commit**
```bash
git add src/index.ts src/lib/indexer.ts tests/indexer-pure.test.ts
git commit -m "feat(sig-131): OPENCLAW_AST_CHUNKING flag + effectiveChunkerVersion coupling (off=2/on=3)"
```

---

## Task 4: Dispatch AST-vs-line in `processSlice` + telemetry

**Files:** Modify `src/lib/indexer.ts`.

- [ ] **Step 1: Imports** — add `import { chunkFileAst, jsTsExtOf } from "./ast-chunker"` to `indexer.ts`.

- [ ] **Step 2: Thread `astChunking` into `processSlice`.** Add `astChunking: boolean` to `ProcessSliceArgs`. At BOTH `processSlice({...})` call sites (`~:548` bootstrap, `~:733` shard) pass `astChunking: astOn` (the `astOn` const from Task 3). `processSlice` also needs to count chunk-source for telemetry — add to `ProcessSliceResult` (and initialize) counters `astChunkFiles`, `lineChunkFiles`, `parseFallbackFiles` (numbers), or accumulate locally and log at the end of processSlice.

- [ ] **Step 3: Dispatch at the chunk step.** Replace the `const fileChunks = chunkFile(file.path, content)` line (`~:870`) with:
```typescript
    const ext = args.astChunking ? jsTsExtOf(file.path) : null
    let fileChunks
    if (ext !== null) {
      const astChunks = chunkFileAst(file.path, content, ext)
      if (astChunks !== null) {
        fileChunks = astChunks
        astChunkFiles += 1
      } else {
        fileChunks = chunkFile(file.path, content) // parse failed → line-window
        parseFallbackFiles += 1
      }
    } else {
      fileChunks = chunkFile(file.path, content) // AST off or non-JS/TS
      lineChunkFiles += 1
    }
```
Declare `let astChunkFiles = 0, lineChunkFiles = 0, parseFallbackFiles = 0` at the top of `processSlice` before the file loop.

- [ ] **Step 4: Telemetry.** At the end of `processSlice` (before return), emit:
```typescript
    console.log(JSON.stringify({
      event: "index-chunking",
      owner: args.owner, repo: args.repo,
      ast_on: args.astChunking,
      ast_chunk_files: astChunkFiles,
      line_chunk_files: lineChunkFiles,
      parse_fallback_files: parseFallbackFiles,
    }))
```
(Confirm `args.owner`/`args.repo` exist on `ProcessSliceArgs`; if not, use the fields it does carry — match the other `console.log` events in the file.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit` clean; `npm run build` PASS (full vitest; existing indexer-consumer tests stay green — with the flag off, `astChunking=false` so every file goes through `chunkFile`, identical to today). If an existing consumer test wants to exercise the AST path, it can set `env.OPENCLAW_AST_CHUNKING="on"`, but that's optional here.

- [ ] **Step 6: Commit**
```bash
git add src/lib/indexer.ts
git commit -m "feat(sig-131): dispatch AST vs line-window chunking in processSlice + index-chunking telemetry"
```

---

## Post-implementation (not part of the TDD loop)

- **Code review:** `code-reviewer` + `typescript-pro`; **Task 2 (interval partition)** → `verify-algo` (coverage invariant: no gap/overlap on non-blank lines; coalesce correctness; oversized split) + a Codex conformance pass (Codex shaped this design — confirm: interval-partition not node-walk, blank chunks skipped, fallback on parse fail, version coupling threaded through all 4 sites, drift guard handles mid-run flip).
- **CodeRabbit** at phase end before the PR.
- **Rollout:** flag default off. Flip on Sigilix's own repo / a canary first, confirm via `wrangler tail` that `index-chunking ast_on=true ast_chunk_files>0` and `pr-review` retrieval still works; then validate the precision improvement via the SIG-86 bake-off before a broad flip. A flip triggers a re-index wave (now that SIG-136 makes re-index work).
- **Follow-up ticket:** per-method oversized-class decomposition (deferred from v1).
- **PR:** branch `sig-131`; `Closes SIG-131`; In Progress at start, In Review on PR open.
