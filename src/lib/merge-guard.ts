// ARC-286 — pre-submit "is PR still open" guard. Extracted from the
// inline block in `handlePrReviewEnsemble` per Sigilix's PR #97
// round-2 pushback: testing the guard's three branches (open / merged
// / API-error) takes ~3 unit tests with 1-2 mocks, not 20-mock
// orchestrator integration tests. The orchestrator just calls this
// helper and emits its own `pr-review-skipped-merged` event when
// `shouldSkip: true`.

/** Just the slice of `GitHubClient` this helper needs. Defined locally
 *  so tests can stub a 1-method object rather than constructing the
 *  full client. */
export interface MergeGuardClient {
  getPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<{ merged_at?: string | null }>
}

export type MergeGuardResult =
  | { shouldSkip: false }
  | { shouldSkip: true; mergedAtMs: number }

/**
 * Fetches the PR's current state. Returns `shouldSkip: true` with the
 * merge timestamp when the PR is already merged; `shouldSkip: false`
 * otherwise.
 *
 * **Best-effort.** Transient GitHub failures (5xx, rate limits,
 * network blips) log warn and return `shouldSkip: false` so the
 * caller proceeds with submit. Sigilix PR #97 Critical catch: the
 * caller's risk on a discarded synth review (minutes of work lost)
 * exceeds the risk on a duplicate-review-against-merged-PR (the
 * ARC-286 quirks we wanted to prevent). Warn-and-proceed is the
 * right semantics for a best-effort guard.
 *
 * Pure-side-effect-free except for the one warn log on the error
 * path. Exported for unit tests.
 */
export async function checkIsPrMerged(args: {
  client: MergeGuardClient
  owner: string
  repo: string
  prNumber: number
  /** Stamped on the warn log for correlation. */
  headSha: string
}): Promise<MergeGuardResult> {
  try {
    const meta = await args.client.getPullRequest(args.owner, args.repo, args.prNumber)
    if (meta.merged_at !== null && meta.merged_at !== undefined) {
      return { shouldSkip: true, mergedAtMs: new Date(meta.merged_at).getTime() }
    }
    return { shouldSkip: false }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-merged-guard-failed",
      owner: args.owner,
      repo: args.repo,
      prNumber: args.prNumber,
      headSha: args.headSha.slice(0, 7),
      err: err instanceof Error ? err.message : String(err),
    }))
    return { shouldSkip: false }
  }
}
