# SIG-129 Branch-Aware Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a PR's changed/added code retrievable during review by overlaying the already-fetched changed-file head content onto the main-only Vectorize index (head wins on path collision), eliminating "symbol doesn't exist" hallucinations and branch-only false negatives.

**Architecture:** A new pure-ish module `branch-retrieval.ts` chunks the changed-file head content (already held in `astFilesByPath`) with the indexer's own `chunkFile`, embeds it once per review with the same `bge-base-en-v1.5` model, and serves in-memory cosine retrieval. Each PR-review retrieval pass (shared preflight, perf, symbol) merges these branch chunks with its main-index chunks before formatting. Flag-gated (`OPENCLAW_BRANCH_AWARE_RETRIEVAL`, default off), best-effort, shadow telemetry feeding the SIG-86 bake-off.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers AI (`@cf/baai/bge-base-en-v1.5`, 768-dim, cosine), Vectorize, Vitest.

**Spec:** `docs/superpowers/specs/2026-05-21-sig-129-branch-aware-retrieval-design.md`

**Verified facts (do not re-derive):**
- Vectorize index `OPENCLAW_CODE_INDEX` is created `--metric=cosine` (`wrangler.toml:44`). In-memory cosine over the same vectors is therefore directly comparable to Vectorize scores — the merge re-rank is sound.
- `chunkFile(path, content): Chunk[]` is exported from `src/lib/indexer.ts:316`. `Chunk = { path, lineStart, lineEnd, content, fragmentIndex? }`. `CHUNKER_VERSION = 2`.
- `embedTexts(ai, texts): Promise<number[][]>` exported from `src/lib/embeddings.ts:53` (batched, strict shape validation, same model). `EMBEDDING_DIMENSIONS = 768`.
- `RetrievedChunk = { path, lineStart, lineEnd, content, score }` exported from `src/lib/retrieval.ts:57`.
- The ensemble already builds `astFilesByPath: Map<string,string>` of changed JS/TS head content at `triage-pr-review-ensemble.ts:1360`, gated by `(astRulesConfig.enabled || wantSymbolRetrieval) && jsTsPaths.length > 0`.
- Retrieval passes producing chunk arrays: `preflightChunks` (`:1273`, shared by all specialists), perf `perfChunks` (`:1306`), symbol `symbolChunks` (`:1417`).
- Tests live in `tests/`, Vitest, pure-function style. Run a single file: `npx vitest run tests/branch-retrieval.test.ts`. Full gate: `npm run build` (tsc + eslint + vitest).

---

## File Structure

- **Create** `src/lib/branch-retrieval.ts` — branch chunk build, embed, cosine retrieval, merge, gate. Pure except the single `embedTexts`/`embedText` calls.
- **Create** `tests/branch-retrieval.test.ts` — unit tests incl. the acceptance-criterion fixture.
- **Modify** `src/index.ts` — add `OPENCLAW_BRANCH_AWARE_RETRIEVAL?: string` to `Env`.
- **Modify** `src/lib/triage-pr-review-ensemble.ts` — fetch gate, build branch set once, merge into the three passes, telemetry.

---

## Task 1: `mergeBranchAware` (pure merge, head wins on path)

**Files:**
- Create: `src/lib/branch-retrieval.ts`
- Test: `tests/branch-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest"
import { mergeBranchAware } from "../src/lib/branch-retrieval"
import type { RetrievedChunk } from "../src/lib/retrieval"

function rc(path: string, a: number, b: number, score: number, content = "x"): RetrievedChunk {
  return { path, lineStart: a, lineEnd: b, content, score }
}

describe("mergeBranchAware", () => {
  it("drops ALL main chunks for a path that branch also has (head wins)", () => {
    const main = [rc("a.ts", 1, 30, 0.9, "STALE"), rc("a.ts", 20, 50, 0.8, "STALE2"), rc("b.ts", 1, 30, 0.7)]
    const branch = [rc("a.ts", 1, 30, 0.5, "HEAD")]
    const out = mergeBranchAware(main, branch)
    const aPaths = out.filter((c) => c.path === "a.ts")
    expect(aPaths).toHaveLength(1)
    expect(aPaths[0].content).toBe("HEAD")
    expect(out.some((c) => c.path === "b.ts")).toBe(true)
  })

  it("appends branch-only paths and re-ranks by score desc", () => {
    const main = [rc("b.ts", 1, 30, 0.4)]
    const branch = [rc("new.ts", 1, 30, 0.95, "NEW")]
    const out = mergeBranchAware(main, branch)
    expect(out.map((c) => c.path)).toEqual(["new.ts", "b.ts"])
  })

  it("handles empty sides", () => {
    expect(mergeBranchAware([], [])).toEqual([])
    expect(mergeBranchAware([rc("a.ts", 1, 2, 0.1)], [])).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: FAIL — `mergeBranchAware` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/branch-retrieval.ts`:

```typescript
// SIG-129: branch-aware retrieval. The codebase index covers only the
// default branch, so a PR's new/changed code is invisible to retrieval —
// causing branch-only false negatives and "symbol doesn't exist"
// hallucinations. The PR-review ensemble already holds the changed-file
// HEAD content in `astFilesByPath`; this module makes that content
// retrievable in-memory and merges it into each retrieval pass with HEAD
// content winning on path collision.
//
// Model: branch state = main index (unchanged files) ∪ changed-file head
// content (overrides). No new GitHub fetches, no Vectorize writes.

import type { RetrievedChunk } from "./retrieval"

/**
 * Merge main-index chunks with branch (PR-head) chunks. A path present in
 * the branch set is treated as authoritative: ALL main chunks for that
 * path are dropped (they reflect stale `main` content) and the branch
 * chunks take their place. Branch-only paths are appended. The result is
 * re-ranked by score descending (Vectorize and our in-memory scores are
 * both cosine — see wrangler.toml:44 — so they are directly comparable).
 */
export function mergeBranchAware(
  mainChunks: readonly RetrievedChunk[],
  branchChunks: readonly RetrievedChunk[],
): RetrievedChunk[] {
  if (branchChunks.length === 0) return [...mainChunks]
  const branchPaths = new Set(branchChunks.map((c) => c.path))
  const keptMain = mainChunks.filter((c) => !branchPaths.has(c.path))
  return [...keptMain, ...branchChunks].sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/branch-retrieval.ts tests/branch-retrieval.test.ts
git commit -m "feat(sig-129): mergeBranchAware — head-wins chunk merge for branch-aware retrieval"
```

---

## Task 2: `buildBranchChunks` (reuse indexer chunker)

**Files:**
- Modify: `src/lib/branch-retrieval.ts`
- Test: `tests/branch-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { buildBranchChunks } from "../src/lib/branch-retrieval"

describe("buildBranchChunks", () => {
  it("chunks each changed file via the indexer chunker, tagging path", () => {
    const files = new Map<string, string>([
      ["src/new.ts", Array.from({ length: 40 }, (_, i) => `const x${i} = ${i}`).join("\n")],
    ])
    const chunks = buildBranchChunks(files)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((c) => c.path === "src/new.ts")).toBe(true)
    expect(chunks.every((c) => typeof c.content === "string" && c.content.length > 0)).toBe(true)
  })

  it("caps total chunks at MAX_BRANCH_CHUNKS", () => {
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")
    const files = new Map<string, string>([["src/huge.ts", big]])
    const chunks = buildBranchChunks(files)
    expect(chunks.length).toBeLessThanOrEqual(400)
  })

  it("returns [] for an empty map", () => {
    expect(buildBranchChunks(new Map())).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: FAIL — `buildBranchChunks` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/branch-retrieval.ts` (top imports + body):

```typescript
import { chunkFile, type Chunk } from "./indexer"

// Bounds the embed payload + cosine cost on large/stacked PRs. ~400
// chunks ≈ a few hundred KB of source — comfortably within one batched
// embed budget. Chunks beyond the cap are dropped (best-effort: the model
// still has the diff itself).
export const MAX_BRANCH_CHUNKS = 400

/**
 * Chunk the changed-file HEAD content with the indexer's own `chunkFile`
 * (same CHUNKER_VERSION windowing) so branch chunks are shaped exactly
 * like the indexed ones. Capped at MAX_BRANCH_CHUNKS.
 */
export function buildBranchChunks(filesByPath: ReadonlyMap<string, string>): Chunk[] {
  const out: Chunk[] = []
  for (const [path, content] of filesByPath) {
    if (out.length >= MAX_BRANCH_CHUNKS) break
    for (const c of chunkFile(path, content)) {
      out.push(c)
      if (out.length >= MAX_BRANCH_CHUNKS) break
    }
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/branch-retrieval.ts tests/branch-retrieval.test.ts
git commit -m "feat(sig-129): buildBranchChunks — reuse indexer chunker over head content"
```

---

## Task 3: cosine + `retrieveBranchChunks` (math-sensitive)

> **Algorithm/math checkpoint (CLAUDE.md routing):** this task is the numerically sensitive core. At code-review time route it to `verify-math` + `verify-algo` and DeepSeek-v4-pro sign-off (cosine correctness, normalization, tie-handling). The tests below are the floor, not the ceiling.

**Files:**
- Modify: `src/lib/branch-retrieval.ts`
- Test: `tests/branch-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { retrieveBranchChunks, type BranchVector } from "../src/lib/branch-retrieval"

function bv(path: string, a: number, b: number, vector: number[], content = "x"): BranchVector {
  return { chunk: { path, lineStart: a, lineEnd: b, content }, vector }
}

describe("retrieveBranchChunks", () => {
  it("ranks by cosine similarity to the query vector, returns RetrievedChunk[]", () => {
    const q = [1, 0, 0]
    const set: BranchVector[] = [
      bv("far.ts", 1, 2, [0, 1, 0], "FAR"),     // cosine 0
      bv("near.ts", 1, 2, [2, 0, 0], "NEAR"),   // cosine 1 (after normalize)
      bv("mid.ts", 1, 2, [1, 1, 0], "MID"),     // cosine ~0.707
    ]
    const out = retrieveBranchChunks(q, set, 3)
    expect(out.map((c) => c.path)).toEqual(["near.ts", "mid.ts", "far.ts"])
    expect(out[0].score).toBeCloseTo(1, 5)
    expect(out[1].score).toBeCloseTo(Math.SQRT1_2, 5)
    expect(out[0].content).toBe("NEAR")
  })

  it("respects topK", () => {
    const q = [1, 0]
    const set: BranchVector[] = [bv("a.ts", 1, 1, [1, 0]), bv("b.ts", 1, 1, [0.9, 0.1]), bv("c.ts", 1, 1, [0.1, 0.9])]
    expect(retrieveBranchChunks(q, set, 2)).toHaveLength(2)
  })

  it("returns [] for empty set or zero-norm query", () => {
    expect(retrieveBranchChunks([1, 0], [], 5)).toEqual([])
    expect(retrieveBranchChunks([0, 0], [bv("a.ts", 1, 1, [1, 0])], 5)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: FAIL — `retrieveBranchChunks` / `BranchVector` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/branch-retrieval.ts`:

```typescript
/** A branch chunk paired with its embedding vector (cached for the review). */
export interface BranchVector {
  chunk: { path: string; lineStart: number; lineEnd: number; content: string }
  vector: number[]
}

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a))
}

/**
 * In-memory cosine retrieval over the cached branch vectors. Scores are
 * cosine similarity in [-1, 1] — the same metric Vectorize returns
 * (wrangler.toml:44) — so callers may merge + re-rank against main-index
 * chunks directly. Returns top-K as RetrievedChunk[]. Empty when the set
 * is empty or the query has zero norm.
 */
export function retrieveBranchChunks(
  queryVector: readonly number[],
  branchVectors: readonly BranchVector[],
  topK: number,
): RetrievedChunk[] {
  if (branchVectors.length === 0) return []
  const qn = norm(queryVector)
  if (qn === 0) return []
  const scored: RetrievedChunk[] = []
  for (const bvi of branchVectors) {
    const vn = norm(bvi.vector)
    if (vn === 0) continue
    const score = dot(queryVector, bvi.vector) / (qn * vn)
    scored.push({ ...bvi.chunk, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, topK))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/branch-retrieval.ts tests/branch-retrieval.test.ts
git commit -m "feat(sig-129): retrieveBranchChunks — in-memory cosine over branch vectors"
```

---

## Task 4: gate + `prepareBranchSet` orchestrator (the one I/O path)

**Files:**
- Modify: `src/lib/branch-retrieval.ts`
- Test: `tests/branch-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { shouldRunBranchAwareRetrieval, prepareBranchSet } from "../src/lib/branch-retrieval"

describe("shouldRunBranchAwareRetrieval", () => {
  const files = new Map([["a.ts", "const x = 1"]])
  it("on only when flag is 'on' and there is changed content", () => {
    expect(shouldRunBranchAwareRetrieval("on", files)).toBe(true)
    expect(shouldRunBranchAwareRetrieval("ON", files)).toBe(true)
    expect(shouldRunBranchAwareRetrieval("off", files)).toBe(false)
    expect(shouldRunBranchAwareRetrieval(undefined, files)).toBe(false)
    expect(shouldRunBranchAwareRetrieval("on", new Map())).toBe(false)
  })
})

describe("prepareBranchSet", () => {
  const files = new Map([["a.ts", "const x = 1\nconst y = 2"]])
  it("embeds chunks and returns BranchVector[] aligned to chunks", async () => {
    const ai = {
      run: async (_m: string, input: { text: string | string[] }) => {
        const texts = Array.isArray(input.text) ? input.text : [input.text]
        return { data: texts.map(() => Array.from({ length: 768 }, () => 0.01)) }
      },
    }
    const set = await prepareBranchSet(ai, files)
    expect(set.length).toBeGreaterThan(0)
    expect(set[0].vector).toHaveLength(768)
    expect(set[0].chunk.path).toBe("a.ts")
  })

  it("returns [] (never throws) when embedding fails", async () => {
    const ai = { run: async () => { throw new Error("AI down") } }
    await expect(prepareBranchSet(ai, files)).resolves.toEqual([])
  })

  it("returns [] for empty files without calling AI", async () => {
    let called = false
    const ai = { run: async () => { called = true; return { data: [] } } }
    expect(await prepareBranchSet(ai, new Map())).toEqual([])
    expect(called).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: FAIL — `shouldRunBranchAwareRetrieval` / `prepareBranchSet` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/lib/branch-retrieval.ts`:

```typescript
import { embedTexts } from "./embeddings"

interface AiBinding {
  run(model: string, input: { text: string | string[] }): Promise<{ data?: number[][]; shape?: number[] }>
}

/** Gate: flag is "on" (case-insensitive) and there is changed JS/TS content. */
export function shouldRunBranchAwareRetrieval(
  flag: string | undefined,
  filesByPath: ReadonlyMap<string, string>,
): boolean {
  return (flag ?? "").trim().toLowerCase() === "on" && filesByPath.size > 0
}

/**
 * Build + embed the branch retrieval set ONCE per review. Best-effort:
 * any failure (embed error, empty input) yields [] so the caller silently
 * falls back to main-only retrieval. One batched `embedTexts` call.
 */
export async function prepareBranchSet(
  ai: AiBinding,
  filesByPath: ReadonlyMap<string, string>,
): Promise<BranchVector[]> {
  const chunks = buildBranchChunks(filesByPath)
  if (chunks.length === 0) return []
  try {
    const vectors = await embedTexts(ai, chunks.map((c) => c.content))
    if (vectors.length !== chunks.length) return []
    return chunks.map((chunk, i) => ({
      chunk: { path: chunk.path, lineStart: chunk.lineStart, lineEnd: chunk.lineEnd, content: chunk.content },
      vector: vectors[i],
    }))
  } catch {
    return []
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/branch-retrieval.ts tests/branch-retrieval.test.ts
git commit -m "feat(sig-129): prepareBranchSet + gate — one-shot branch embed, best-effort"
```

---

## Task 5: Env flag declaration

**Files:**
- Modify: `src/index.ts` (near `OPENCLAW_SYMBOL_RETRIEVAL?: string` at `:300`)

- [ ] **Step 1: Add the flag to the `Env` interface**

Insert directly after the `OPENCLAW_SYMBOL_RETRIEVAL?: string` line (`src/index.ts:300`):

```typescript
  // SIG-129: branch-aware retrieval. When "on", the PR-review ensemble
  // overlays the changed-file HEAD content onto the main-index retrieval
  // results (head wins on path collision) so a PR's new/changed code is
  // retrievable. Default off; flip via
  // `wrangler secret put OPENCLAW_BRANCH_AWARE_RETRIEVAL on`.
  OPENCLAW_BRANCH_AWARE_RETRIEVAL?: string
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(sig-129): add OPENCLAW_BRANCH_AWARE_RETRIEVAL env flag (default off)"
```

---

## Task 6: Wire into the ensemble (fetch gate, build once, merge 3 passes, telemetry)

**Files:**
- Modify: `src/lib/triage-pr-review-ensemble.ts`

> **Critical ordering fact (verified):** the preflight snapshot is computed at `:1289` and the perf snapshot at `:1304-1317`, but `astFilesByPath` (the changed-file head content this feature needs) is not built until `:1360`. So `branchVectors` cannot exist when preflight/perf snapshots are first computed. All three role snapshots (`retrievalSnapshot`, `perfRetrievalSnapshot`, `logicSymbolSnapshot`) are not consumed until the fanout at `:1844`. Therefore: keep the **raw chunk arrays**, leave the main-only snapshot computation in place, and **re-merge + reassign** the preflight/perf snapshot strings at a single point AFTER `branchVectors` is built (`~:1375`). The symbol merge happens in its own block (`~:1417`), which is already after `:1375`.
>
> Read `triage-pr-review-ensemble.ts:1216-1450` first to confirm current line numbers — earlier tasks don't touch this file, but always re-anchor against the live file.

- [ ] **Step 1: Add the imports**

Add to the import block alongside the symbol-retrieval import (near `:40`):

```typescript
import {
  shouldRunBranchAwareRetrieval,
  prepareBranchSet,
  retrieveBranchChunks,
  mergeBranchAware,
  type BranchVector,
} from "./branch-retrieval"
import { embedText } from "./embeddings"
```

(If `embedText` is already imported in this file, skip that line.)

Add a module-level constant near `RETRIEVAL_PREFLIGHT_TIMEOUT_MS` (`:343`):

```typescript
// SIG-129: branch chunks to consider per pass before merge dedup/re-rank.
// Matches retrieval.ts TOP_K (6) so a pass can be fully branch-sourced.
const TOP_K_BRANCH = 6
```

- [ ] **Step 2: Hoist `perfQuery` and `perfChunks`; make `retrievalSnapshot` reassignable**

These three values are created at the main-only retrieval sites but must be re-merged later, so lift them to the enclosing scope.

1. Just above `let perfRetrievalPromise: Promise<...> | null = null` (`:1242`), add:

```typescript
    let perfQuery = ""
    let perfChunks: RetrievedChunk[] | null = null
```

2. Inside `if (wantPerfRetrieval) {` (`:1244`), change `const perfQuery = buildPerfRetrievalQuery(...)` to assign the hoisted var (drop the `const`):

```typescript
      perfQuery = buildPerfRetrievalQuery(
        preflightQuery,
        extractChangedFunctionNames(diff),
      )
```

3. In the perf-resolve block (`:1305-1307`), change `const perfChunks = await perfRetrievalPromise` to assign the hoisted var:

```typescript
      if (perfRetrievalPromise) {
        perfChunks = await perfRetrievalPromise
        const formattedPerf = perfChunks ? formatChunksForPrompt(perfChunks) ?? "" : ""
```

4. Change `retrievalSnapshot` from `const` to `let` (`:1289`) — leave the main-only computation intact so flag-off behavior is byte-identical:

```typescript
    let retrievalSnapshot = preflightChunks
      ? formatChunksForPrompt(preflightChunks) ?? ""
      : ""
```

- [ ] **Step 3: Compute the gate + extend the fetch condition**

Before the `astFilesByPath` block (`:1360`), add the gate next to `wantSymbolRetrieval`:

```typescript
    const wantBranchAware =
      (env.OPENCLAW_BRANCH_AWARE_RETRIEVAL ?? "").trim().toLowerCase() === "on"
```

Change the fetch condition at `:1361` from:

```typescript
    if ((astRulesConfig.enabled || wantSymbolRetrieval) && jsTsPaths.length > 0) {
```

to:

```typescript
    if ((astRulesConfig.enabled || wantSymbolRetrieval || wantBranchAware) && jsTsPaths.length > 0) {
```

- [ ] **Step 4: Build the branch set + merge helper, then RE-MERGE preflight & perf**

Immediately after the `astFilesByPath` population loop closes (just before the SIG-121 symbol block at `~:1375`), add:

```typescript
    // SIG-129: build the branch retrieval set ONCE (best-effort), reused
    // across the preflight / perf / symbol merges. Empty set ⇒ every merge
    // is a no-op ⇒ identical to today's main-only behavior.
    let branchVectors: BranchVector[] = []
    let branchSetElapsedMs = 0
    if (shouldRunBranchAwareRetrieval(env.OPENCLAW_BRANCH_AWARE_RETRIEVAL, astFilesByPath)) {
      const startMs = Date.now()
      branchVectors = await prepareBranchSet(env.AI, astFilesByPath)
      branchSetElapsedMs = Date.now() - startMs
    }

    // Branch-aware merge for one pass: embed the pass's query (single text,
    // best-effort) and overlay branch chunks on the main chunks. Returns the
    // main chunks unchanged when branch-aware is off / the set is empty / the
    // query embed fails. Records the per-pass head-override count (paths
    // where a branch chunk displaced a main chunk) for shadow telemetry.
    const branchMergeStats = { preflight: 0, perf: 0, symbol: 0 }
    const branchAwareMerge = async (
      mainChunks: RetrievedChunk[] | null,
      queryText: string,
      pass: keyof typeof branchMergeStats,
    ): Promise<RetrievedChunk[] | null> => {
      if (branchVectors.length === 0 || !mainChunks) return mainChunks
      let qVec: number[]
      try {
        qVec = await embedText(env.AI, queryText.slice(0, 4_000))
      } catch {
        return mainChunks
      }
      const branchChunks = retrieveBranchChunks(qVec, branchVectors, TOP_K_BRANCH)
      const mainPaths = new Set(mainChunks.map((c) => c.path))
      branchMergeStats[pass] = branchChunks.filter((c) => mainPaths.has(c.path)).length
      return mergeBranchAware(mainChunks, branchChunks)
    }

    // Re-merge the SHARED preflight snapshot (seen by every specialist) and
    // the perf snapshot now that branchVectors exists. No-op when the set is
    // empty. The symbol pass merges itself in its own block below.
    if (branchVectors.length > 0) {
      const preflightMerged = await branchAwareMerge(preflightChunks, preflightQuery, "preflight")
      retrievalSnapshot = preflightMerged ? formatChunksForPrompt(preflightMerged) ?? "" : ""

      if (perfChunks) {
        const perfMerged = await branchAwareMerge(perfChunks, perfQuery, "perf")
        const formattedPerf = perfMerged ? formatChunksForPrompt(perfMerged) ?? "" : ""
        // Mirror the original resolvePerfSnapshot fallback (perf-biased view
        // wins when non-empty, else the shared snapshot).
        perfRetrievalSnapshot = resolvePerfSnapshot(formattedPerf, retrievalSnapshot)
      } else {
        // No perf chunks of its own → perf role rides the (now branch-merged)
        // shared snapshot.
        perfRetrievalSnapshot = retrievalSnapshot
      }
    }
```

> Note on `perfRetrievalSnapshot`: it is already a `let` (`:1304`) assigned `retrievalSnapshot` then conditionally `resolvePerfSnapshot(...)`. The block above reassigns it after the branch merge. Confirm `resolvePerfSnapshot` is in scope (it is — used at `:1309`).

- [ ] **Step 5: Merge into the symbol snapshot**

In the symbol block, replace `symbolChunks = r.chunks` (`~:1417`):

```typescript
          symbolChunks = await branchAwareMerge(r.chunks, symbolQuery, "symbol")
```

- [ ] **Step 6: Emit shadow telemetry**

After the symbol block completes (just before `const astResult = await runAstRules(` at `~:1446`):

```typescript
    // SIG-129 → SIG-86 bake-off signal. Flag-off ⇒ branchVectors empty ⇒
    // logs zeros and nothing changed in the snapshots.
    if (wantBranchAware) {
      console.log(JSON.stringify({
        event: "pr-review-branch-retrieval",
        owner, repo, prNumber, headSha: headSha.slice(0, 7),
        branch_chunk_count: branchVectors.length,
        embed_elapsed_ms: branchSetElapsedMs,
        head_override_preflight: branchMergeStats.preflight,
        head_override_perf: branchMergeStats.perf,
        head_override_symbol: branchMergeStats.symbol,
      }))
    }
```

- [ ] **Step 7: Type-check + full gate**

Run: `npx tsc --noEmit`
Expected: PASS. Common fixes: `perfQuery`/`perfChunks` scope (Step 2), `RetrievedChunk` already imported at `:40`.

Run: `npm run build`
Expected: PASS (tsc + eslint + full vitest).

- [ ] **Step 8: Commit**

```bash
git add src/lib/triage-pr-review-ensemble.ts
git commit -m "feat(sig-129): wire branch-aware retrieval into preflight/perf/symbol passes + shadow telemetry"
```

---

## Task 7: Acceptance-criterion test (new exported symbol is retrievable)

**Files:**
- Modify: `tests/branch-retrieval.test.ts`

- [ ] **Step 1: Write the failing test**

This exercises the full module path (build → embed → cosine → merge) with a deterministic fake embedder that returns a bag-of-words vector, proving a brand-new symbol surfaces and overrides a stale main copy of the same path.

```typescript
import { prepareBranchSet, retrieveBranchChunks, mergeBranchAware } from "../src/lib/branch-retrieval"
import { embedText } from "../src/lib/embeddings"

describe("SIG-129 acceptance: new exported symbol is retrievable + overrides stale main", () => {
  // Deterministic 768-dim bag-of-words embedder: hash each token to a slot.
  const fakeAi = {
    run: async (_m: string, input: { text: string | string[] }) => {
      const texts = Array.isArray(input.text) ? input.text : [input.text]
      const embed = (t: string): number[] => {
        const v = new Array<number>(768).fill(0)
        for (const tok of t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
          let h = 0
          for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0
          v[h % 768] += 1
        }
        return v
      }
      return { data: texts.map(embed) }
    },
  }

  it("retrieves the branch-only symbol and the merge drops the stale main chunk", async () => {
    const files = new Map<string, string>([
      ["src/util.ts", "export function computeWasteFactor(width: number) {\n  return width * 0.0144\n}\n"],
    ])
    const branchVectors = await prepareBranchSet(fakeAi, files)
    expect(branchVectors.length).toBeGreaterThan(0)

    const qVec = await embedText(fakeAi, "where is computeWasteFactor defined")
    const branchChunks = retrieveBranchChunks(qVec, branchVectors, 6)
    expect(branchChunks[0].path).toBe("src/util.ts")
    expect(branchChunks[0].content).toContain("computeWasteFactor")

    // Stale main copy of the same path must be displaced by head content.
    const staleMain = [{ path: "src/util.ts", lineStart: 1, lineEnd: 3, content: "// OLD — symbol absent", score: 0.99 }]
    const merged = mergeBranchAware(staleMain, branchChunks)
    const utilChunks = merged.filter((c) => c.path === "src/util.ts")
    expect(utilChunks.every((c) => !c.content.includes("OLD"))).toBe(true)
    expect(utilChunks.some((c) => c.content.includes("computeWasteFactor"))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run tests/branch-retrieval.test.ts`
Expected: the new test passes against the already-implemented module. If it fails, the failure is a real defect in Tasks 1–4 — fix there, do not weaken the test.

- [ ] **Step 3: Full gate**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/branch-retrieval.test.ts
git commit -m "test(sig-129): acceptance — new exported symbol retrievable, overrides stale main"
```

---

## Post-implementation (not part of TDD loop)

- **Code review:** dispatch `code-reviewer` + `typescript-pro`; route Task 3 (cosine) to `verify-math`/`verify-algo` + DeepSeek-v4-pro per CLAUDE.md algorithm-sign-off rule.
- **CodeRabbit:** run at phase end before opening the PR (`coderabbit review --plain --base $(git merge-base origin/main HEAD) HEAD`), per the per-phase preference.
- **PR:** branch `sig-129`; body uses `Closes SIG-129` and links the issue in the Development rail; move the Linear ticket to In Progress at start, In Review on PR open.
- **Rollout:** ship flag-off. Validate the FN/hallucination delta from `pr-review-branch-retrieval` telemetry via the SIG-86 aggregator before flipping `OPENCLAW_BRANCH_AWARE_RETRIEVAL on`.
- **Follow-ups (out of v1 scope):** broaden beyond JS/TS changed files; make the live agent-loop `retrieve_codebase` tool branch-aware.
