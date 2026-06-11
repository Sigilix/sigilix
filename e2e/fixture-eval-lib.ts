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

/**
 * SIG-393: split a unified diff into per-file slices, keyed by the
 * new-side path. Pure string surgery — the re-sweep prototype scopes
 * its second pass to one region's diff slice.
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const out = new Map<string, string>()
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git "))
  for (const section of sections) {
    const m = /^\+\+\+ b\/(.+)$/m.exec(section)
    if (m?.[1]) out.set(m[1], section)
  }
  return out
}

/**
 * SIG-393 finer-granularity experiment: a re-sweepable region — either a
 * whole small file or a windowed slice of a large one. `newLineRange` is
 * the new-file line span the window covers (used to filter which pass-1
 * findings belong to this region's "already found" list).
 */
export interface DiffRegion {
  label: string
  path: string
  slice: string
  newLineRange: [number, number]
}

/**
 * Split one file's diff section into regions. Files at or under
 * `maxAddedLines` stay whole (last night's K=8 showed file-level works
 * for small files — all stable flips were in 40-line refunds.ts). Bigger
 * files get overlapping windows of ~`windowAdded` added lines, because a
 * 183-line file re-sweep re-saturates exactly like the original pass
 * (b4/b17/b19/b20 stayed ≤1/8).
 */
export function splitSectionIntoRegions(
  path: string,
  section: string,
  opts: { maxAddedLines?: number; windowAdded?: number; overlapAdded?: number } = {},
): DiffRegion[] {
  const maxAddedLines = opts.maxAddedLines ?? 80
  const windowAdded = opts.windowAdded ?? 55
  const overlapAdded = opts.overlapAdded ?? 8

  const lines = section.split("\n")
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"))
  if (firstHunk === -1) {
    return [{ label: path, path, slice: section, newLineRange: [1, Number.MAX_SAFE_INTEGER] }]
  }
  const header = lines.slice(0, firstHunk).join("\n")

  // Walk hunk lines tracking new-file line numbers; collect (raw, newLineNo).
  const entries: Array<{ raw: string; newLine: number | null; added: boolean }> = []
  let newLine = 0
  for (const raw of lines.slice(firstHunk)) {
    if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw)
      newLine = m?.[1] ? Number(m[1]) - 1 : newLine
      entries.push({ raw, newLine: null, added: false })
      continue
    }
    if (raw.startsWith("-")) {
      entries.push({ raw, newLine: null, added: false })
      continue
    }
    newLine += 1
    entries.push({ raw, newLine, added: raw.startsWith("+") })
  }

  const totalAdded = entries.filter((e) => e.added).length
  if (totalAdded <= maxAddedLines) {
    const span = entries.filter((e) => e.newLine !== null)
    const lo = span[0]?.newLine ?? 1
    const hi = span[span.length - 1]?.newLine ?? lo
    return [{ label: path, path, slice: section, newLineRange: [lo, hi] }]
  }

  const regions: DiffRegion[] = []
  let start = 0
  let part = 1
  while (start < entries.length) {
    let added = 0
    let end = start
    while (end < entries.length && added < windowAdded) {
      if (entries[end]!.added) added += 1
      end += 1
    }
    const window = entries.slice(start, end)
    const span = window.filter((e) => e.newLine !== null)
    const lo = span[0]?.newLine ?? 1
    const hi = span[span.length - 1]?.newLine ?? lo
    regions.push({
      label: `${path}#w${part}`,
      path,
      slice: `${header}\n@@ window ${part}: new-file lines ${lo}-${hi} @@\n${window.map((e) => e.raw).join("\n")}`,
      newLineRange: [lo, hi],
    })
    if (end >= entries.length) break
    // Step back `overlapAdded` added lines so window seams don't hide a bug.
    let back = end
    let backAdded = 0
    while (back > start + 1 && backAdded < overlapAdded) {
      back -= 1
      if (entries[back]!.added) backAdded += 1
    }
    start = back
    part += 1
  }
  return regions
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
