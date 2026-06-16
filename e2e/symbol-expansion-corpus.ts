// SIG-407 PR-4 — fixtures + pure scorers for the symbol-aware-retrieval eval.
//
// Each fixture is a self-contained {question, repo graph, retrieval hits, known
// target symbol(s)} scenario for the @-mention Q&A path. The eval measures
// "symbol recall@6" — does the model end up with the WHOLE target symbol in its
// context? — with the expansion flag OFF vs ON.
//
// The recall metric is production-faithful and ADDITIVE (Codex sign-off):
//   - OFF: the model sees ONLY the raw ~30-line hit slices (today's behavior). A
//     target symbol is recalled iff some hit slice FULLY contains the target's
//     [startLine,endLine] span — i.e. the model actually sees the whole symbol,
//     not a 5-line window of a 60-line function.
//   - ON: recalled iff OFF-covered OR the target symbol's id is among the
//     enclosing-symbol DEFINITION rows the graph resolves for the hits. ON keeps
//     the raw chunks (additive), so ON-coverage ⊇ OFF-coverage by construction →
//     recall can only go up, never down.
//
// The scorers below are pure (no DO, no model) and unit-tested directly; the
// eval test (`symbol-expansion-eval.test.ts`) drives the REAL RepoGraphDO over
// real SQLite to produce the ON definition-row set, so it exercises prod
// resolution (`resolveEnclosingSymbolId` + `expansionForIds`), not a re-derivation.

import type { UpsertFileGraphArgs } from "@/src/do/repo-graph"

/** A retrieval hit's coordinate (the unit the expander resolves to a symbol). */
export interface FixtureHit {
  path: string
  lineStart: number
  lineEnd: number
}

/** A symbol's declaration span, used by the OFF scorer + to seed the graph. */
export interface FixtureSymbol {
  symbolId: string
  path: string
  name: string
  kind: string
  startLine: number
  endLine: number
}

export interface SymbolExpansionFixture {
  id: string
  question: string
  /** Repo-relative source by path (committed snapshot; line count must cover spans). */
  filesByPath: Record<string, string>
  /** The repo's symbols (seed the graph; spans also drive the OFF scorer). */
  symbols: FixtureSymbol[]
  /** Same-file + cross-file call edges (for caller expansion; not scored here). */
  callEdges: Array<{ sourcePath: string; calleeName: string; callKind: string; startLine: number; startCol: number }>
  /** Import edges (for importer rows; not scored here). */
  fileEdges: Array<{
    sourcePath: string
    edgeKind: string
    specifier: string
    importedName: string | null
    localName: string | null
    exportedName: string | null
    startLine: number
    startCol: number
  }>
  /** The retrieval hits for the question (what the vector/lexical search returned). */
  hits: FixtureHit[]
  /** The symbol id(s) that actually answer the question — what we measure recall of. */
  targetSymbolIds: string[]
  /**
   * When true, this fixture has NO graph (control). The eval asserts ON == OFF —
   * the expansion must never change recall when the repo isn't graph-indexed.
   */
  noGraph?: boolean
}

// ─── Pure scorers ───────────────────────────────────────────────────

/** Top-K hits, in fixture (score) order. K defaults to TOP_K=6 (retrieval.ts). */
export const RECALL_K = 6

function topK<T>(xs: readonly T[], k: number = RECALL_K): T[] {
  return xs.slice(0, k)
}

/** A hit FULLY contains a symbol span iff same path and hit ⊇ [start,end]. */
export function hitFullyCoversSymbol(hit: FixtureHit, sym: FixtureSymbol): boolean {
  return hit.path === sym.path && hit.lineStart <= sym.startLine && hit.lineEnd >= sym.endLine
}

/**
 * OFF recall@K: fraction of target symbols a raw top-K hit slice FULLY covers
 * (the model would see the whole symbol from the slice alone). 1 when there are
 * no targets (vacuously satisfied).
 */
export function symbolRecallOff(fixture: SymbolExpansionFixture): number {
  const targets = fixture.symbols.filter((s) => fixture.targetSymbolIds.includes(s.symbolId))
  if (targets.length === 0) return 1
  const hits = topK(fixture.hits)
  const covered = targets.filter((t) => hits.some((h) => hitFullyCoversSymbol(h, t)))
  return covered.length / targets.length
}

/**
 * ON recall@K (ADDITIVE): a target is recalled iff OFF-covered (raw slice) OR its
 * id is in `expandedDefinitionIds` (the graph resolved its enclosing symbol from a
 * top-K hit). `expandedDefinitionIds` comes from the REAL DO in the eval test.
 */
export function symbolRecallOn(fixture: SymbolExpansionFixture, expandedDefinitionIds: ReadonlySet<string>): number {
  const targets = fixture.symbols.filter((s) => fixture.targetSymbolIds.includes(s.symbolId))
  if (targets.length === 0) return 1
  const hits = topK(fixture.hits)
  const covered = targets.filter(
    (t) => expandedDefinitionIds.has(t.symbolId) || hits.some((h) => hitFullyCoversSymbol(h, t)),
  )
  return covered.length / targets.length
}

/** Convert a fixture's symbols/edges into the DO upsert payloads (one per file). */
export function fixtureToUpsertArgs(
  fixture: SymbolExpansionFixture,
  runId: string,
  headSha: string,
): UpsertFileGraphArgs[] {
  const paths = new Set<string>([
    ...Object.keys(fixture.filesByPath),
    ...fixture.symbols.map((s) => s.path),
    ...fixture.callEdges.map((e) => e.sourcePath),
    ...fixture.fileEdges.map((e) => e.sourcePath),
  ])
  return [...paths].map((path) => ({
    runId,
    headSha,
    path,
    symbols: fixture.symbols
      .filter((s) => s.path === path)
      .map((s) => ({
        symbolId: s.symbolId,
        path: s.path,
        name: s.name,
        kind: s.kind,
        exported: true,
        startLine: s.startLine,
        startCol: 0,
        endLine: s.endLine,
        endCol: 1,
      })),
    fileEdgesRaw: fixture.fileEdges.filter((e) => e.sourcePath === path),
    callEdges: fixture.callEdges.filter((e) => e.sourcePath === path),
  }))
}

// ─── Fixtures ───────────────────────────────────────────────────────

function srcLines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `// ${prefix} line ${i + 1}`).join("\n")
}

export const SYMBOL_EXPANSION_FIXTURES: SymbolExpansionFixture[] = [
  {
    // The canonical small-to-big win: the hit is a 6-line slice INSIDE a 40-line
    // function. OFF the model sees only the slice (miss); ON the graph resolves
    // the enclosing function → whole body (hit).
    id: "slice-inside-large-function",
    question: "How is a refund amount validated before it is applied?",
    filesByPath: { "src/billing.ts": srcLines("billing", 60) },
    symbols: [
      {
        symbolId: "src/billing.ts function applyRefund 10 0",
        path: "src/billing.ts",
        name: "applyRefund",
        kind: "function",
        startLine: 10,
        endLine: 49,
      },
    ],
    callEdges: [],
    fileEdges: [],
    hits: [{ path: "src/billing.ts", lineStart: 22, lineEnd: 28 }],
    targetSymbolIds: ["src/billing.ts function applyRefund 10 0"],
  },
  {
    // Hit straddles a boundary — lands mostly in `parseOrder` (overlap-max), still
    // a partial slice. OFF miss (doesn't fully cover the 30-line symbol); ON hit.
    id: "hit-straddles-boundary",
    question: "Where is the order payload parsed?",
    filesByPath: { "src/orders.ts": srcLines("orders", 80) },
    symbols: [
      {
        symbolId: "src/orders.ts function parseOrder 20 0",
        path: "src/orders.ts",
        name: "parseOrder",
        kind: "function",
        startLine: 20,
        endLine: 49,
      },
      {
        symbolId: "src/orders.ts function nextThing 50 0",
        path: "src/orders.ts",
        name: "nextThing",
        kind: "function",
        startLine: 50,
        endLine: 70,
      },
    ],
    callEdges: [],
    fileEdges: [],
    // 35-49 ⊂ parseOrder (overlap 15) vs 50-52 in nextThing (overlap 3) → parseOrder wins.
    hits: [{ path: "src/orders.ts", lineStart: 35, lineEnd: 52 }],
    targetSymbolIds: ["src/orders.ts function parseOrder 20 0"],
  },
  {
    // Two hits, two distinct large symbols → both resolved ON, neither fully
    // covered OFF. Recall 0/2 → 2/2.
    id: "two-slices-two-symbols",
    question: "How do checkout and capture interact?",
    filesByPath: { "src/checkout.ts": srcLines("checkout", 120) },
    symbols: [
      {
        symbolId: "src/checkout.ts function startCheckout 10 0",
        path: "src/checkout.ts",
        name: "startCheckout",
        kind: "function",
        startLine: 10,
        endLine: 45,
      },
      {
        symbolId: "src/checkout.ts function capturePayment 60 0",
        path: "src/checkout.ts",
        name: "capturePayment",
        kind: "function",
        startLine: 60,
        endLine: 100,
      },
    ],
    callEdges: [
      {
        sourcePath: "src/checkout.ts",
        calleeName: "capturePayment",
        callKind: "same_file",
        startLine: 30,
        startCol: 2,
      },
    ],
    fileEdges: [],
    hits: [
      { path: "src/checkout.ts", lineStart: 20, lineEnd: 26 },
      { path: "src/checkout.ts", lineStart: 70, lineEnd: 78 },
    ],
    targetSymbolIds: ["src/checkout.ts function startCheckout 10 0", "src/checkout.ts function capturePayment 60 0"],
  },
  {
    // CONTROL — already-covered: the hit FULLY covers a small symbol. OFF already
    // recalls it (1/1); ON must stay 1/1 (additive — never drops it). Guards
    // against a regression where ON < OFF.
    id: "control-hit-already-covers-symbol",
    question: "What does the tiny helper do?",
    filesByPath: { "src/util.ts": srcLines("util", 20) },
    symbols: [
      {
        symbolId: "src/util.ts function clamp 5 0",
        path: "src/util.ts",
        name: "clamp",
        kind: "function",
        startLine: 5,
        endLine: 8,
      },
    ],
    callEdges: [],
    fileEdges: [],
    hits: [{ path: "src/util.ts", lineStart: 1, lineEnd: 12 }], // 1-12 ⊇ 5-8
    targetSymbolIds: ["src/util.ts function clamp 5 0"],
  },
  {
    // CONTROL — no graph: the repo isn't graph-indexed. ON must == OFF (the
    // expansion never fires, so recall is unchanged). The target is a large symbol
    // a slice doesn't cover → both OFF and ON score 0/1.
    id: "control-no-graph",
    question: "Where is the webhook signature verified?",
    filesByPath: { "src/webhook.ts": srcLines("webhook", 50) },
    symbols: [
      {
        symbolId: "src/webhook.ts function verifySignature 10 0",
        path: "src/webhook.ts",
        name: "verifySignature",
        kind: "function",
        startLine: 10,
        endLine: 40,
      },
    ],
    callEdges: [],
    fileEdges: [],
    hits: [{ path: "src/webhook.ts", lineStart: 15, lineEnd: 20 }],
    targetSymbolIds: ["src/webhook.ts function verifySignature 10 0"],
    noGraph: true,
  },
]
