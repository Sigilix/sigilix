// SIG-101 — per-PR review counter persistence.
//
// The orchestrator calls `bumpPrReviewCounter` before rendering a
// REQUEST_CHANGES body so the resulting `_Sigilix · Review #N for
// this PR · last rendered <ts>._` footer line reflects the actual
// number of reviews Sigilix has submitted against this PR. APPROVE
// bodies stay marker-only (SIG-94) and skip the bump.
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

import type { Env } from "../index"

export function buildReviewCounterKey(
  owner: string,
  repo: string,
  prNumber: number,
): string {
  return `pr-review-counter:${owner}/${repo}#${prNumber}`
}

/**
 * Read the current counter (or 0 if absent), increment to N, persist
 * N, and return N. Best-effort — KV failures fall back to a synthetic
 * counter of 1 so the renderer always has something to print.
 */
export async function bumpPrReviewCounter(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const key = buildReviewCounterKey(owner, repo, prNumber)
  let current = 0
  try {
    const raw = await env.OPENCLAW_STATE.get(key)
    if (raw !== null) {
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed >= 0) {
        current = parsed
      }
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-counter-read-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
  const next = current + 1
  try {
    await env.OPENCLAW_STATE.put(key, String(next))
  } catch (err) {
    console.warn(JSON.stringify({
      event: "pr-review-counter-write-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
  }
  return next
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
