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
import type { SubmitReviewBody, SubmitReviewComment } from "./github"
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
 * Split patches into inline-anchorable vs. sticky-fallback. A patch is
 * anchorable iff its line is a RIGHT-side reviewable position in the diff
 * (an added / changed / context line of the new file). De-dupes by
 * `path:line` so two patches targeting the same line don't produce
 * conflicting suggestions (the first wins; the rest fall back). Pure.
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
    if (!seen.has(key) && deriveSide(reviewable, patch.path, patch.line) === "RIGHT") {
      seen.add(key)
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
    parts.push(`\`${patch.path}:${patch.line}\``, "```", patch.replacement, "```", "")
  }
  return parts.join("\n").trimEnd()
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
