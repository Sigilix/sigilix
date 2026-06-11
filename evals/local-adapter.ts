// SIG-398 — pure adapter: local shadow-specialist output → scorer input.
//
// The e2e fixture-eval driver runs specialists via `runShadowSpecialist`
// and feeds their `rawFindings` here so `scorer.ts` can score a local run
// exactly like a posted review. Pure data mapping — no IO, no engine
// imports (the driver passes the raw shapes in).

import type { FixtureFinding, Severity } from "@/evals/fixture-types"

/** The slice of `ShadowRunResult.rawFindings` the adapter consumes. */
export interface LocalRawFinding {
  path: string
  line: number
  score: number
  category: string
  headline: string
  body: string
}

/**
 * Numeric specialist score → P-label. Mirrors the engine renderer
 * (`finding-format.ts`: 5→P0, 4→P1, 3→P2, 1-2→P3) and `sigilixSeverity`
 * in `normalize.ts` — same scale the posted-review path parses back out
 * of the severity marker, so local and posted scoring agree.
 */
export function severityForScore(score: number): Severity | null {
  if (score === 5) return "P0"
  if (score === 4) return "P1"
  if (score === 3) return "P2"
  if (score === 2 || score === 1) return "P3"
  return null
}

/**
 * Map one specialist run's findings into the scorer's shape.
 *
 * - `excerpt` = the bare headline. The posted-review excerpt is the full
 *   rendered first line (location prefix + headline + score suffix) — a
 *   SUPERSET of this, so substring-based `scope:"excerpt"` clauses match
 *   identically; the two are not byte-identical.
 * - `bodyText` = headline + body (full-scope clauses).
 * - `botCategory` = the raw category verbatim, so the dense fixture's
 *   botCategories-gated `outOfScope` carve-out (testing coverage)
 *   behaves identically to posted-review scoring.
 * - `ref`s are per-run (`logic-1`, …), not stable across runs — scoring
 *   is per-run, so stability is not required (unlike comment-id refs).
 */
export function shadowFindingsToFixtureFindings(
  role: string,
  rawFindings: readonly LocalRawFinding[],
): FixtureFinding[] {
  return rawFindings.map((f, i) => ({
    ref: `${role}-${i + 1}`,
    tool: "sigilix" as const,
    commentId: i + 1,
    path: f.path,
    line: f.line,
    excerpt: f.headline,
    bodyText: f.body.length > 0 ? `${f.headline}\n${f.body}` : f.headline,
    severity: severityForScore(f.score),
    url: "local",
    botCategory: f.category,
  }))
}

/**
 * Union of several roles' findings for one repeat — Phase A's scoring
 * input (no synth locally yet, so this is the union UPPER BOUND on what
 * a synth pass could keep; reports must label it as such).
 */
export function unionFixtureFindings(perRole: ReadonlyArray<readonly FixtureFinding[]>): FixtureFinding[] {
  return perRole.flat()
}

// ─── committed local baseline ────────────────────────────────────

/**
 * The committed pre-lever reference for SIG-392 lever A/B runs. Lever
 * comparisons are read ROW-BY-ROW (flips vs `perRow`), not by means —
 * the K-ruler discipline: a 0/K→K/K flip is signal, mid swings are noise.
 */
export interface LocalBaseline {
  schemaVersion: 1
  fixture: string
  /** What context the engine ran with. "minimal" = diff only — no
   *  retrieval / graph / AST evidence blocks. Local scores compare
   *  against a local baseline with the SAME context label, never
   *  against posted-review (prod-context) numbers. */
  context: "minimal"
  repeats: number
  /** rowId → number of repeats in which the row was caught. */
  perRow: Record<string, number>
  aggregate: {
    /** Mean over runs with a non-null recall. NOTE: a dead repeat (all
     *  roles errored → empty union) scores 0/N, not null, and drags this
     *  down — the per-row table + the driver's errored-roles column are
     *  the trustworthy artifacts; means are a courtesy summary. */
    recallMean: number
    precisionMean: number
    highSevFpTotal: number
  }
  generatedAt: string
}

/** Fold K per-repeat scores into the committed baseline shape. */
export function buildLocalBaseline(args: {
  fixture: string
  repeats: number
  generatedAt: string
  runs: ReadonlyArray<{
    caughtIds: readonly string[]
    recall: number | null
    precision: number | null
    highSevFpCount: number
  }>
}): LocalBaseline {
  const perRow: Record<string, number> = {}
  let recallSum = 0
  let recallN = 0
  let precisionSum = 0
  let precisionN = 0
  let highSevFpTotal = 0
  for (const run of args.runs) {
    for (const id of run.caughtIds) perRow[id] = (perRow[id] ?? 0) + 1
    if (run.recall !== null) {
      recallSum += run.recall
      recallN += 1
    }
    if (run.precision !== null) {
      precisionSum += run.precision
      precisionN += 1
    }
    highSevFpTotal += run.highSevFpCount
  }
  return {
    schemaVersion: 1,
    fixture: args.fixture,
    context: "minimal",
    repeats: args.repeats,
    perRow,
    aggregate: {
      recallMean: recallN === 0 ? 0 : recallSum / recallN,
      precisionMean: precisionN === 0 ? 0 : precisionSum / precisionN,
      highSevFpTotal,
    },
    generatedAt: args.generatedAt,
  }
}

/**
 * Per-row stability vs a baseline: which rows flipped. `flippedUp` =
 * never caught in baseline, caught in ≥ threshold of current runs (the
 * lever's win); `flippedDown` = the regression to investigate.
 */
export function rowFlips(args: {
  baseline: LocalBaseline
  current: { repeats: number; perRow: Record<string, number> }
  /** Fraction of repeats (0..1] a row must hit to count as "caught". Default 0.75. */
  threshold?: number
}): { flippedUp: string[]; flippedDown: string[] } {
  const threshold = args.threshold ?? 0.75
  const caughtIn = (perRow: Record<string, number>, repeats: number, id: string): boolean =>
    (perRow[id] ?? 0) / repeats >= threshold
  const allIds = new Set([...Object.keys(args.baseline.perRow), ...Object.keys(args.current.perRow)])
  const flippedUp: string[] = []
  const flippedDown: string[] = []
  for (const id of allIds) {
    const before = caughtIn(args.baseline.perRow, args.baseline.repeats, id)
    const after = caughtIn(args.current.perRow, args.current.repeats, id)
    if (!before && after) flippedUp.push(id)
    if (before && !after) flippedDown.push(id)
  }
  return { flippedUp: flippedUp.sort(), flippedDown: flippedDown.sort() }
}
