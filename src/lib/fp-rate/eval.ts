// SIG-114 PR 2 — ground-truth precision / FP-rate over a LABELED corpus.
//
// Where PR 1 (attribute.ts/compute.ts) gives a dismissal-based FLOOR on the
// FP rate (a lower bound — not every FP is dismissed), this computes the
// CEILING-style number: precision against hand-labeled ground truth (the
// SIG-161 corpus: findings-source.jsonl + labels-*.csv). It supports the
// claim "X% of these findings were false positives" because every finding
// has a TP/FP/borderline label.
//
// Caveats baked into the report: the labeled corpus is a FIXED snapshot
// (re-measures only when the corpus grows / is re-labeled), and a small N
// gives wide Wilson intervals. Pure (no IO); the script reads the files.

import { wilsonInterval } from "../bakeoff-report"

export type EvalLabel = "TP" | "FP" | "borderline"

/** SIG-161 stage targets (DESIGN.md): stage-1 FPR ≤ 10%, stage-2 ≤ 5%. */
export const EVAL_FP_TARGET = 0.1
/** Below this many labeled (TP+FP) findings in a group, the rate is unstable. */
export const EVAL_DEFAULT_MIN_N = 20

/** One finding from the corpus, reduced to what the eval needs. */
export interface EvalFinding {
  findingId: string
  /** Finding category (performance / testing / security / logic / tests / ...). */
  category: string
}

/** One label row (findingId -> label). */
export interface EvalLabelRow {
  findingId: string
  label: EvalLabel
}

export interface LabeledFinding {
  findingId: string
  category: string
  label: EvalLabel
}

const VALID_LABELS: ReadonlySet<string> = new Set<EvalLabel>(["TP", "FP", "borderline"])

/** Strip one layer of surrounding double-quotes + unescape `""`. Pure. */
function unquoteCsv(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"')
  return t
}

export interface ParseResult<T> {
  rows: T[]
  /** Non-blank lines that could not be parsed (surfaces silent data loss). */
  dropped: number
}

/**
 * Parse the labels CSV text -> {findingId, label}. Only the first two columns
 * are read; findingId (sha16 hex) and label (a fixed enum) never contain a
 * comma, so slicing by comma index is safe — only the unread `labelReason`
 * column may contain commas/quotes. Handles CRLF, surrounding quotes on either
 * field, and a header row anywhere among leading blanks. Pure.
 */
export function parseLabelCsv(text: string): ParseResult<EvalLabelRow> {
  const rows: EvalLabelRow[] = []
  let dropped = 0
  let headerSeen = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!headerSeen && /^"?findingid"?\s*,/i.test(line)) {
      headerSeen = true
      continue
    }
    const c1 = line.indexOf(",")
    if (c1 <= 0) {
      dropped += 1
      continue
    }
    const c2 = line.indexOf(",", c1 + 1)
    const findingId = unquoteCsv(line.slice(0, c1))
    const label = unquoteCsv(c2 === -1 ? line.slice(c1 + 1) : line.slice(c1 + 1, c2))
    if (!findingId || !VALID_LABELS.has(label)) {
      dropped += 1
      continue
    }
    rows.push({ findingId, label: label as EvalLabel })
  }
  return { rows, dropped }
}

/** Parse the findings JSONL text -> {findingId, category}. Pure. */
export function parseFindingsJsonl(text: string): ParseResult<EvalFinding> {
  const rows: EvalFinding[] = []
  let dropped = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      dropped += 1
      continue
    }
    const rec = o as Record<string, unknown>
    if (typeof rec?.findingId !== "string") {
      dropped += 1
      continue
    }
    const category = typeof rec.category === "string" && rec.category ? rec.category : "uncategorized"
    rows.push({ findingId: rec.findingId, category })
  }
  return { rows, dropped }
}

export interface JoinResult {
  labeled: LabeledFinding[]
  /** Findings in the corpus with no label row (excluded). */
  findingsWithoutLabel: number
  /** Label rows whose findingId is not in the corpus (excluded). */
  labelsWithoutFinding: number
}

/**
 * Join corpus findings to their labels by findingId. Findings without a label
 * and labels without a finding are counted (surfaced, never silently merged).
 * If a findingId is labeled twice, the first label wins. Pure.
 */
export function joinFindingsToLabels(
  findings: ReadonlyArray<EvalFinding>,
  labels: ReadonlyArray<EvalLabelRow>,
): JoinResult {
  const labelById = new Map<string, EvalLabel>()
  for (const l of labels) if (!labelById.has(l.findingId)) labelById.set(l.findingId, l.label)

  const labeled: LabeledFinding[] = []
  const findingIds = new Set<string>()
  let findingsWithoutLabel = 0
  for (const f of findings) {
    findingIds.add(f.findingId)
    const label = labelById.get(f.findingId)
    if (label === undefined) {
      findingsWithoutLabel += 1
      continue
    }
    labeled.push({ findingId: f.findingId, category: f.category, label })
  }
  // Count DISTINCT orphan findingIds (a duplicated orphan row must not double-count).
  const orphans = new Set<string>()
  for (const l of labels) if (!findingIds.has(l.findingId)) orphans.add(l.findingId)

  return { labeled, findingsWithoutLabel, labelsWithoutFinding: orphans.size }
}

export interface EvalGroupMetrics {
  group: string // "overall" or a category
  tp: number
  fp: number
  borderline: number
  /** Denominator for the rate: tp + fp (borderline excluded from the point estimate). */
  n: number
  /** fp / (tp + fp), or null when n === 0. The point-estimate FP rate. */
  fpRate: number | null
  /** tp / (tp + fp) = 1 - fpRate, or null when n === 0. */
  precision: number | null
  /** Wilson 95% CI on the FP rate (sampling uncertainty). */
  wilsonLower: number
  wilsonUpper: number
  sufficientN: boolean
  target: number
  /** Worst-case meets-target: counts borderline as potentially-FP. null if n insufficient. */
  meetsTarget: boolean | null
}

export interface EvalReport {
  groups: EvalGroupMetrics[] // overall first, then per-category
  totalLabeled: number
  findingsWithoutLabel: number
  labelsWithoutFinding: number
  minN: number
}

function groupMetrics(group: string, rows: LabeledFinding[], target: number, minN: number): EvalGroupMetrics {
  let tp = 0
  let fp = 0
  let borderline = 0
  for (const r of rows) {
    if (r.label === "TP") tp += 1
    else if (r.label === "FP") fp += 1
    else borderline += 1
  }
  const n = tp + fp
  const fpRate = n > 0 ? fp / n : null
  const precision = n > 0 ? tp / n : null
  const w = wilsonInterval(fp, n) // n=0 -> {0,1}
  const sufficientN = n >= minN
  // Worst case: borderline could each be an FP (ambiguous, like PR 1's
  // unlabeled). meets-target only if it holds even then.
  const worstDenom = tp + fp + borderline
  const worstFpRate = worstDenom > 0 ? (fp + borderline) / worstDenom : null
  const meetsTarget = sufficientN && worstFpRate !== null ? worstFpRate <= target : null
  return {
    group,
    tp,
    fp,
    borderline,
    n,
    fpRate,
    precision,
    wilsonLower: w.lower,
    wilsonUpper: w.upper,
    sufficientN,
    target,
    meetsTarget,
  }
}

export interface EvalOpts {
  minN?: number
  target?: number
}

/**
 * Compute the eval report: overall + per-category FP rate / precision with
 * Wilson CIs, over the labeled corpus. Pure.
 */
export function computeEvalReport(join: JoinResult, opts: EvalOpts = {}): EvalReport {
  const minN = opts.minN ?? EVAL_DEFAULT_MIN_N
  const target = opts.target ?? EVAL_FP_TARGET
  const { labeled } = join

  const byCategory = new Map<string, LabeledFinding[]>()
  for (const r of labeled) {
    const arr = byCategory.get(r.category) ?? []
    arr.push(r)
    byCategory.set(r.category, arr)
  }

  const groups: EvalGroupMetrics[] = [groupMetrics("overall", labeled, target, minN)]
  for (const cat of [...byCategory.keys()].sort()) {
    groups.push(groupMetrics(cat, byCategory.get(cat)!, target, minN))
  }

  return {
    groups,
    totalLabeled: labeled.length,
    findingsWithoutLabel: join.findingsWithoutLabel,
    labelsWithoutFinding: join.labelsWithoutFinding,
    minN,
  }
}

// ─── Rendering (pure) ────────────────────────────────────────────

function pct(x: number | null): string {
  return x === null ? "n/a" : (x * 100).toFixed(1) + "%"
}

function meetsCell(g: EvalGroupMetrics): string {
  if (!g.sufficientN) return "insufficient-n"
  if (g.meetsTarget === null) return "n/a"
  return g.meetsTarget ? "yes" : "NO"
}

export const EVAL_CSV_HEADER =
  "group,tp,fp,borderline,n,fp_rate,precision,wilson_lower,wilson_upper,sufficient_n,meets_target"

/** CSV: one row per group (overall + categories). Pure. */
export function formatEvalCsv(report: EvalReport): string {
  const lines = [EVAL_CSV_HEADER]
  for (const g of report.groups) {
    lines.push(
      [
        g.group.includes(",") ? `"${g.group}"` : g.group,
        g.tp,
        g.fp,
        g.borderline,
        g.n,
        g.fpRate === null ? "n/a" : (g.fpRate * 100).toFixed(1),
        g.precision === null ? "n/a" : (g.precision * 100).toFixed(1),
        (g.wilsonLower * 100).toFixed(1),
        (g.wilsonUpper * 100).toFixed(1),
        g.sufficientN ? "1" : "0",
        meetsCell(g),
      ].join(","),
    )
  }
  return lines.join("\n")
}

export interface EvalReportMeta {
  corpus: string
  generatedIso: string
}

/** Human-readable markdown with the honesty caveat. Pure. */
export function formatEvalMarkdown(report: EvalReport, meta: EvalReportMeta): string {
  const out: string[] = []
  out.push(`# Sigilix false-positive rate — labeled corpus (ground truth)`)
  out.push("")
  out.push(`Generated: ${meta.generatedIso}`)
  out.push(`Corpus: ${meta.corpus}`)
  out.push("")
  out.push(`- Labeled findings: ${report.totalLabeled}`)
  out.push(`- Corpus findings without a label: ${report.findingsWithoutLabel} (excluded)`)
  out.push(`- Labels without a corpus finding: ${report.labelsWithoutFinding} (excluded)`)
  out.push("")
  out.push("| Group | TP | FP | Borderline | FP rate | Precision | Wilson 95% | Target | Meets? |")
  out.push("|---|---:|---:|---:|---:|---:|---|---:|---|")
  for (const g of report.groups) {
    const ci = `[${pct(g.wilsonLower)}, ${pct(g.wilsonUpper)}]`
    out.push(
      `| ${g.group} | ${g.tp} | ${g.fp} | ${g.borderline} | ${pct(g.fpRate)} | ${pct(g.precision)} | ${ci} | ` +
        `<${(g.target * 100).toFixed(0)}% | ${meetsCell(g)} |`,
    )
  }
  out.push("")
  out.push("> **Ground truth, with caveats.** Unlike the dismissal-based rate (a floor),")
  out.push("> this is precision against hand labels — it supports an FP-rate claim. But it is")
  out.push("> a FIXED corpus snapshot (re-measures only when the corpus is expanded/re-labeled),")
  out.push("> the Wilson interval is sampling uncertainty (wide at small N), and `Meets?` is")
  out.push("> worst-case (borderline counted as potentially-FP). Re-run after the corpus grows")
  out.push("> with recent findings to see whether the rate is trending toward target.")
  return out.join("\n")
}
