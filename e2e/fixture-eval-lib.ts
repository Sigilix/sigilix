// SIG-398 — pure library half of the local fixture eval driver.
//
// Everything here is IO-light and unit-testable offline: fixture loading,
// per-repeat score folding, the stability table, and the report renderer.
// The live half (`fixture-eval.live.test.ts`) owns the model calls.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { FixtureGroundTruth, FixtureScore } from "@/evals/fixture-types"
import { buildLocalBaseline, type LocalBaseline } from "@/evals/local-adapter"

export const FIXTURES_DIR = join(process.cwd(), "evals", "fixtures")

export interface LoadedFixture {
  name: string
  truth: FixtureGroundTruth
  diff: string
  /** The PR title the bots actually saw — faithful prompt input, and it
   *  names no specific bug (the don't-coach rule from logic-recall-eval). */
  prTitle: string
}

const FIXTURE_PR_TITLES: Record<string, string> = {
  "fullstack-pr20-dense": "feat: payments & refunds — charges, refunds, balances, provider webhook",
  "fullstack-low-density": "Add GitHub webhook receiver",
}

export function loadFixture(name: string): LoadedFixture {
  const dir = join(FIXTURES_DIR, name)
  const truth = JSON.parse(readFileSync(join(dir, "ground-truth.json"), "utf8")) as FixtureGroundTruth
  let diff: string
  try {
    diff = readFileSync(join(dir, "pr.diff"), "utf8")
  } catch {
    throw new Error(`fixture ${name} has no pr.diff — freeze the diff before running the local eval`)
  }
  return { name, truth, diff, prTitle: FIXTURE_PR_TITLES[name] ?? `Review fixture ${name}` }
}

// ─── per-run folding + report ─────────────────────────────────────

export interface RepeatOutcome {
  repeat: number
  score: FixtureScore
  /** Roles whose shadow run failed to produce a verdict this repeat —
   *  the repeat still scores (union of the roles that DID run) but the
   *  report flags it: a missing role deflates recall and must not be
   *  read as a model miss. */
  erroredRoles: string[]
  elapsedMs: number
}

export function foldRuns(args: {
  fixture: string
  repeats: number
  generatedAt: string
  outcomes: readonly RepeatOutcome[]
}): LocalBaseline {
  return buildLocalBaseline({
    fixture: args.fixture,
    repeats: args.repeats,
    generatedAt: args.generatedAt,
    runs: args.outcomes.map((o) => ({
      caughtIds: o.score.overall.caughtIds,
      recall: o.score.overall.recall,
      precision: o.score.precision,
      highSevFpCount: o.score.highSevFalsePositives.length,
    })),
  })
}

const CONTEXT_GAP_BANNER =
  "context: minimal (diff only — no retrieval / graph / AST evidence blocks). " +
  "Union of independently-run specialists, NO synth — the union upper bound. " +
  "Compare against the LOCAL minimal-context baseline, never the prod posted-review numbers."

export function formatLocalEvalReport(args: {
  fixture: string
  truth: FixtureGroundTruth
  outcomes: readonly RepeatOutcome[]
  baseline: LocalBaseline
}): string {
  const { outcomes, baseline, truth } = args
  const lines: string[] = []
  lines.push(`## local fixture eval — ${args.fixture} (K=${outcomes.length})`)
  lines.push("")
  lines.push(`> ${CONTEXT_GAP_BANNER}`)
  lines.push("")
  lines.push("| repeat | recall | precision | high-sev FP | errored roles | elapsed |")
  lines.push("| --- | --- | --- | --- | --- | --- |")
  for (const o of outcomes) {
    const r = o.score.overall
    const pct = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(1)}%`)
    lines.push(
      `| ${o.repeat} | ${r.caught}/${r.total} (${pct(r.recall)}) | ${pct(o.score.precision)} | ` +
        `${o.score.highSevFalsePositives.length} | ${o.erroredRoles.join(", ") || "—"} | ${Math.round(o.elapsedMs / 1000)}s |`,
    )
  }
  lines.push("")
  lines.push("### per-row stability (caught k/K — 0/K and K/K are signal, mid-band is noise)")
  lines.push("")
  lines.push("| row | tier | sev | caught | title |")
  lines.push("| --- | --- | --- | --- | --- |")
  for (const bug of truth.bugs) {
    const k = baseline.perRow[bug.id] ?? 0
    const marker = k === outcomes.length ? "✓" : k === 0 ? "✗" : "~"
    lines.push(`| ${bug.id} ${marker} | ${bug.tier} | ${bug.severity} | ${k}/${outcomes.length} | ${bug.title} |`)
  }
  return lines.join("\n")
}
