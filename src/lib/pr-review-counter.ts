// SIG-101 — per-PR review counter persistence.
//
// The orchestrator calls `preparePrReviewCounter` before rendering a
// REQUEST_CHANGES body, then persists it only after that review has
// posted. The resulting `_Sigilix · Review #N for this PR · last
// rendered <ts>._` footer line reflects the actual number of
// request-changes reviews Sigilix has submitted against this PR.
// APPROVE/COMMENT bodies skip the counter.
//
// KV shape:
//   key:   pr-review-counter:<owner>/<repo>#<prNumber>
//   value: the latest counter as a decimal string (no leading zeros)
//   TTL:   none — counters persist for the lifetime of the PR
//
// Concurrency: Cloudflare KV doesn't expose atomic increment. Two
// concurrent reviews on the same PR (an unusual but possible race
// — e.g., a webhook + a `/sigilix review` slash command at the same
// instant) could both read N and write N+1, producing the same
// counter on both reviews. The dedupe layers above
// (`enqueuePrReviewJob` DO + the per-headSha coalesce) make this
// race vanishingly rare in practice, and counter-correctness is
// best-effort: the worst case is two reviews labeled "#N" instead
// of "#N" + "#N+1". We don't gate any behavior on counter
// uniqueness, so the simpler read-write pattern is fine here.

import type { Env } from "@/src/shared/types/env"

export function buildReviewCounterKey(owner: string, repo: string, prNumber: number): string {
  return `pr-review-counter:${owner}/${repo}#${prNumber}`
}

export interface PreparedPrReviewCounter {
  value: number
  persist: () => Promise<void>
}

/**
 * Compute the next visible review counter without mutating KV yet.
 * The caller can render the counter into a REQUEST_CHANGES body, then
 * persist it only after that REQUEST_CHANGES review actually posts.
 */
export async function preparePrReviewCounter(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<PreparedPrReviewCounter> {
  const key = buildReviewCounterKey(owner, repo, prNumber)
  let current = 0
  let readSucceeded = false
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    readSucceeded = true
    if (raw !== null) {
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed >= 0) {
        current = parsed
      }
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "pr-review-counter-read-failed",
        owner,
        repo,
        prNumber,
        err: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  const value = current + 1
  let persisted = false
  const persist = async (): Promise<void> => {
    if (persisted) return
    persisted = true
    if (!readSucceeded) return
    try {
      await env.OPENCLAW_STATE.put(key, String(value))
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "pr-review-counter-write-failed",
          owner,
          repo,
          prNumber,
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  return { value, persist }
}

/**
 * Read the current counter (or 0 if absent), increment to N, persist
 * N, and return N. Best-effort — KV failures fall back to a synthetic
 * counter of 1 so the renderer always has something to print.
 *
 * CodeRabbit catch on PR #110: when the initial KV `get` throws (KV
 * transport outage, not a missing key), we previously fell through
 * with `current = 0` and then attempted to write `"1"`. If the put
 * succeeded, that would CLOBBER a real persisted counter (e.g., 7)
 * with 1, regressing the user-visible sequence. The fix tracks the
 * read outcome in `readSucceeded` and skips the put-back when the
 * read failed, so the persisted counter stays untouched. The
 * synthetic 1 still surfaces to the renderer this run, which is the
 * documented "best effort, may go off-by-one under failure"
 * semantics.
 */
export async function bumpPrReviewCounter(env: Env, owner: string, repo: string, prNumber: number): Promise<number> {
  const prepared = await preparePrReviewCounter(env, owner, repo, prNumber)
  await prepared.persist()
  return prepared.value
}

/**
 * SIG-101 — construct the GitHub web URL for the PR. Used as the
 * click target of the `[🔄 Re-run review](URL)` retrigger CTA in
 * the request-changes body footer. GitHub doesn't support pre-filled
 * comment bodies on existing PRs, so the link just lands the user on
 * the PR page — the adjacent `<sub>` text in the footer tells them
 * to comment `/sigilix review` to actually re-run.
 *
 * Pure — exported for tests.
 */
export function buildPrUrl(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`
}
