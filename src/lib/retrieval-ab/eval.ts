// SIG-45 — A/B evaluation core: pure-vector vs hybrid (vector + BM25/RRF)
// retrieval, scored on review findings quality against hand-graded ground
// truth.
//
// This is the measurement the SIG-45 ticket's last two "Done when" items
// require: run ~30 PRs through review TWICE (OPENCLAW_RETRIEVAL_HYBRID off
// then on), record each arm's findings, hand-label the real findings per PR,
// then compute precision / recall / F1 per arm and decide: ship hybrid as the
// default only if it lifts F1 by >10% (relative). Otherwise it stays behind
// the flag.
//
// Pure + offline (no IO, no network) — the CLI (scripts/retrieval-ab-report.ts)
// reads the recorded arm findings + the ground-truth labels and calls in here,
// mirroring fp-rate/eval.ts. Reproducible: same inputs → same report.
//
// Matching model (standard IR eval): an arm finding is a true positive when it
// lands on a ground-truth item for the SAME pr, the SAME file, within
// `lineTolerance` lines, and (when both carry a category) the same category.
// Each ground-truth item is claimed by at most one finding and each finding
// claims at most one truth item — a maximum bipartite matching, so TP is the
// largest possible set of valid pairings and is INDEPENDENT of the input row
// order (a greedy first-claim pass would let JSONL ordering change the score).
// Unmatched findings are false positives; unmatched ground-truth items are
// false negatives.

import { wilsonInterval } from "@/src/lib/bakeoff-report"

export type Arm = "vector" | "hybrid"

/** Lines within this distance count as the same finding location. */
export const DEFAULT_LINE_TOLERANCE = 3
/** Relative F1 lift (hybrid over vector) required to ship hybrid as default. */
export const SHIP_F1_RELATIVE_LIFT = 0.1
/** The ticket calls for ~30 PRs; below this the result is underpowered. */
export const AB_DEFAULT_MIN_PRS = 30

/** A hand-graded real finding that SHOULD be surfaced for a PR. */
export interface GroundTruthItem {
  pr: string
  file: string
  line: number
  /** Optional finding category (security / logic / performance / tests / …). */
  category?: string
}

/** A finding a review actually produced under one retrieval arm. */
export interface ArmFinding {
  pr: string
  arm: Arm
  file: string
  line: number
  category?: string
}

export interface ParseResult<T> {
  rows: T[]
  /** Non-blank lines that failed to parse — surfaces silent data loss. */
  dropped: number
}

export interface ArmMetrics {
  arm: Arm
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
  /** Wilson 95% interval on precision (successes=tp, total=tp+fp). */
  precisionCI: { lower: number; upper: number }
  /** Wilson 95% interval on recall (successes=tp, total=tp+fn). */
  recallCI: { lower: number; upper: number }
}

export interface AbDecision {
  shipHybrid: boolean
  vectorF1: number
  hybridF1: number
  f1Delta: number
  /** (hybridF1 - vectorF1) / vectorF1; null when vectorF1 is 0. */
  relativeLift: number | null
  underpowered: boolean
  reason: string
}

export interface AbReport {
  prCount: number
  vector: ArmMetrics
  hybrid: ArmMetrics
  decision: AbDecision
}

export interface AbOptions {
  lineTolerance?: number
  minPrs?: number
}

// ---------------------------------------------------------------------
// Parsing (JSONL)
// ---------------------------------------------------------------------

function parseJsonlLines<T>(text: string, pick: (o: Record<string, unknown>) => T | null): ParseResult<T> {
  const rows: T[] = []
  let dropped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      dropped += 1
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      dropped += 1
      continue
    }
    const row = pick(parsed as Record<string, unknown>)
    if (row === null) {
      dropped += 1
      continue
    }
    rows.push(row)
  }
  return { rows, dropped }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
// Line numbers are 1-based integers. Reject fractional / non-positive values
// outright rather than truncating them — `Math.trunc(10.9) === 10` would
// silently relocate a malformed row onto a real line and forge a match.
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null

export function parseGroundTruthJsonl(text: string): ParseResult<GroundTruthItem> {
  return parseJsonlLines<GroundTruthItem>(text, (o) => {
    const pr = str(o.pr)
    const file = str(o.file)
    const line = int(o.line)
    if (pr === null || file === null || line === null) return null
    const category = str(o.category)
    return category !== null ? { pr, file, line, category } : { pr, file, line }
  })
}

export function parseArmFindingsJsonl(text: string): ParseResult<ArmFinding> {
  return parseJsonlLines<ArmFinding>(text, (o) => {
    const pr = str(o.pr)
    const file = str(o.file)
    const line = int(o.line)
    const armRaw = str(o.arm)
    if (pr === null || file === null || line === null) return null
    if (armRaw !== "vector" && armRaw !== "hybrid") return null
    const category = str(o.category)
    return category !== null
      ? { pr, arm: armRaw, file, line, category }
      : { pr, arm: armRaw, file, line }
  })
}

// ---------------------------------------------------------------------
// Matching + per-arm metrics
// ---------------------------------------------------------------------

function categoriesCompatible(a?: string, b?: string): boolean {
  // Only enforce a category match when BOTH sides declare one — ground truth
  // without categories falls back to file+line matching.
  if (a === undefined || b === undefined) return true
  return a.toLowerCase() === b.toLowerCase()
}

interface Tally {
  tp: number
  fp: number
  fn: number
}

/**
 * Match one arm's findings to ground truth as a MAXIMUM bipartite matching.
 * Each truth item is claimed by at most one finding and each finding claims at
 * most one truth item; an edge is eligible when the pair shares pr + file, is
 * within `lineTolerance`, and has compatible categories. TP is the size of the
 * maximum matching — which is unique, so the result does NOT depend on the
 * order of `findings`/`truth` (a greedy first-claim pass did, corrupting the
 * precision/recall the harness exists to measure). Pure.
 *
 * Per-finding edges are sorted nearest-line-first so that when several maximum
 * matchings exist the augmenting search prefers the closest pairing; this is
 * cosmetic (TP is order-invariant regardless) but keeps WHICH pairs match
 * stable and intuitive. Inputs are per-PR-arm small, so the O(V·E) augmenting
 * algorithm is comfortably fast.
 */
export function tallyArm(
  findings: ReadonlyArray<ArmFinding>,
  truth: ReadonlyArray<GroundTruthItem>,
  lineTolerance: number,
): Tally {
  // Eligible truth indices per finding, nearest-line first (deterministic).
  const adjacency: number[][] = findings.map((f) => {
    const edges: Array<{ idx: number; dist: number }> = []
    for (let i = 0; i < truth.length; i++) {
      const t = truth[i]!
      if (t.pr !== f.pr || t.file !== f.file) continue
      if (!categoriesCompatible(f.category, t.category)) continue
      const dist = Math.abs(t.line - f.line)
      if (dist <= lineTolerance) edges.push({ idx: i, dist })
    }
    edges.sort((a, b) => a.dist - b.dist || a.idx - b.idx)
    return edges.map((e) => e.idx)
  })

  // Kuhn's algorithm: augmenting paths → maximum matching. `truthMatch[t]` is
  // the finding index currently claiming truth item `t`, or -1.
  const truthMatch = new Array<number>(truth.length).fill(-1)
  const augment = (findingIdx: number, visited: boolean[]): boolean => {
    for (const t of adjacency[findingIdx]!) {
      if (visited[t]) continue
      visited[t] = true
      if (truthMatch[t] === -1 || augment(truthMatch[t]!, visited)) {
        truthMatch[t] = findingIdx
        return true
      }
    }
    return false
  }

  let tp = 0
  for (let f = 0; f < findings.length; f++) {
    if (augment(f, new Array<boolean>(truth.length).fill(false))) tp += 1
  }
  return { tp, fp: findings.length - tp, fn: truth.length - tp }
}

function metricsFromTally(arm: Arm, t: Tally): ArmMetrics {
  const precision = t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp)
  const recall = t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn)
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    arm,
    tp: t.tp,
    fp: t.fp,
    fn: t.fn,
    precision,
    recall,
    f1,
    precisionCI: wilsonInterval(t.tp, t.tp + t.fp),
    recallCI: wilsonInterval(t.tp, t.tp + t.fn),
  }
}

// ---------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------

export function computeAbReport(
  findings: ReadonlyArray<ArmFinding>,
  truth: ReadonlyArray<GroundTruthItem>,
  opts: AbOptions = {},
): AbReport {
  const lineTolerance = opts.lineTolerance ?? DEFAULT_LINE_TOLERANCE
  const minPrs = opts.minPrs ?? AB_DEFAULT_MIN_PRS

  const vectorFindings = findings.filter((f) => f.arm === "vector")
  const hybridFindings = findings.filter((f) => f.arm === "hybrid")
  const vector = metricsFromTally("vector", tallyArm(vectorFindings, truth, lineTolerance))
  const hybrid = metricsFromTally("hybrid", tallyArm(hybridFindings, truth, lineTolerance))

  // PR universe = every PR seen across truth + both arms (so a PR with zero
  // findings in one arm still counts toward N).
  const prSet = new Set<string>()
  for (const t of truth) prSet.add(t.pr)
  for (const f of findings) prSet.add(f.pr)
  const prCount = prSet.size

  const f1Delta = hybrid.f1 - vector.f1
  const relativeLift = vector.f1 === 0 ? null : f1Delta / vector.f1
  const underpowered = prCount < minPrs
  // Ship only on a real, sufficiently-powered >10% relative lift. A lift from
  // a zero vector baseline (relativeLift null) ships only if hybrid F1 is
  // actually positive — degenerate, but don't divide by zero.
  const meetsBar =
    relativeLift === null ? hybrid.f1 > 0 && vector.f1 === 0 : relativeLift >= SHIP_F1_RELATIVE_LIFT
  const shipHybrid = meetsBar && !underpowered

  const reason = underpowered
    ? `underpowered: ${prCount} PRs < ${minPrs} required — collect more before deciding`
    : shipHybrid
      ? `hybrid F1 ${(hybrid.f1).toFixed(3)} vs vector ${(vector.f1).toFixed(3)} = ${relativeLift === null ? "∞" : (relativeLift * 100).toFixed(1) + "%"} relative lift ≥ ${(SHIP_F1_RELATIVE_LIFT * 100).toFixed(0)}% → ship hybrid as default`
      : `hybrid F1 ${(hybrid.f1).toFixed(3)} vs vector ${(vector.f1).toFixed(3)} = ${relativeLift === null ? "n/a" : (relativeLift * 100).toFixed(1) + "%"} relative lift < ${(SHIP_F1_RELATIVE_LIFT * 100).toFixed(0)}% → keep behind the OPENCLAW_RETRIEVAL_HYBRID flag`

  return { prCount, vector, hybrid, decision: { shipHybrid, vectorF1: vector.f1, hybridF1: hybrid.f1, f1Delta, relativeLift, underpowered, reason } }
}

// ---------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

export function formatAbMarkdown(r: AbReport): string {
  const row = (m: ArmMetrics): string =>
    `| ${m.arm} | ${m.tp} | ${m.fp} | ${m.fn} | ${pct(m.precision)} | ${pct(m.recall)} | ${m.f1.toFixed(3)} | ${pct(m.precisionCI.lower)}–${pct(m.precisionCI.upper)} | ${pct(m.recallCI.lower)}–${pct(m.recallCI.upper)} |`
  return [
    `# SIG-45 retrieval A/B — pure-vector vs hybrid`,
    ``,
    `PRs evaluated: **${r.prCount}**${r.decision.underpowered ? ` ⚠️ (< ${AB_DEFAULT_MIN_PRS})` : ""}`,
    ``,
    `| arm | TP | FP | FN | precision | recall | F1 | precision 95% CI | recall 95% CI |`,
    `|-----|----|----|----|-----------|--------|----|------------------|---------------|`,
    row(r.vector),
    row(r.hybrid),
    ``,
    `**Decision: ${r.decision.shipHybrid ? "SHIP hybrid as default" : "KEEP behind flag"}**`,
    ``,
    r.decision.reason,
  ].join("\n")
}

export function formatAbCsv(r: AbReport): string {
  const header = "arm,tp,fp,fn,precision,recall,f1,precision_ci_lower,precision_ci_upper,recall_ci_lower,recall_ci_upper"
  const row = (m: ArmMetrics): string =>
    [m.arm, m.tp, m.fp, m.fn, m.precision.toFixed(4), m.recall.toFixed(4), m.f1.toFixed(4), m.precisionCI.lower.toFixed(4), m.precisionCI.upper.toFixed(4), m.recallCI.lower.toFixed(4), m.recallCI.upper.toFixed(4)].join(",")
  return [header, row(r.vector), row(r.hybrid)].join("\n")
}
