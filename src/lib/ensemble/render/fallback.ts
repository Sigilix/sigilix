// SIG-365 (PR 13) — the anchorless-FALLBACK render module (render layer).
//
// The Greptile-style submit-review fallback carved VERBATIM from
// triage-pr-review.ts: when GitHub rejects the inline-anchored review (422 on a
// single bad position), `buildFallbackSubmission` / `buildFallbackBody` re-render
// the same verdict with NO inline anchors, pouring every finding into the body.
// Like the submission module it CONSUMES the review-event decision
// (`chooseRenderedEventWithOverride` from domain/verdict) — render reading domain
// — and never makes the decision itself.
//
// Dependency rule: imports point inward only — the per-finding render leaf
// (`./finding-format`), the body render module (`./review-body`), the verdict
// domain (`../domain/verdict`), the finding/verdict domain types, and the pure
// pr-stack leaf. It NEVER imports the orchestrator god-file or any app/adapter
// module. The bodies are byte-identical to their HEAD form in triage-pr-review.ts;
// only the import paths and the wrapper are new.

import type { SubmitReviewBody } from "@/src/shared/types/github"
import { type StackContext } from "@/src/lib/pr-stack"
import type { PrReviewVerdict, PrReviewFinding, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import { chooseRenderedEventWithOverride, type ReviewEventOverride } from "@/src/lib/ensemble/domain/verdict"
import {
  sanitizeVerdictForGitHub,
  sanitizeFindingsForGitHub,
  normalizeTestingFindingForFinalPolicy,
  normalizeFallbackBodyFindings,
  shouldDropUnanchoredTestingFinding,
} from "./finding-format"
import {
  renderApproveBody,
  renderCommentBody,
  renderRequestChangesBody,
  type RenderBodyArgs,
  type ProvenanceCtx,
  type DeltaBadgeCounts,
  type ReviewDisclosure,
} from "./review-body"

interface BuildFallbackArgs {
  verdict: PrReviewVerdict
  unanchored: PrReviewFinding[]
  prAuthor: string | null
  headSha: string
  /** See BuildReviewArgs.eventOverride. */
  eventOverride?: ReviewEventOverride
  /** ARC-182: optional stack context, forwarded to buildFallbackBody. */
  stack?: StackContext
  /** ARC-281: specialist coverage roster (forwarded to renderer). */
  coverage?: CoverageRoles
  /** ARC-281: finding-delta counts (forwarded to renderer). */
  delta?: DeltaBadgeCounts | null
  /** SIG-101: forwarded review counter + retrigger URL. */
  reviewCounter?: number
  retriggerUrl?: string
  /** SIG Trust Ledger v0: render the trust layer in the anchorless-fallback body
   *  too (post-`on`-flip consistency). Forwarded to buildFallbackBody. */
  trustLedger?: boolean
  /** SIG-112: render evidence/provenance blocks in anchorless fallback too. */
  showEvidence?: boolean
  /** SIG-414 Phase 1.2: the honest 3-way un-reviewed disclosure (policy /
   *  oversized / spillover) — render the three notices on the anchorless-fallback
   *  body too, so the 422-retry path never silently drops (CR #286 / SIG-414). */
  disclosure?: ReviewDisclosure
}

/**
 * Greptile-style submit-review fallback: when the inline-anchored review
 * (POST /reviews with `comments`) is rejected by GitHub, retry the same
 * review WITHOUT inline anchors, embedding every finding in the body as
 * markdown grouped by file. Recovers the verdict instead of losing it.
 *
 * Findings come from two sources:
 *   1. `verdict.findings` — passed every validator (line-valid, anchored)
 *   2. `unanchored` — passed the hallucination guard but failed
 *      `deriveSide()` (e.g., model picked a line outside the diff). With
 *      no inline anchoring in fallback mode, the position-validity gate
 *      no longer matters — these still describe real concerns.
 *
 * Both lists are merged, grouped by `path`, and rendered as a Markdown
 * `### Findings` section. The dedupe marker `<!-- sigilix:pr-review -->`
 * is preserved at the top so existing dedupe-by-marker logic still
 * recognizes the comment.
 *
 * Pure — exported for tests.
 */
export function buildFallbackSubmission({
  verdict: rawVerdict,
  unanchored: rawUnanchored,
  headSha,
  stack,
  coverage,
  delta,
  reviewCounter,
  retriggerUrl,
  eventOverride,
  trustLedger,
  showEvidence,
  disclosure,
}: BuildFallbackArgs): SubmitReviewBody {
  // ARC-156 follow-up: sanitize prose before rendering — same as
  // buildReviewSubmission, applied here for the anchorless-fallback
  // path so the body-rendered findings also get HTML-tag wrap.
  const sanitizedVerdict = sanitizeVerdictForGitHub(rawVerdict)
  const verdict: PrReviewVerdict = {
    ...sanitizedVerdict,
    findings: sanitizedVerdict.findings.map(normalizeTestingFindingForFinalPolicy),
  }
  const unanchored = sanitizeFindingsForGitHub(rawUnanchored)
    .map(normalizeTestingFindingForFinalPolicy)
    .filter((finding) => !shouldDropUnanchoredTestingFinding(finding))
  const all = normalizeFallbackBodyFindings([...verdict.findings, ...unanchored])
  const event = chooseRenderedEventWithOverride(
    {
      inlineFindings: [],
      bodyOnlyFindings: all,
    },
    eventOverride,
  )
  const body = buildFallbackBody(
    verdict,
    unanchored,
    undefined,
    stack,
    coverage,
    delta,
    reviewCounter,
    retriggerUrl,
    // Propagate the full override (not just REQUEST_CHANGES) so a COMMENT
    // downgrade — SIG-287 degraded/low-confidence OR SIG-245 files-dropped —
    // survives on the fallback body too; otherwise buildFallbackBody re-derives
    // APPROVE for an empty-findings review and discards the notice/caveat.
    eventOverride,
    trustLedger,
    showEvidence,
    disclosure,
  )
  return {
    event,
    body,
    commit_id: headSha,
    // No `comments` array — every finding lives in `body`.
  }
}

export function buildFallbackBody(
  verdict: PrReviewVerdict,
  unanchored: PrReviewFinding[],
  prov?: ProvenanceCtx,
  stack?: StackContext,
  coverage?: CoverageRoles,
  delta?: DeltaBadgeCounts | null,
  reviewCounter?: number,
  retriggerUrl?: string,
  eventOverride?: ReviewEventOverride,
  trustLedger?: boolean,
  showEvidence?: boolean,
  disclosure?: ReviewDisclosure,
): string {
  // ARC-281: the anchorless-fallback path means GitHub silently
  // dropped the inline anchors, so the body must carry every
  // finding. Pour both `verdict.findings` and `unanchored` into the
  // single `unanchored` bucket of the new renderer — they render as
  // the body-only findings section grouped by file, which is exactly
  // the right place when none of them landed inline.
  const all = normalizeFallbackBodyFindings([...verdict.findings, ...unanchored])
  const event = chooseRenderedEventWithOverride(
    {
      inlineFindings: [],
      bodyOnlyFindings: all,
    },
    eventOverride,
  )
  if (event === "APPROVE") {
    // Pour ALL findings into the bucket (not `unanchored: []`) so an out-of-PR-
    // scope note that lives only in `unanchored` still surfaces in the approve
    // body's non-inline findings dropdown (out-of-PR-scope group) — anchorless-
    // fallback must not drop it (Codex #2). renderApproveBody renders only the
    // outOfPrScope subset.
    const args: RenderBodyArgs = { verdict: { ...verdict, findings: [] }, unanchored: all }
    if (trustLedger) args.trustLedger = true
    if (showEvidence) args.showEvidence = true
    if (stack !== undefined) args.stack = stack
    if (prov !== undefined) args.prov = prov
    if (coverage) args.coverage = coverage
    if (delta !== undefined) args.delta = delta
    // SIG-414 Phase 1.2: a POLICY-only skip stays APPROVE, so the policy note
    // must survive on the APPROVE fallback body too (renderApproveBody renders
    // the disclosure). Pre-SIG-414 the APPROVE branch dropped the notice — a
    // policy-only fallback would have been silent.
    if (disclosure) args.disclosure = disclosure
    return renderApproveBody(args)
  }
  const args: RenderBodyArgs = {
    verdict: { ...verdict, findings: [] },
    unanchored: all,
  }
  if (trustLedger) args.trustLedger = true
  if (showEvidence) args.showEvidence = true
  if (stack !== undefined) args.stack = stack
  if (prov !== undefined) args.prov = prov
  if (coverage) args.coverage = coverage
  if (delta !== undefined) args.delta = delta
  if (typeof reviewCounter === "number") args.reviewCounter = reviewCounter
  if (retriggerUrl) args.retriggerUrl = retriggerUrl
  // SIG-245 / SIG-414 Phase 1.2 (CR #286): carry the 3-way un-reviewed
  // disclosure (policy / oversized / spillover) onto the anchorless-fallback
  // body too, so the 422-retry path never silently drops.
  if (disclosure) args.disclosure = disclosure
  return event === "COMMENT" ? renderCommentBody(args) : renderRequestChangesBody(args)
}
