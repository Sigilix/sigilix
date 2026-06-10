// SIG-70/SIG-326 — aggregate labeled comparison files into the decision report.
//
// Pure: input is the parsed `ComparisonFile[]` (every `data/*.json`); output
// is a tally object + a markdown rendering. The numbers answer the issue's
// question directly — per-tool precision/recall, overlap, unique catches, and
// noise by category. `cli.ts` reads the files and writes the markdown.

import {
  CATEGORIES,
  type Category,
  type ComparisonFile,
  type Outcome,
  OUTCOMES,
  type Tool,
  TOOLS,
  toolDisplayName,
} from "./types"

export interface SummaryReport {
  filesCollected: number
  filesLabeled: number
  totalItems: number
  byOutcome: Record<Outcome, number>
  byCategory: Record<Category, { total: number; real: number }>
  byTool: Record<Tool, ToolStats>
  /** Raw inline finding count per tool across collected PRs. */
  commentVolume: Record<Tool, number>
  /** Ground-truth real bugs across labeled rows. */
  totalRealBugs: number
  /** Real bugs no compared tool flagged. */
  missedByAllRealBugs: number
  /** Combination matrix keyed by joined tool ids, or `missed_by_all`. */
  byCombination: Record<string, { real: number; noise: number }>
  pairOverlap: Record<`${Tool}+${Tool}`, number>
}

export interface ToolStats {
  flagged: number
  real: number
  noise: number
  /** real / flagged, or null when the bot flagged nothing. */
  precision: number | null
  /** real bugs this tool caught / all ground-truth real bugs. */
  recall: number | null
  uniqueRealBugs: number
  onlyNoise: number
}

function emptyByOutcome(): Record<Outcome, number> {
  const out = {} as Record<Outcome, number>
  for (const o of OUTCOMES) out[o] = 0
  return out
}

function emptyByCategory(): Record<Category, { total: number; real: number }> {
  const out = {} as Record<Category, { total: number; real: number }>
  for (const c of CATEGORIES) out[c] = { total: 0, real: 0 }
  return out
}

function emptyToolStats(): Record<Tool, ToolStats> {
  const out = {} as Record<Tool, ToolStats>
  for (const tool of TOOLS) {
    out[tool] = {
      flagged: 0,
      real: 0,
      noise: 0,
      precision: null,
      recall: null,
      uniqueRealBugs: 0,
      onlyNoise: 0,
    }
  }
  return out
}

function emptyCommentVolume(): Record<Tool, number> {
  const out = {} as Record<Tool, number>
  for (const tool of TOOLS) out[tool] = 0
  return out
}

function emptyPairOverlap(): Record<`${Tool}+${Tool}`, number> {
  return {
    "sigilix+coderabbit": 0,
    "sigilix+greptile": 0,
    "coderabbit+greptile": 0,
    // The template-literal type permits every ordering; keep only canonical
    // rows in the renderer.
  } as Record<`${Tool}+${Tool}`, number>
}

function combinationKey(tools: ReadonlySet<Tool>): string {
  if (tools.size === 0) return "missed_by_all"
  return TOOLS.filter((tool) => tools.has(tool)).join("+")
}

export function summarize(files: ComparisonFile[]): SummaryReport {
  const byOutcome = emptyByOutcome()
  const byCategory = emptyByCategory()
  const byTool = emptyToolStats()
  const commentVolume = emptyCommentVolume()
  const byCombination: Record<string, { real: number; noise: number }> = {}
  const pairOverlap = emptyPairOverlap()
  let totalItems = 0
  let filesLabeled = 0
  let totalRealBugs = 0
  let missedByAllRealBugs = 0

  for (const file of files) {
    if (file.items.length > 0) filesLabeled += 1
    const refTool = new Map<string, Tool>()
    for (const tool of TOOLS) {
      commentVolume[tool] += file.findings[tool].length
      for (const f of file.findings[tool]) refTool.set(f.ref, tool)
    }

    for (const item of file.items) {
      totalItems += 1
      byOutcome[item.outcome] += 1
      const cat = byCategory[item.category]
      cat.total += 1
      if (item.outcome === "real_bug") {
        cat.real += 1
        totalRealBugs += 1
      }

      const tools = new Set<Tool>()
      for (const ref of item.findings) {
        const tool = refTool.get(ref)
        if (tool) tools.add(tool)
      }
      const key = combinationKey(tools)
      byCombination[key] ??= { real: 0, noise: 0 }
      byCombination[key][item.outcome === "real_bug" ? "real" : "noise"] += 1
      if (item.outcome === "real_bug" && tools.size === 0) missedByAllRealBugs += 1

      for (const tool of TOOLS) {
        if (!tools.has(tool)) continue
        const stats = byTool[tool]
        stats.flagged += 1
        if (item.outcome === "real_bug") stats.real += 1
        else stats.noise += 1
      }
      for (let i = 0; i < TOOLS.length; i++) {
        for (let j = i + 1; j < TOOLS.length; j++) {
          const a = TOOLS[i]!
          const b = TOOLS[j]!
          if (tools.has(a) && tools.has(b)) pairOverlap[`${a}+${b}`] += 1
        }
      }
      if (tools.size === 1) {
        const onlyTool = [...tools][0]!
        if (item.outcome === "real_bug") byTool[onlyTool].uniqueRealBugs += 1
        else byTool[onlyTool].onlyNoise += 1
      }
    }
  }

  for (const tool of TOOLS) {
    const stats = byTool[tool]
    stats.precision = stats.flagged === 0 ? null : stats.real / stats.flagged
    stats.recall = totalRealBugs === 0 ? null : stats.real / totalRealBugs
  }

  return {
    filesCollected: files.length,
    filesLabeled,
    totalItems,
    byOutcome,
    byCategory,
    byTool,
    commentVolume,
    totalRealBugs,
    missedByAllRealBugs,
    byCombination,
    pairOverlap,
  }
}

function pct(n: number, d: number): string {
  if (d === 0) return "—"
  return `${((n / d) * 100).toFixed(1)}%`
}

function ratioCell(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toFixed(1)}%`
}

function precisionCell(s: ToolStats): string {
  return s.precision === null ? "—" : `${(s.precision * 100).toFixed(1)}%`
}

/** Render the summary as a committable markdown report. */
export function formatSummaryMarkdown(
  report: SummaryReport,
  opts: { generatedIso: string },
): string {
  const r = report
  const l = r.byOutcome
  const lines: string[] = []

  lines.push("# Reviewer head-to-head comparison")
  lines.push("")
  lines.push(`_Generated ${opts.generatedIso} · ${r.filesCollected} PR(s) collected, ${r.filesLabeled} labeled · ${r.totalItems} labeled issues._`)
  lines.push("")

  lines.push("## Outcome Matrix")
  lines.push("")
  lines.push("| outcome | count | % of issues |")
  lines.push("|---------|------:|------------:|")
  for (const outcome of OUTCOMES) {
    lines.push(`| ${outcome} | ${l[outcome]} | ${pct(l[outcome], r.totalItems)} |`)
  }
  lines.push(`| **total** | **${r.totalItems}** | |`)
  lines.push("")

  lines.push("## Per-Tool Precision And Recall")
  lines.push("")
  lines.push("Precision = real bugs flagged ÷ everything the tool flagged. Recall = real bugs flagged ÷ all ground-truth real bugs.")
  lines.push("")
  lines.push("| tool | comments | flagged issues | real | noise | precision | recall | unique real | only noise |")
  lines.push("|------|---------:|---------------:|-----:|------:|----------:|-------:|------------:|-----------:|")
  for (const tool of TOOLS) {
    const s = r.byTool[tool]
    lines.push(`| ${toolDisplayName(tool)} | ${r.commentVolume[tool]} | ${s.flagged} | ${s.real} | ${s.noise} | ${precisionCell(s)} | ${ratioCell(s.recall)} | ${s.uniqueRealBugs} | ${s.onlyNoise} |`)
  }
  lines.push("")
  const zeroCommentTools = TOOLS.filter((tool) => r.commentVolume[tool] === 0)
  if (zeroCommentTools.length > 0) {
    lines.push(
      `Coverage note: ${zeroCommentTools.map(toolDisplayName).join(", ")} had zero collected comments. ` +
        "Treat recall for those tools as not interpretable until you verify they actually reviewed the sampled PRs.",
    )
    lines.push("")
  }
  lines.push(`Ground-truth real bugs: **${r.totalRealBugs}**; missed by all compared tools: **${r.missedByAllRealBugs}**.`)
  lines.push("")

  lines.push("## Overlap")
  lines.push("")
  lines.push("| combination | real | noise | total |")
  lines.push("|-------------|-----:|------:|------:|")
  const combinationKeys = Object.keys(r.byCombination).sort((a, b) => a.localeCompare(b))
  for (const key of combinationKeys) {
    const row = r.byCombination[key]!
    lines.push(`| ${key} | ${row.real} | ${row.noise} | ${row.real + row.noise} |`)
  }
  lines.push("")
  lines.push("Pairwise overlap counts include all-three rows.")
  lines.push("")
  lines.push("| pair | shared issues |")
  lines.push("|------|--------------:|")
  for (const [pair, count] of Object.entries(r.pairOverlap)) {
    lines.push(`| ${pair} | ${count} |`)
  }
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
