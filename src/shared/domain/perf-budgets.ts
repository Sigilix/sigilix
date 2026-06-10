// SIG-110 PR B — zero-LLM perf-budgets hot-path check.
//
// Runs in the ensemble's pre-fanout deterministic pipeline alongside
// secret scan, dep-vuln, AST rules, SARIF, docs-coverage, and regex
// deterministic checks. Mirrors `docs-coverage-check.ts`:
//
//   1. If `hotPaths` is empty, no-op (operator hasn't opted in).
//   2. Otherwise, find the PR's changed files matching any `hotPaths`
//      glob.
//   3. Emit a hit when at least one changed file lands on a declared
//      hot path. The hit lists the touched hot-path files, the globs
//      that matched, and the operator's declared latency / bundle
//      budgets (echoed for context).
//
// `hotPaths` are PATH GLOBS (same `compileGlob` semantics as
// `pathFilters` / `architectureGlobs`), NOT function names — the
// acceptance criterion is "PRs touching declared hot paths are
// flagged", which is a file-level signal. The finding-level
// `hotPathIdentifier` (function + call frequency) remains the LLM
// specialist's job; this fact primes it.
//
// The hit renders into the PERFORMANCE specialist's prompt as an
// authoritative fact (routed via `role-scoped-facts.ts`). We don't add
// a verdict finding here — the existing fact-block flow surfaces it.
//
// Pure module: no I/O, no async. Caller resolves config first via
// `resolvePerfBudgetsConfig` and hands in the changed paths.

import { compileGlob } from "@/src/shared/util/path-glob"

export interface ResolvedPerfBudgets {
  p50LatencyBudgetMs: number | null
  p95LatencyBudgetMs: number | null
  bundleSizeBudgetKb: number | null
  hotPaths: readonly string[]
}

export interface PerfBudgetsHit {
  /** Changed files matching a declared `hotPaths` glob. Capped to ≤ 10
   *  for prompt size, in changed-path order. */
  hotPathFiles: string[]
  /** The `hotPaths` globs that matched at least one changed file, in
   *  config order. */
  matchedHotPaths: string[]
  /** The operator's declared budgets, echoed back so the prompt can
   *  show concrete numbers. `null` for any budget not set. */
  budgets: {
    p50LatencyBudgetMs: number | null
    p95LatencyBudgetMs: number | null
    bundleSizeBudgetKb: number | null
  }
}

/**
 * Run the perf-budgets check against a PR's changed-file list. Returns
 * a hit when a changed file lands on a declared hot path, or `null`
 * when nothing matches (or no hot paths are declared).
 *
 * Caller resolves config first via `resolvePerfBudgetsConfig`.
 */
export function runPerfBudgetsCheck(
  changedPaths: ReadonlyArray<string>,
  config: ResolvedPerfBudgets,
): PerfBudgetsHit | null {
  if (config.hotPaths.length === 0) return null
  if (changedPaths.length === 0) return null

  // Compile each glob alongside its source pattern so we can report
  // which declared hot path matched. Bad globs drop silently (an
  // operator typo shouldn't break the check).
  const compiled: Array<{ pattern: string; re: RegExp }> = []
  for (const pattern of config.hotPaths) {
    try {
      compiled.push({ pattern, re: compileGlob(pattern) })
    } catch {
      // bad glob — drop silently
    }
  }
  if (compiled.length === 0) return null

  const hotPathFiles: string[] = []
  const matchedPatterns = new Set<string>()
  for (const p of changedPaths) {
    let fileMatched = false
    for (const { pattern, re } of compiled) {
      if (re.test(p)) {
        fileMatched = true
        matchedPatterns.add(pattern)
      }
    }
    if (fileMatched) hotPathFiles.push(p)
  }
  if (hotPathFiles.length === 0) return null

  // Preserve config order for the matched globs (Set iteration order is
  // insertion order, which is changed-path order; re-derive from config
  // so the prompt reads in the order the operator declared them).
  const matchedHotPaths = config.hotPaths.filter((p) => matchedPatterns.has(p))

  return {
    hotPathFiles: hotPathFiles.slice(0, 10),
    matchedHotPaths,
    budgets: {
      p50LatencyBudgetMs: config.p50LatencyBudgetMs,
      p95LatencyBudgetMs: config.p95LatencyBudgetMs,
      bundleSizeBudgetKb: config.bundleSizeBudgetKb,
    },
  }
}

/**
 * Render the perf-budgets hit as a single authoritative-fact block for
 * the performance specialist's prompt. Returns the empty string when
 * `hit` is null so callers can join the result into a combined fact
 * block without conditional logic.
 */
export function renderPerfBudgetsForPrompt(hit: PerfBudgetsHit | null): string {
  if (hit === null) return ""

  const fileList = hit.hotPathFiles.map((f) => `- \`${f}\``).join("\n")
  const globList = hit.matchedHotPaths.map((p) => `\`${p}\``).join(", ")

  const budgetParts: string[] = []
  if (hit.budgets.p50LatencyBudgetMs !== null) {
    budgetParts.push(`p50 ≤ ${hit.budgets.p50LatencyBudgetMs}ms`)
  }
  if (hit.budgets.p95LatencyBudgetMs !== null) {
    budgetParts.push(`p95 ≤ ${hit.budgets.p95LatencyBudgetMs}ms`)
  }
  if (hit.budgets.bundleSizeBudgetKb !== null) {
    budgetParts.push(`bundle ≤ ${hit.budgets.bundleSizeBudgetKb}KB`)
  }

  const lines = [
    "[PERF BUDGETS — pre-LLM, structured]",
    "",
    `This PR modifies code on a declared hot path (matched glob(s): ${globList}). These globs are PRIORITIZATION facts — a signal to look harder here — NOT validator anchors.`,
    "",
    "**Hot-path files touched:**",
    fileList,
  ]
  if (budgetParts.length > 0) {
    lines.push(
      "",
      `**Declared budget targets for these paths (repo policy, NOT measurements):** ${budgetParts.join(", ")}.`,
      "Sigilix has NOT measured this PR's latency or bundle size — do NOT claim a budget is exceeded. Use the targets only to judge whether the added code plausibly threatens them.",
    )
  }
  lines.push(
    "",
    "Scrutinize the added code on these paths for latency / allocation / round-trip regressions (N+1 calls, blocking I/O, unbounded growth). When you flag one, anchor it with `hotPathIdentifier` (the specific changed function or route/handler token, NOT the glob) and/or `complexityEstimate`.",
  )
  return lines.join("\n")
}
