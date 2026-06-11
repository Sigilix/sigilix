// SIG-397 — pure fixture scorer.
//
// Maps each posted finding to at most one ground-truth row via the encoded
// equivalence rules, then tallies recall / precision / high-severity false
// positives. Ambiguity (a finding matching more than one row) is a hard
// error, not a tie-break: the rules must be tightened until every frozen
// finding maps deterministically, and the calibration test in
// `evals.test.ts` enforces that against the committed snapshots.
//
// No IO here — `cli.ts` loads the fixture JSON and findings.

import type {
  EquivalenceRule,
  FixtureFinding,
  FixtureGroundTruth,
  FixtureScore,
  FindingVerdict,
  GroundTruthBug,
  MatcherClause,
  ScoredFinding,
  SubsetRecall,
  Tier,
} from "./fixture-types"
import { TIERS } from "./fixture-types"
import type { Tool } from "./types"

const DEFAULT_LINE_SLACK = 5

function clauseMatches(clause: MatcherClause, paths: string[], finding: FixtureFinding): boolean {
  if (finding.path === null || !paths.includes(finding.path)) return false
  const text = (clause.scope === "excerpt" ? finding.excerpt : `${finding.excerpt}\n${finding.bodyText}`).toLowerCase()
  if (clause.allKeywords.length === 0) {
    throw new Error("equivalence clause has empty allKeywords — line proximity alone is not a valid matcher")
  }
  if (!clause.allKeywords.every((k) => text.includes(k.toLowerCase()))) return false
  if (clause.notKeywords?.some((k) => text.includes(k.toLowerCase()))) return false
  if (clause.botCategories && !clause.botCategories.includes(finding.botCategory ?? "")) return false
  if (clause.lineRanges && clause.lineRanges.length > 0) {
    if (finding.line === null) return false
    const slack = clause.lineSlack ?? DEFAULT_LINE_SLACK
    const line = finding.line
    if (!clause.lineRanges.some(([lo, hi]) => line >= lo - slack && line <= hi + slack)) return false
  }
  return true
}

function ruleMatches(rule: EquivalenceRule, paths: string[], finding: FixtureFinding): boolean {
  if (rule.anyOf.length === 0) {
    throw new Error("equivalence rule has empty anyOf — the row would be silently uncatchable, corrupting recall")
  }
  return rule.anyOf.some((clause) => clauseMatches(clause, paths, finding))
}

/**
 * Classify one finding against the ground truth. Out-of-scope rules are
 * checked first (they are deliberate carve-outs), then bugs and traps
 * together — a finding matching two bug rows, two traps, or a bug AND a
 * trap is ambiguous and throws.
 */
export function classifyFinding(truth: FixtureGroundTruth, finding: FixtureFinding): FindingVerdict {
  // Out-of-scope rules have no own paths — reuse the finding's path as the
  // path set so they apply diff-wide unless the rule narrows by keyword.
  // DELIBERATE precedence: an out-of-scope hit wins outright and skips the
  // ambiguity check, so these rules must stay narrow (botCategories-gated) —
  // a loose rule here would silently absorb a real catch instead of throwing.
  for (const rule of truth.outOfScope) {
    if (finding.path !== null && ruleMatches(rule.match, [finding.path], finding)) {
      return { kind: "out_of_scope", id: rule.id }
    }
  }
  const bugHits = truth.bugs.filter((b) => ruleMatches(b.match, b.paths, finding))
  const trapHits = truth.traps.filter((t) => ruleMatches(t.match, t.paths, finding))
  const hits = [...bugHits.map((b) => b.id), ...trapHits.map((t) => t.id)]
  if (hits.length > 1) {
    throw new Error(
      `ambiguous equivalence: finding ${finding.ref} (${finding.path ?? "?"}:${String(finding.line)}) ` +
        `matches ${hits.join(", ")} — tighten the rules (notKeywords) until it maps to one row`,
    )
  }
  if (bugHits.length === 1) return { kind: "bug", id: bugHits[0]!.id }
  if (trapHits.length === 1) return { kind: "trap", id: trapHits[0]!.id }
  return { kind: "unmatched" }
}

function subsetRecall(rows: GroundTruthBug[], caughtIds: Set<string>): SubsetRecall {
  const caught = rows.filter((r) => caughtIds.has(r.id))
  const missed = rows.filter((r) => !caughtIds.has(r.id))
  return {
    caught: caught.length,
    total: rows.length,
    recall: rows.length === 0 ? null : caught.length / rows.length,
    caughtIds: caught.map((r) => r.id),
    missedIds: missed.map((r) => r.id),
  }
}

function isHighSeverity(severity: GroundTruthBug["severity"]): boolean {
  return severity === "P0" || severity === "P1"
}

/** Score one tool's findings against a fixture's frozen ground truth. */
export function scoreFixture(truth: FixtureGroundTruth, tool: Tool, findings: FixtureFinding[]): FixtureScore {
  const scored: ScoredFinding[] = findings.map((f) => ({
    ref: f.ref,
    path: f.path,
    line: f.line,
    excerpt: f.excerpt,
    severity: f.severity,
    verdict: classifyFinding(truth, f),
  }))

  const caughtIds = new Set(scored.flatMap((s) => (s.verdict.kind === "bug" ? [s.verdict.id] : [])))
  const trapFlags = scored.filter((s) => s.verdict.kind === "trap")
  const unmatched = scored.filter((s) => s.verdict.kind === "unmatched")
  const outOfScope = scored.filter((s) => s.verdict.kind === "out_of_scope")
  const realCatches = scored.filter((s) => s.verdict.kind === "bug")

  // Precision over bug-claims only: out-of-scope findings sit outside both
  // sides; every trap flag and every unmatched (hallucination-candidate)
  // finding counts against it.
  const precisionNumerator = realCatches.length
  const precisionDenominator = realCatches.length + trapFlags.length + unmatched.length
  const highSevFalsePositives = [...trapFlags, ...unmatched].filter((s) => s.severity === "P0" || s.severity === "P1")

  const byTier = Object.fromEntries(
    TIERS.map((tier) => [
      tier,
      subsetRecall(
        truth.bugs.filter((b) => b.tier === tier),
        caughtIds,
      ),
    ]),
  ) as Record<Tier, SubsetRecall>

  return {
    fixture: truth.fixture,
    tool,
    overall: subsetRecall(truth.bugs, caughtIds),
    highSeverity: subsetRecall(
      truth.bugs.filter((b) => isHighSeverity(b.severity)),
      caughtIds,
    ),
    byTier,
    precision: precisionDenominator === 0 ? null : precisionNumerator / precisionDenominator,
    precisionNumerator,
    precisionDenominator,
    highSevFalsePositives,
    trapFlags,
    unmatched,
    outOfScope,
    findings: scored,
  }
}

// ─── reporting ────────────────────────────────────────────────────

function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`
}

function recallCell(r: SubsetRecall): string {
  return `${r.caught}/${r.total} (${pct(r.recall)})`
}

/** Render one score as the markdown block lever PRs paste. */
export function formatScoreMarkdown(score: FixtureScore): string {
  const lines: string[] = []
  lines.push(`### ${score.fixture} — ${score.tool}`)
  lines.push("")
  lines.push("| Metric | Value |")
  lines.push("| --- | --- |")
  lines.push(`| Recall (all rows) | ${recallCell(score.overall)} |`)
  lines.push(`| Recall (P0/P1) | ${recallCell(score.highSeverity)} |`)
  for (const tier of TIERS) {
    const r = score.byTier[tier]
    if (r.total > 0) lines.push(`| Recall (${tier}) | ${recallCell(r)} |`)
  }
  lines.push(`| Precision | ${pct(score.precision)} (${score.precisionNumerator}/${score.precisionDenominator}) |`)
  lines.push(`| High-sev false positives | ${score.highSevFalsePositives.length} |`)
  lines.push(`| Out-of-scope findings | ${score.outOfScope.length} |`)
  lines.push("")
  lines.push(`Missed: ${score.overall.missedIds.join(", ") || "(none)"}`)
  if (score.trapFlags.length > 0) {
    lines.push(
      `Trap flags: ${score.trapFlags.map((t) => `${t.ref}→${t.verdict.kind === "trap" ? t.verdict.id : "?"}`).join(", ")}`,
    )
  }
  if (score.unmatched.length > 0) {
    lines.push(`Unmatched (audit these): ${score.unmatched.map((u) => u.ref).join(", ")}`)
  }
  return lines.join("\n")
}

/** Δ block comparing a lever run against the frozen baseline. */
export function formatDeltaMarkdown(baseline: FixtureScore, current: FixtureScore, label: string): string {
  if (baseline.fixture !== current.fixture || baseline.tool !== current.tool) {
    throw new Error(
      `delta requires matching scores: baseline is ${baseline.fixture}/${baseline.tool}, ` +
        `current is ${current.fixture}/${current.tool}`,
    )
  }
  const d = (a: number | null, b: number | null): string =>
    a === null || b === null ? "—" : `${b - a >= 0 ? "+" : ""}${((b - a) * 100).toFixed(1)}pp`
  const lines: string[] = []
  lines.push(`### Δ vs baseline — ${label}`)
  lines.push("")
  lines.push("| Metric | Baseline | Current | Δ |")
  lines.push("| --- | --- | --- | --- |")
  lines.push(
    `| Recall (all) | ${recallCell(baseline.overall)} | ${recallCell(current.overall)} | ${d(baseline.overall.recall, current.overall.recall)} |`,
  )
  lines.push(
    `| Recall (P0/P1) | ${recallCell(baseline.highSeverity)} | ${recallCell(current.highSeverity)} | ${d(baseline.highSeverity.recall, current.highSeverity.recall)} |`,
  )
  const bu = baseline.byTier.UNGODLY
  const cu = current.byTier.UNGODLY
  if (bu.total > 0 || cu.total > 0) {
    lines.push(`| Recall (UNGODLY) | ${recallCell(bu)} | ${recallCell(cu)} | ${d(bu.recall, cu.recall)} |`)
  }
  lines.push(
    `| Precision | ${pct(baseline.precision)} | ${pct(current.precision)} | ${d(baseline.precision, current.precision)} |`,
  )
  lines.push(
    `| High-sev FPs | ${baseline.highSevFalsePositives.length} | ${current.highSevFalsePositives.length} | ${current.highSevFalsePositives.length - baseline.highSevFalsePositives.length} |`,
  )
  return lines.join("\n")
}
