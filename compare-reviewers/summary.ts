// SIG-70 — aggregate labeled comparison files into the decision report.
//
// Pure: input is the parsed `ComparisonFile[]` (every `data/*.json`); output
// is a tally object + a markdown rendering. The numbers answer the issue's
// question directly — what would dropping CodeRabbit cost (unique real bugs)
// and save (CodeRabbit-only noise), and how do the two bots' precisions
// compare. `cli.ts` reads the files and writes the markdown.

import {
  CATEGORIES,
  CR_LABELS,
  LABELS,
  REAL_LABELS,
  SIGILIX_LABELS,
  type Category,
  type ComparisonFile,
  type Label,
} from "./types"

export interface SummaryReport {
  filesCollected: number
  filesLabeled: number
  totalItems: number
  byLabel: Record<Label, number>
  byCategory: Record<Category, { total: number; real: number }>
  /** Per-bot: how many issues it flagged, how many were real, precision. */
  sigilix: BotStats
  coderabbit: BotStats
  /** Issues both bots flagged (`both_real` + `both_noise`). */
  overlap: number
  /** Real bugs only CodeRabbit caught — the cost of dropping it. */
  crUniqueRealBugs: number
  /** Real bugs only Sigilix caught. */
  sigilixUniqueRealBugs: number
  /** CodeRabbit-only noise — the friction dropping it would remove. */
  crOnlyNoise: number
  sigilixOnlyNoise: number
}

export interface BotStats {
  flagged: number
  real: number
  noise: number
  /** real / flagged, or null when the bot flagged nothing. */
  precision: number | null
}

function emptyByLabel(): Record<Label, number> {
  const out = {} as Record<Label, number>
  for (const l of LABELS) out[l] = 0
  return out
}

function emptyByCategory(): Record<Category, { total: number; real: number }> {
  const out = {} as Record<Category, { total: number; real: number }>
  for (const c of CATEGORIES) out[c] = { total: 0, real: 0 }
  return out
}

function botStats(byLabel: Record<Label, number>, labels: readonly Label[]): BotStats {
  let flagged = 0
  let real = 0
  for (const l of labels) {
    flagged += byLabel[l]
    if ((REAL_LABELS as readonly string[]).includes(l)) real += byLabel[l]
  }
  return {
    flagged,
    real,
    noise: flagged - real,
    precision: flagged === 0 ? null : real / flagged,
  }
}

export function summarize(files: ComparisonFile[]): SummaryReport {
  const byLabel = emptyByLabel()
  const byCategory = emptyByCategory()
  let totalItems = 0
  let filesLabeled = 0

  for (const file of files) {
    if (file.items.length > 0) filesLabeled += 1
    for (const item of file.items) {
      totalItems += 1
      byLabel[item.label] += 1
      const cat = byCategory[item.category]
      cat.total += 1
      if ((REAL_LABELS as readonly string[]).includes(item.label)) cat.real += 1
    }
  }

  return {
    filesCollected: files.length,
    filesLabeled,
    totalItems,
    byLabel,
    byCategory,
    sigilix: botStats(byLabel, SIGILIX_LABELS),
    coderabbit: botStats(byLabel, CR_LABELS),
    overlap: byLabel.both_real + byLabel.both_noise,
    crUniqueRealBugs: byLabel.cr_only_real_bug,
    sigilixUniqueRealBugs: byLabel.sigilix_only_real_bug,
    crOnlyNoise: byLabel.cr_only_noise,
    sigilixOnlyNoise: byLabel.sigilix_only_noise,
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "—"
  return `${((n / d) * 100).toFixed(1)}%`
}

function precisionCell(s: BotStats): string {
  return s.precision === null ? "—" : `${(s.precision * 100).toFixed(1)}%`
}

/** Render the summary as a committable markdown report. */
export function formatSummaryMarkdown(
  report: SummaryReport,
  opts: { generatedIso: string },
): string {
  const r = report
  const l = r.byLabel
  const lines: string[] = []

  lines.push("# Sigilix vs CodeRabbit — head-to-head comparison")
  lines.push("")
  lines.push(`_Generated ${opts.generatedIso} · ${r.filesCollected} PR(s) collected, ${r.filesLabeled} labeled · ${r.totalItems} labeled issues._`)
  lines.push("")

  lines.push("## Label matrix")
  lines.push("")
  lines.push("| label | count | % of issues |")
  lines.push("|-------|------:|------------:|")
  for (const label of LABELS) {
    lines.push(`| ${label} | ${l[label]} | ${pct(l[label], r.totalItems)} |`)
  }
  lines.push(`| **total** | **${r.totalItems}** | |`)
  lines.push("")

  lines.push("## Per-bot precision")
  lines.push("")
  lines.push("Precision = real bugs ÷ everything the bot flagged.")
  lines.push("")
  lines.push("| bot | flagged | real | noise | precision |")
  lines.push("|-----|--------:|-----:|------:|----------:|")
  lines.push(`| Sigilix | ${r.sigilix.flagged} | ${r.sigilix.real} | ${r.sigilix.noise} | ${precisionCell(r.sigilix)} |`)
  lines.push(`| CodeRabbit | ${r.coderabbit.flagged} | ${r.coderabbit.real} | ${r.coderabbit.noise} | ${precisionCell(r.coderabbit)} |`)
  lines.push("")
  lines.push(`Overlap (both bots flagged the same issue): **${r.overlap}** (${pct(r.overlap, r.totalItems)} of issues).`)
  lines.push("")

  lines.push("## Decision support")
  lines.push("")
  lines.push("What dropping CodeRabbit would cost vs. save:")
  lines.push("")
  lines.push(`- **Cost** — real bugs only CodeRabbit caught: **${r.crUniqueRealBugs}**`)
  lines.push(`- **Save** — CodeRabbit-only noise comments removed: **${r.crOnlyNoise}**`)
  lines.push(`- For reference, real bugs only Sigilix caught: ${r.sigilixUniqueRealBugs}; Sigilix-only noise: ${r.sigilixOnlyNoise}`)
  lines.push("")

  lines.push("## By category")
  lines.push("")
  lines.push("| category | issues | real bugs | real-bug rate |")
  lines.push("|----------|-------:|----------:|--------------:|")
  for (const cat of CATEGORIES) {
    const c = r.byCategory[cat]
    lines.push(`| ${cat} | ${c.total} | ${c.real} | ${pct(c.real, c.total)} |`)
  }
  lines.push("")

  return lines.join("\n")
}
