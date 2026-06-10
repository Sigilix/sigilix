// SIG-333: render CI-triage fix patches as committable inline `suggestion`
// review comments. The CI-triage handler (SIG-332) already produces a
// structured diagnosis with `patches: { path, line, replacement }[]`; this
// module anchors each patch to a reviewable diff line and shapes the GitHub
// review payload. Shadow-first behind `OPENCLAW_CI_SUGGESTIONS_MODE`.
//
// Reuses the proactive-review anchoring primitive (`diff-positions.ts`) and
// mirrors the `/improve` posting pattern (`triage-pr-improve.ts`): one
// COMMENT-event review carrying a single inline comment per anchorable
// patch, with the rest preserved in the sticky comment so nothing is
// silently dropped. Pure — no I/O; the orchestrator in `triage-ci.ts`
// performs the GitHub calls and the mode/sensitive gating.

import { deriveSide, type ReviewableMap } from "./diff-positions"
import { GitHubHttpError } from "@/src/shared/adapters/github"
import type { SubmitReviewBody, SubmitReviewComment } from "@/src/shared/types/github"
import type { CiTriagePatch } from "./triage-ci"

export type CiSuggestionsMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_CI_SUGGESTIONS_MODE`. Anything other than the literal
 * "enforce" (trimmed, case-insensitive) resolves to "shadow" — the
 * cautious default for a staged rollout, matching the
 * `OPENCLAW_*_VALIDATOR_MODE` knobs. In shadow the inline review is
 * computed + telemetered but never posted.
 */
export function parseCiSuggestionsMode(raw: string | undefined): CiSuggestionsMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/**
 * Marker stamped into every inline CI-suggestion comment body so a re-run
 * can detect that suggestions were already posted (dedup) and skip rather
 * than double-post.
 */
export const CI_SUGGESTION_MARKER = "<!-- sigilix:ci-suggestion -->"

/**
 * True iff any of the PR's existing review-comment bodies is one of ours.
 * Used to dedup: a re-run of the same failure must not append a second set
 * of inline suggestions.
 */
export function hasExistingCiSuggestion(
  bodies: ReadonlyArray<string | null | undefined>,
): boolean {
  return bodies.some((b) => typeof b === "string" && b.includes(CI_SUGGESTION_MARKER))
}

export interface PartitionedCiPatches {
  /** Patches whose (path, line) is a RIGHT-side reviewable diff position. */
  anchorable: CiTriagePatch[]
  /** Patches not in the PR diff — preserved in the sticky comment instead. */
  unanchorable: CiTriagePatch[]
}

/**
 * A replacement can be an inline `suggestion` only when it doesn't itself
 * contain a triple-backtick run — a GitHub `suggestion` fence is exactly
 * three backticks and can't be lengthened, so a ``` inside the body would
 * close the block early. Multi-line replacements are fine (GitHub renders
 * them as a multi-line suggestion). A fence-unsafe patch falls back to the
 * sticky comment (which uses a length-aware fence) instead.
 */
function isSuggestionSafe(replacement: string): boolean {
  return !replacement.includes("```")
}

/**
 * Split patches into inline-anchorable vs. sticky-fallback. A patch is
 * anchorable iff its line is a RIGHT-side reviewable position in the diff
 * (an added / changed / context line of the new file) AND its replacement
 * is fence-safe. De-dupes by `path:line` so two patches targeting the same
 * line don't produce conflicting suggestions (the first wins; the rest
 * fall back). Pure.
 */
export function partitionCiPatches(
  patches: readonly CiTriagePatch[],
  reviewable: ReviewableMap,
): PartitionedCiPatches {
  const anchorable: CiTriagePatch[] = []
  const unanchorable: CiTriagePatch[] = []
  const seen = new Set<string>()
  for (const patch of patches) {
    const key = `${patch.path}:${patch.line}`
    // First-wins: the first patch for a path:line claims it. Later patches on
    // that same line are duplicates — you can't apply two replacements to one
    // line — so they're dropped entirely (not re-shown in the sticky, which
    // would just add a conflicting entry for a line already covered).
    if (seen.has(key)) continue
    seen.add(key)
    if (
      isSuggestionSafe(patch.replacement) &&
      deriveSide(reviewable, patch.path, patch.line) === "RIGHT"
    ) {
      anchorable.push(patch)
    } else {
      unanchorable.push(patch)
    }
  }
  return { anchorable, unanchorable }
}

/**
 * The inline review-comment body for one patch: a committable
 * `suggestion` block carrying the replacement line, plus the dedup marker.
 * GitHub renders the "Commit suggestion" button from the fenced block.
 */
export function renderCiSuggestionBody(patch: CiTriagePatch): string {
  return [
    CI_SUGGESTION_MARKER,
    "**🔧 Sigilix · suggested fix for the CI failure**",
    "",
    "```suggestion",
    patch.replacement,
    "```",
  ].join("\n")
}

/**
 * Build the single COMMENT-event review carrying one inline `suggestion`
 * per anchorable patch. Every comment is pre-validated RIGHT-side (the
 * caller passes only `partitionCiPatches(...).anchorable`), which avoids
 * the common bad-anchor 422 — but a context-line anchor can still be
 * rejected, so the orchestrator wraps the submit in a try/catch. Returns
 * null when there is nothing to post.
 */
export function buildCiSuggestionReview(
  anchorable: readonly CiTriagePatch[],
  headSha: string,
): SubmitReviewBody | null {
  if (anchorable.length === 0) return null
  const comments: SubmitReviewComment[] = anchorable.map((patch) => ({
    path: patch.path,
    line: patch.line,
    side: "RIGHT",
    body: renderCiSuggestionBody(patch),
  }))
  const n = comments.length
  return {
    body: `${CI_SUGGESTION_MARKER}\n**🔧 Sigilix · CI failure analysis** — ${n} apply-able fix${n === 1 ? "" : "es"}. Apply via the "Commit suggestion" button.`,
    event: "COMMENT",
    commit_id: headSha,
    comments,
  }
}

/**
 * Render un-anchorable patches as a sticky-comment section so a fix whose
 * line isn't in the PR's diff is shown (copy-paste-able) rather than
 * silently dropped. Returns "" when there are none. Pure.
 */
export function renderUnanchorableCiPatches(
  unanchorable: readonly CiTriagePatch[],
): string {
  if (unanchorable.length === 0) return ""
  const parts: string[] = [
    "🔧 **Suggested edits** (apply manually — these lines aren't in this PR's diff):",
    "",
  ]
  for (const patch of unanchorable) {
    parts.push(`\`${patch.path}:${patch.line}\``, fencedBlock(patch.replacement), "")
  }
  return parts.join("\n").trimEnd()
}

/**
 * Wrap content in a fenced code block whose fence is longer than any
 * backtick run inside it, so a replacement that itself contains ``` can't
 * close the block early. (Unlike inline `suggestion` fences, a plain code
 * block CAN use a longer fence — which is why fence-unsafe patches land
 * here rather than inline.)
 */
function fencedBlock(content: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (m) => m[0]?.length ?? 0),
  )
  const fence = "`".repeat(Math.max(3, longestRun + 1))
  return `${fence}\n${content}\n${fence}`
}

export interface CiSuggestionsPlan {
  /** Markdown to append to the sticky comment (un-anchorable patches), or "". */
  stickySuffix: string
  /** The inline review to submit, or null (shadow / sensitive / none anchorable). */
  review: SubmitReviewBody | null
  anchorableCount: number
  unanchorableCount: number
}

/**
 * Pure decision step: given the diagnosis patches, the parsed diff, the
 * mode, and the sensitive-repo verdict, decide WHAT to post — without
 * doing any I/O. The orchestrator (`triage-ci.ts`) executes the plan
 * (appends `stickySuffix` to the sticky body and submits `review` when
 * non-null + not already posted). Isolating the gating here makes the
 * shadow-no-op / enforce / sensitive-gate / un-anchorable-fallback logic
 * directly unit-testable.
 *
 * Shadow (default) and sensitive repos: `review` is null and
 * `stickySuffix` is "" — i.e. the sticky stays byte-identical to SIG-332
 * and nothing posts inline. Only `enforce` on a non-sensitive repo posts.
 */
export function planCiSuggestions(args: {
  patches: readonly CiTriagePatch[]
  reviewable: ReviewableMap
  mode: CiSuggestionsMode
  sensitive: boolean
  headSha: string
}): CiSuggestionsPlan {
  const { patches, reviewable, mode, sensitive, headSha } = args
  const { anchorable, unanchorable } = partitionCiPatches(patches, reviewable)
  const inlineEnabled = mode === "enforce" && !sensitive
  return {
    stickySuffix:
      inlineEnabled && unanchorable.length > 0
        ? `\n\n${renderUnanchorableCiPatches(unanchorable)}`
        : "",
    review: inlineEnabled ? buildCiSuggestionReview(anchorable, headSha) : null,
    anchorableCount: anchorable.length,
    unanchorableCount: unanchorable.length,
  }
}

/**
 * Minimal GitHub client surface `submitCiSuggestionReview` needs. The real
 * `GitHubClient` satisfies it structurally; tests pass a small fake.
 */
export interface CiSuggestionClient {
  listPullRequestReviewComments(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReadonlyArray<{ body: string }>>
  submitReview(
    owner: string,
    repo: string,
    prNumber: number,
    review: SubmitReviewBody,
  ): Promise<unknown>
}

export interface CiSuggestionPostResult {
  /** Number of inline suggestion comments actually posted. */
  posted: number
  /** Telemetry label when nothing — or not everything — posted cleanly. */
  skip: string | null
}

/**
 * Execute a planned inline-suggestion review against GitHub. The handler's
 * I/O orchestration, extracted so its branches are directly testable:
 *   1. Dedup — if a CI-suggestion review comment already exists on the PR,
 *      skip entirely (`already-posted`) so a re-run never double-posts. If
 *      the dedup listing itself fails, skip (`dedup-check-failed`) rather
 *      than risk a duplicate.
 *   2. Happy path — one bulk COMMENT review (a single API call).
 *   3. Split-on-422 — GitHub rejects the WHOLE review if a single anchor is
 *      bad; on failure, retry each comment as its own one-comment review so
 *      one bad anchor only drops itself, not the rest.
 * The caller always posts the sticky comment, so even a total failure here
 * never loses the diagnosis.
 */
export async function submitCiSuggestionReview(
  client: CiSuggestionClient,
  owner: string,
  repo: string,
  prNumber: number,
  review: SubmitReviewBody,
): Promise<CiSuggestionPostResult> {
  let prior: ReadonlyArray<{ body: string }>
  try {
    prior = await client.listPullRequestReviewComments(owner, repo, prNumber)
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ci-suggestions-dedup-check-failed",
      owner, repo, prNumber,
      err: err instanceof Error ? err.message : String(err),
    }))
    return { posted: 0, skip: "dedup-check-failed" }
  }
  if (hasExistingCiSuggestion(prior.map((c) => c.body))) {
    return { posted: 0, skip: "already-posted" }
  }

  const comments = review.comments ?? []
  try {
    await client.submitReview(owner, repo, prNumber, review)
    return { posted: comments.length, skip: null }
  } catch (err) {
    // Split retry ONLY on a 422 *validation* failure — a bad anchor GitHub
    // rejected, which a per-comment resubmission can route around. A 422 is
    // not always anchor-related: GitHub also returns it for secondary rate
    // limiting and other validation, where splitting into N concurrent
    // retries would AMPLIFY the problem. Anchor rejections carry a
    // "Validation Failed" body (the error message includes the response
    // body), so gate on that + the status. Everything else fails fast — the
    // sticky already carries the diagnosis.
    const isAnchorValidation =
      err instanceof GitHubHttpError &&
      err.status === 422 &&
      /validation failed/i.test(err.message)
    if (!isAnchorValidation) {
      console.warn(JSON.stringify({
        event: "ci-suggestions-submit-failed",
        owner, repo, prNumber,
        err: err instanceof Error ? err.message : String(err),
      }))
      return { posted: 0, skip: "submit-failed" }
    }

    // Re-submit each comment on its own so a single bad anchor only drops
    // itself. Concurrent — bounded to ≤5 by the schema, on a cold path —
    // with a bare body so the per-anchor reviews don't repeat the header.
    const results = await Promise.allSettled(
      comments.map((comment) =>
        client.submitReview(owner, repo, prNumber, {
          event: "COMMENT",
          ...(review.commit_id !== undefined ? { commit_id: review.commit_id } : {}),
          comments: [comment],
        }),
      ),
    )
    let posted = 0
    results.forEach((res, i) => {
      if (res.status === "fulfilled") {
        posted += 1
        return
      }
      const comment = comments[i]
      console.warn(JSON.stringify({
        event: "ci-suggestion-anchor-unpostable",
        owner, repo, prNumber,
        path: comment?.path, line: comment?.line,
        err: res.reason instanceof Error ? res.reason.message : String(res.reason),
      }))
    })
    const skip =
      posted === 0 ? "submit-failed" : posted === comments.length ? "split-recovered" : "partial"
    return { posted, skip }
  }
}
