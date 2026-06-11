// SIG-318 / SIG-366: the publish phase's module-private pure helpers — the
// single-retry inline-overview runner + the two finding-count breakdowns (by
// severity tier / by category) — split into a sibling leaf so `app/publish.ts`
// stays under the 1k-line cap (the SIG-318 file-size invariant) after Prettier's
// canonical wrapping pushed it just over. Moved VERBATIM from publish (only the
// `export` keywords + the import paths change). ZERO behavior change.
//
// These three were god-file-private and stay non-public — `publish.ts` imports them
// for its own use; nothing outside re-exports them.
//
// Dependency rule: a leaf — it imports `handlePrOverview` from the overview leaf and
// `severityTier` from the verdict domain (laterals), never the orchestrator.

import { handlePrOverview, type PrOverviewArgs } from "@/src/lib/triage-pr-overview"
import { severityTier } from "@/src/lib/ensemble/domain/verdict"

export async function runInlineOverviewWithRetry(args: PrOverviewArgs, totalBudgetMs: number): Promise<void> {
  // SIG-216 fix-up: ONE shared deadline across both attempts (was: a
  // fresh per-attempt budget that could allow overlapping attempts on
  // retry and let the wall-clock blow past the budget). Each attempt
  // also gets its own AbortController so the in-flight Ollama fetch
  // from the first attempt is actually cancelled when retry fires —
  // otherwise the abandoned Promise burns CPU + network until the
  // 600s default `generate` timeout.
  const deadline = Date.now() + totalBudgetMs
  const computeRemaining = (): number => Math.max(0, deadline - Date.now())

  const attempt = async (): Promise<void> => {
    const remainingMs = computeRemaining()
    if (remainingMs <= 0) {
      throw new Error("inline-overview-budget-exceeded")
    }
    const ctl = new AbortController()
    const timeoutId = setTimeout(() => {
      ctl.abort(new Error("inline-overview-budget-exceeded"))
    }, remainingMs)
    try {
      await handlePrOverview({ ...args, abortSignal: ctl.signal })
    } finally {
      clearTimeout(timeoutId)
    }
  }

  try {
    await attempt()
    return
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const transient = /budget-exceeded|timeout|abort|503|502|504|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)
    if (!transient) throw err
    if (computeRemaining() <= 0) throw err
    console.log(
      JSON.stringify({
        event: "pr-review-inline-overview-retry",
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
        head_sha: args.headSha.slice(0, 7),
        err: msg.slice(0, 200),
      }),
    )
    await attempt()
  }
}

/**
 * SIG-216: count findings by P0/P1/P2/P3 severity tier for the
 * `reviewContext.severityBreakdown` passed into `handlePrOverview`.
 * Empty buckets are omitted so the prompt stays compact. Pure.
 */
export function countBySeverity(findings: readonly { score: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of findings) {
    const tier = severityTier(f.score)
    out[tier] = (out[tier] ?? 0) + 1
  }
  return out
}

/**
 * SIG-216: count findings by `FindingCategory` for the
 * `reviewContext.categoryBreakdown` passed into `handlePrOverview`.
 * Empty buckets are omitted so the prompt stays compact. Pure.
 */
export function countByCategory(findings: readonly { category: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of findings) {
    out[f.category] = (out[f.category] ?? 0) + 1
  }
  return out
}
