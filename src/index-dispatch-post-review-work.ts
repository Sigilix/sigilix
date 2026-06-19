// SIG-471: extracted VERBATIM from `index-dispatch.ts` to keep that file within
// the 1000-line budget (COMPLIANCE §4/§6 — zero-behavior move, modulo the added
// `export` keywords + the import in the original). These two helpers bound + log
// the optional post-review background work the pr-review case awaits; they are
// internal to the dispatch leaf (not exported anywhere else), so they relocate
// here cleanly without changing any importer.

const POST_REVIEW_WORK_TIMEOUT_MS = 120_000
export type PostReviewWorkOutcome = { status: "completed" } | { status: "failed"; error: string }

export async function waitForPostReviewWork(work: Promise<PostReviewWorkOutcome>): Promise<PostReviewWorkOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PostReviewWorkOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ status: "failed", error: `post-review-work-timeout:${POST_REVIEW_WORK_TIMEOUT_MS}` }),
      POST_REVIEW_WORK_TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function postReviewWorkBlocked(
  work: Promise<{ status: "completed" } | { status: "failed"; error: string }> | undefined,
  tag: { owner: string; repo: string; prNumber: number; headSha: string },
): Promise<boolean> {
  if (work === undefined) return false
  try {
    const outcome = await waitForPostReviewWork(work)
    if (outcome.status !== "failed") return false
    console.error(
      JSON.stringify({
        event: "pr-review-post-review-work-blocked",
        ...tag,
        headSha: tag.headSha.slice(0, 7),
        error: outcome.error,
      }),
    )
    return true
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pr-review-post-review-work-threw",
        ...tag,
        headSha: tag.headSha.slice(0, 7),
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    return true
  }
}
