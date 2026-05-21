# SIG-121 — Symbol-Based Retrieval for the Logic Specialist (SIG-109 PR B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the LOGIC specialist a second, symbol-derived retrieval pass so it sees local codebase context for the APIs the PR actually changed — augmenting (not replacing) the shared PR-text snapshot — with overlap telemetry, behind a flag.

**Architecture:** A new pure `symbol-retrieval.ts` extracts changed symbols via the existing acorn AST infra (`ast-rules/parser.ts` + `walker.ts`), gated/queried/merged with pure helpers. The ensemble fires a second best-effort `cachedRetrieve` for the logic role only — concurrent with preflight, timeout-capped, budget-aware, flag-gated — and emits overlap telemetry. This mirrors the SIG-110 perf-retrieval wiring (`src/lib/perf-retrieval.ts` + the perf block in `triage-pr-review-ensemble.ts`), with three differences: AST extraction (not regex), AUGMENT (not replace), and a flag gate.

**Tech Stack:** TypeScript, Cloudflare Workers, acorn/acorn-typescript/acorn-walk, vitest.

**Design sign-off:** `.claude/handoff/sig-109-design-signoff-result.md` §2 (Codex). Spec: SIG-121 Linear ACs.

**Reference implementation to mirror:** `src/lib/perf-retrieval.ts` (pure helpers) and the `wantPerfRetrieval` / `perfRetrievalPromise` / `perfRetrievalSnapshot` / `pr-review-perf-retrieval` block in `src/lib/triage-pr-review-ensemble.ts` (~lines 1216-1305). READ THESE FIRST — this plan deliberately parallels them.

---

## File Structure

- `src/lib/symbol-retrieval.ts` — NEW. Pure: AST symbol extraction (+ regex fallback), query builder, chunk-overlap telemetry computation, flag/budget gate, augment-merge.
- `src/lib/triage-pr-review-ensemble.ts` — MODIFY. Fire the flag-gated symbol retrieval concurrently with preflight; augment the logic role's snapshot; emit overlap telemetry.
- `tests/symbol-retrieval.test.ts` — NEW. Unit tests for every pure helper.

Reuse (import, do not duplicate):
- `parseSource`, `type SourceExt` from `./ast-rules/parser`
- `walkAst`, `type AstNode` from `./ast-rules/walker`
- `buildChangedLines`, `nodeOverlapsChanged`, `type ChangedLines` from `./ast-rules/diff-filter`
- `type RetrievedChunk` from `./retrieval`

---

## Task 1: `symbol-retrieval.ts` pure module

**Files:** Create `src/lib/symbol-retrieval.ts`; Test `tests/symbol-retrieval.test.ts`.

- [ ] **Step 1: Write the failing tests** — create `tests/symbol-retrieval.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
  extractChangedSymbols,
  buildSymbolRetrievalQuery,
  computeChunkOverlap,
  shouldRunSymbolRetrieval,
  mergeLogicSnapshot,
} from "../src/lib/symbol-retrieval"
import { buildChangedLines } from "../src/lib/ast-rules/diff-filter"
import type { RetrievedChunk } from "../src/lib/retrieval"

function chunk(path: string, a: number, b: number): RetrievedChunk {
  return { path, lineStart: a, lineEnd: b, content: "x", score: 0.5 }
}

describe("extractChangedSymbols", () => {
  it("extracts a function whose BODY intersects an added line (decl line unchanged)", () => {
    // file: function f spans lines 1-4; only line 3 (inside the body) is added.
    const src = "function loadOrders(ids) {\n  const a = 1\n  return batch(ids)\n}\n"
    const files = new Map([["src/a.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +3,1 @@\n+  return batch(ids)\n",
    )
    expect(extractChangedSymbols(files, changed)).toEqual(["loadOrders"])
  })
  it("extracts class + method + exported const when their range intersects added lines", () => {
    const src = [
      "export class Orders {",          // 1
      "  process(items) {",             // 2
      "    return items.map(x => x)",    // 3
      "  }",                             // 4
      "}",                               // 5
      "export const TOTAL = compute()",  // 6
    ].join("\n")
    const files = new Map([["src/o.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/o.ts b/src/o.ts\n--- a/src/o.ts\n+++ b/src/o.ts\n@@ -3,0 +3,1 @@\n+    return items.map(x => x)\n@@ -6,0 +6,1 @@\n+export const TOTAL = compute()\n",
    )
    const out = extractChangedSymbols(files, changed)
    expect(out).toContain("Orders")
    expect(out).toContain("process")
    expect(out).toContain("TOTAL")
  })
  it("ignores a symbol whose range does NOT intersect any added line", () => {
    const src = "function untouched() {\n  return 1\n}\nfunction changed() {\n  return 2\n}\n"
    const files = new Map([["src/a.ts", src]])
    // only line 5 (inside `changed`) is added
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -5,0 +5,1 @@\n+  return 2\n",
    )
    expect(extractChangedSymbols(files, changed)).toEqual(["changed"])
  })
  it("falls back to a regex over added lines when the file fails to parse", () => {
    const src = "function broken( {\n  this is not valid js\n}\n" // parse error
    const files = new Map([["src/a.ts", src]])
    const changed = buildChangedLines(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,1 @@\n+function broken( {\n",
    )
    // regex fallback still recovers the declared name from the added line
    expect(extractChangedSymbols(files, changed)).toContain("broken")
  })
  it("dedupes and caps", () => {
    const files = new Map<string, string>()
    const diffParts: string[] = []
    for (let i = 0; i < 40; i++) {
      files.set(`src/f${i}.ts`, `function fn${i}() {\n  return ${i}\n}\n`)
      diffParts.push(`diff --git a/src/f${i}.ts b/src/f${i}.ts\n--- a/src/f${i}.ts\n+++ b/src/f${i}.ts\n@@ -1,0 +1,1 @@\n+function fn${i}() {\n`)
    }
    const out = extractChangedSymbols(files, buildChangedLines(diffParts.join("")))
    expect(out.length).toBeLessThanOrEqual(30)
    expect(new Set(out).size).toBe(out.length)
  })
  it("returns empty for no files / no changed lines", () => {
    expect(extractChangedSymbols(new Map(), buildChangedLines(""))).toEqual([])
  })
})

describe("buildSymbolRetrievalQuery", () => {
  it("includes the symbols and is non-empty", () => {
    const q = buildSymbolRetrievalQuery(["loadOrders", "Orders"])
    expect(q).toContain("loadOrders")
    expect(q).toContain("Orders")
    expect(q.length).toBeGreaterThan(0)
  })
  it("returns empty string for no symbols (caller skips retrieval)", () => {
    expect(buildSymbolRetrievalQuery([])).toBe("")
  })
})

describe("computeChunkOverlap", () => {
  it("computes intersection + Jaccard over chunk ids", () => {
    const shared = [chunk("a.ts", 1, 5), chunk("b.ts", 1, 5)]
    const symbol = [chunk("b.ts", 1, 5), chunk("c.ts", 1, 5)]
    const o = computeChunkOverlap(shared, symbol)
    expect(o.sharedCount).toBe(2)
    expect(o.symbolCount).toBe(2)
    expect(o.intersectionCount).toBe(1) // b.ts:1-5
    expect(o.jaccard).toBeCloseTo(1 / 3) // |∩|=1, |∪|=3
  })
  it("jaccard is 0 when either side is empty", () => {
    expect(computeChunkOverlap([], [chunk("a.ts", 1, 2)]).jaccard).toBe(0)
    expect(computeChunkOverlap([chunk("a.ts", 1, 2)], []).jaccard).toBe(0)
  })
})

describe("shouldRunSymbolRetrieval", () => {
  it("fires only when flag on, logic in lineup, and budget > 2", () => {
    expect(shouldRunSymbolRetrieval("on", ["logic", "security"], 3)).toBe(true)
  })
  it("skips when flag is not 'on'", () => {
    expect(shouldRunSymbolRetrieval("off", ["logic"], 3)).toBe(false)
    expect(shouldRunSymbolRetrieval(undefined, ["logic"], 3)).toBe(false)
  })
  it("skips when logic not in lineup or budget too low", () => {
    expect(shouldRunSymbolRetrieval("on", ["security"], 3)).toBe(false)
    expect(shouldRunSymbolRetrieval("on", ["logic"], 2)).toBe(false)
  })
})

describe("mergeLogicSnapshot", () => {
  it("AUGMENTS: shared first, then symbol block (both present)", () => {
    const out = mergeLogicSnapshot("SHARED", "SYMBOL")
    expect(out.indexOf("SHARED")).toBeLessThan(out.indexOf("SYMBOL"))
  })
  it("returns shared alone when symbol snapshot empty", () => {
    expect(mergeLogicSnapshot("SHARED", "")).toBe("SHARED")
  })
  it("returns symbol alone when shared empty", () => {
    expect(mergeLogicSnapshot("", "SYMBOL")).toBe("SYMBOL")
  })
})
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx vitest run tests/symbol-retrieval.test.ts`
Expected: FAIL (module doesn't exist).

- [ ] **Step 3: Implement `src/lib/symbol-retrieval.ts`**

First READ `src/lib/perf-retrieval.ts` (the structural template), `src/lib/ast-rules/parser.ts` (`parseSource`, `SourceExt`), `src/lib/ast-rules/walker.ts` (`walkAst`, `AstNode`), and `src/lib/ast-rules/diff-filter.ts` (`buildChangedLines`, `nodeOverlapsChanged`, `ChangedLines`). Then:

```ts
// SIG-121 (SIG-109 PR B): symbol-based retrieval for the logic specialist.
//
// The generic preflight retrieval embeds PR title+body — chunks matched on
// what the PR DESCRIBES. The logic specialist instead wants local codebase
// context for the SYMBOLS the PR changed: the functions/methods/classes/
// exported consts whose body intersects an added line (even when the
// declaration line itself didn't change). We extract those via the existing
// acorn AST infra and embed them as a second, AUGMENTING retrieval query.
//
// Pure module: no I/O. AST extraction with a regex fallback on parse failure
// (per Codex sign-off §2). Single Vectorize namespace → the bias is via query
// terms, not a separate index.

import { parseSource, type SourceExt } from "./ast-rules/parser"
import { walkAst, type AstNode } from "./ast-rules/walker"
import { nodeOverlapsChanged, type ChangedLines } from "./ast-rules/diff-filter"
import type { RetrievedChunk } from "./retrieval"

const MAX_SYMBOLS = 30
const KNOWN_EXTS: ReadonlySet<string> = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
])

function extOf(path: string): SourceExt | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  return KNOWN_EXTS.has(ext) ? (ext as SourceExt) : null
}

/** Best-effort regex fallback: declared names on the file's ADDED lines.
 *  Used only when AST parse fails. */
function regexFallbackSymbols(src: string, addedLines: Set<number>): string[] {
  const out: string[] = []
  const lines = src.split("\n")
  const re = /\b(?:function|class)\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/
  for (const ln of addedLines) {
    const line = lines[ln - 1]
    if (typeof line !== "string") continue
    const m = re.exec(line)
    const name = m?.[1] ?? m?.[2]
    if (name) out.push(name)
  }
  return out
}

/**
 * Extract the names of functions / methods / classes / exported consts whose
 * source range intersects an added line, across all changed JS/TS files.
 * AST-based; regex fallback per file on parse failure. Deduped (insertion
 * order), capped at MAX_SYMBOLS. Never throws.
 */
export function extractChangedSymbols(
  filesByPath: ReadonlyMap<string, string>,
  changed: ChangedLines,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (name: unknown): void => {
    if (typeof name !== "string" || name.length === 0) return
    if (seen.has(name)) return
    seen.add(name)
    out.push(name)
  }
  for (const [path, src] of filesByPath) {
    if (out.length >= MAX_SYMBOLS) break
    const set = changed.get(path)
    if (!set || set.size === 0) continue
    const ext = extOf(path)
    if (ext === null) continue
    const parsed = parseSource(src, ext)
    if (!parsed.ok) {
      for (const n of regexFallbackSymbols(src, set)) push(n)
      continue
    }
    const overlaps = (node: AstNode): boolean => {
      const s = node?.loc?.start?.line
      const e = node?.loc?.end?.line
      if (typeof s !== "number" || typeof e !== "number") return false
      return nodeOverlapsChanged(changed, path, s, e)
    }
    walkAst(parsed.ast as AstNode, {
      FunctionDeclaration: (n) => { if (overlaps(n)) push(n?.id?.name) },
      ClassDeclaration: (n) => { if (overlaps(n)) push(n?.id?.name) },
      MethodDefinition: (n) => {
        if (!overlaps(n)) return
        // `key.name` for identifier keys; `key.value` for string-literal keys.
        push(n?.key?.name ?? (typeof n?.key?.value === "string" ? n.key.value : undefined))
      },
      ExportNamedDeclaration: (n) => {
        const decl = n?.declaration
        if (!decl || decl.type !== "VariableDeclaration") return
        for (const d of decl.declarations ?? []) {
          if (overlaps(d) && d?.id?.type === "Identifier") push(d.id.name)
        }
      },
    })
  }
  return out.slice(0, MAX_SYMBOLS)
}

/**
 * Build the logic specialist's symbol-retrieval query. Empty string when
 * there are no symbols (caller skips the retrieval entirely).
 */
export function buildSymbolRetrievalQuery(symbols: readonly string[]): string {
  if (symbols.length === 0) return ""
  return `Logic review — local definitions and call sites for the changed symbols: ${symbols.join(", ")}.`
}

/** Stable chunk identity for overlap measurement. */
function chunkId(c: RetrievedChunk): string {
  return `${c.path}:${c.lineStart}-${c.lineEnd}`
}

export interface ChunkOverlap {
  sharedCount: number
  symbolCount: number
  intersectionCount: number
  /** |shared ∩ symbol| / |shared ∪ symbol|; 0 when either side empty. */
  jaccard: number
}

/** Compute overlap telemetry between the shared and symbol chunk sets. */
export function computeChunkOverlap(
  shared: readonly RetrievedChunk[],
  symbol: readonly RetrievedChunk[],
): ChunkOverlap {
  const sharedIds = new Set(shared.map(chunkId))
  const symbolIds = new Set(symbol.map(chunkId))
  let intersection = 0
  for (const id of symbolIds) if (sharedIds.has(id)) intersection += 1
  const union = sharedIds.size + symbolIds.size - intersection
  return {
    sharedCount: sharedIds.size,
    symbolCount: symbolIds.size,
    intersectionCount: intersection,
    jaccard: union === 0 ? 0 : intersection / union,
  }
}

/**
 * Gate: run symbol retrieval only when the env flag is "on", the logic
 * specialist is in the lineup, and the retrieve budget leaves room for
 * preflight + symbol + the synth conflict-verification reserve
 * (`budgetRemaining > 2` ⇒ maxCalls >= 3 default). Mirrors
 * `shouldRunPerfRetrieval` plus the flag.
 */
export function shouldRunSymbolRetrieval(
  flag: string | undefined,
  specialists: readonly string[],
  budgetRemaining: number,
): boolean {
  return (flag ?? "").trim().toLowerCase() === "on" &&
    specialists.includes("logic") &&
    budgetRemaining > 2
}

/**
 * AUGMENT the logic role's snapshot: shared preflight snapshot first, then
 * the symbol-derived block (do NOT replace — per Codex sign-off §2). Either
 * side may be empty.
 */
export function mergeLogicSnapshot(sharedSnapshot: string, symbolSnapshot: string): string {
  if (symbolSnapshot.length === 0) return sharedSnapshot
  if (sharedSnapshot.length === 0) return symbolSnapshot
  return `${sharedSnapshot}\n\n[LOGIC SYMBOL CONTEXT — local code for changed symbols]\n${symbolSnapshot}`
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run tests/symbol-retrieval.test.ts`
Expected: PASS. If a test reveals an acorn node-shape assumption is wrong (e.g. `MethodDefinition.key`), inspect the actual node via a scratch parse and adjust the accessor — keep the test as the contract.

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` (clean), then:
```bash
git add src/lib/symbol-retrieval.ts tests/symbol-retrieval.test.ts
git commit -m "feat(sig-121): symbol-retrieval pure module (AST extraction + query + overlap + gate + augment)"
```

---

## Task 2: ensemble wiring + overlap telemetry

**Files:** Modify `src/lib/triage-pr-review-ensemble.ts`.

Mirror the SIG-110 perf-retrieval block. READ the existing `wantPerfRetrieval` / `perfRetrievalPromise` / `perfRetrievalSnapshot` / `pr-review-perf-retrieval` code (~lines 1216-1305) and the `messageForRole` per-role snapshot selection (~line where `selectRetrievalSnapshotForRole` is called) first — you are adding a parallel logic path.

- [ ] **Step 1: Imports** — add to the ensemble's imports:
```ts
import {
  extractChangedSymbols,
  buildSymbolRetrievalQuery,
  computeChunkOverlap,
  shouldRunSymbolRetrieval,
  mergeLogicSnapshot,
} from "./symbol-retrieval"
import { buildChangedLines } from "./ast-rules/diff-filter"
```
(`buildChangedLines` may already be imported via `ast-rules` — check and avoid a duplicate.)

- [ ] **Step 2: Fire the symbol retrieval concurrently with preflight** — directly after the `perfRetrievalPromise` kickoff block, add a parallel logic block. `astFilesByPath` is built later (~line 1339) than the preflight (~1216); to keep this concurrent with preflight WITHOUT reordering the AST fetch, derive symbols from the diff using a lightweight parse of the already-available `diff` + the changed-file sources. **Decision:** the symbol retrieval needs file SOURCES (for AST), which only exist after `astFilesByPath` is built. So do NOT fire it at preflight time; instead fire it right after `astFilesByPath` is populated (still well before the specialist fanout), as its own best-effort `cachedRetrieve`. This keeps AST extraction accurate. It is no longer concurrent with preflight, but it shares the retrieve budget and is timeout-capped + non-fatal, and runs during the pre-fanout window. Implement:

```ts
// SIG-121: symbol-based retrieval for the LOGIC specialist (flag-gated,
// best-effort). Fires after astFilesByPath is built (needs file sources for
// AST symbol extraction), before the specialist fanout. Budget-aware,
// timeout-capped, non-fatal; AUGMENTS the logic role's snapshot.
let logicSymbolSnapshot = ""
let symbolOverlap: ReturnType<typeof computeChunkOverlap> | null = null
let symbolRetrievalElapsedMs = 0
let symbolQueryCount = 0
let symbolInjected = false
if (shouldRunSymbolRetrieval(env.OPENCLAW_SYMBOL_RETRIEVAL, router.specialists, preflightCache.budgetRemaining())) {
  const changedLines = buildChangedLines(diff)
  const symbols = extractChangedSymbols(astFilesByPath, changedLines)
  symbolQueryCount = symbols.length
  const symbolQuery = buildSymbolRetrievalQuery(symbols)
  if (symbolQuery.length > 0) {
    const startMs = Date.now()
    let symbolChunks: RetrievedChunk[] | null = null
    try {
      const r = await withComposedTimeout(
        () => preflightCache.cachedRetrieve({
          caller: "specialist:logic-symbol",
          query: symbolQuery,
          namespace,
          fetcher: () => retrieveChunks({ text: symbolQuery, teamKey: namespace, env }),
        }),
        RETRIEVAL_PREFLIGHT_TIMEOUT_MS,
        orchCtrl.signal,
      )
      symbolChunks = r.chunks
    } catch (err) {
      if (orchCtrl.signal.aborted) throw err
      symbolChunks = null
    }
    symbolRetrievalElapsedMs = Date.now() - startMs
    const formatted = symbolChunks ? formatChunksForPrompt(symbolChunks) ?? "" : ""
    if (formatted.length > 0) {
      logicSymbolSnapshot = formatted
      symbolInjected = true
    }
    symbolOverlap = computeChunkOverlap(preflightChunks ?? [], symbolChunks ?? [])
  }
  console.log(JSON.stringify({
    event: "pr-review-symbol-retrieval",
    owner, repo, prNumber, headSha: headSha.slice(0, 7),
    query_symbol_count: symbolQueryCount,
    injected: symbolInjected,
    elapsed_ms: symbolRetrievalElapsedMs,
    budget_remaining: preflightCache.budgetRemaining(),
    shared_chunks: symbolOverlap?.sharedCount ?? 0,
    symbol_chunks: symbolOverlap?.symbolCount ?? 0,
    intersection: symbolOverlap?.intersectionCount ?? 0,
    jaccard: symbolOverlap?.jaccard ?? 0,
  }))
}
```
NOTE: `preflightChunks` is the variable holding the shared snapshot chunks (declared near the preflight). Confirm its exact name and that it's in scope here. If it was reassigned/narrowed, capture the chunk array used to build `retrievalSnapshot` into a stable local you can reference.

- [ ] **Step 3: Augment the logic role's snapshot in `messageForRole`** — where the per-role snapshot is chosen (the `selectRetrievalSnapshotForRole(role, perfRetrievalSnapshot, retrievalSnapshot)` call), extend so the logic role augments. Replace that call's usage with:
```ts
        retrievalSnapshot:
          role === "performance"
            ? selectRetrievalSnapshotForRole(role, perfRetrievalSnapshot, retrievalSnapshot)
            : role === "logic"
              ? mergeLogicSnapshot(retrievalSnapshot, logicSymbolSnapshot)
              : retrievalSnapshot,
```
(Keep `selectRetrievalSnapshotForRole` for performance; logic uses `mergeLogicSnapshot`.) Ensure `logicSymbolSnapshot` is declared in a scope visible to `messageForRole` (it is, if declared in the same function body before `messageForRole`).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: tsc clean; full build green (tsc + eslint + all vitest).

- [ ] **Step 5: Commit**

```bash
git add src/lib/triage-pr-review-ensemble.ts
git commit -m "feat(sig-121): wire flag-gated symbol retrieval for logic role + overlap telemetry"
```

---

## Final verification

- [ ] `npm run build` green.
- [ ] Confirm default behavior unchanged when `OPENCLAW_SYMBOL_RETRIEVAL` unset (flag off → no symbol retrieval, logic gets the shared snapshot only).
- [ ] code-reviewer (per-task + final); Codex retry; CodeRabbit phase-end before PR.
- [ ] PR vs `main`, `Closes SIG-121` (SIG-109's last coding AC).

## Spec coverage (SIG-121 ACs)

- AST extraction (Function/Method/Class/exported-const, body∩added) + regex fallback → Task 1 `extractChangedSymbols`.
- Symbol query / materially-different chunks → Task 1 `buildSymbolRetrievalQuery` + Task 2 wiring; difference measured by `computeChunkOverlap` telemetry.
- AUGMENT not replace → Task 1 `mergeLogicSnapshot` + Task 2 Step 3.
- Second cachedRetrieve flag-gated/best-effort/timeout-capped/budget-aware/non-fatal → Task 2 Step 2 + `shouldRunSymbolRetrieval`.
- Logic role only → Task 2 Step 3.
- Overlap telemetry (shared/symbol ids, intersection, jaccard, query symbol count, injected, elapsedMs, budget) → `pr-review-symbol-retrieval` event.
- 20-PR bake-off → deferred (SIG-86), telemetry surface ready.
