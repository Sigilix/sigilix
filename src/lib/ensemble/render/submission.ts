// SIG-365 (PR 13) — the review-SUBMISSION render module (render layer).
//
// The GitHub review-submission builders carved VERBATIM from triage-pr-review.ts:
// `prepareReviewSubmissionFindings` (inline-vs-body routing, the SIG-281 Rec 3
// inline-comment cap, the SIG-159 anchor walk-forward, the SIG-103
// structured-fix validation), `buildReviewSubmission` /
// `buildReviewSubmissionWithMetadata`, and the two event-preview helpers. These
// CONSUME the review-event decision (`chooseRenderedEventWithOverride` from
// domain/verdict) — that is render reading domain, the correct arrow — and never
// make the decision themselves.
//
// Dependency rule: imports point inward only — the per-finding render leaf
// (`./finding-format`), the body render module (`./review-body`), the verdict
// domain (`../domain/verdict`), the finding/verdict domain types, and the pure
// diff-positions / pr-stack leaves. It NEVER imports the orchestrator god-file or
// any app/adapter module. The bodies are byte-identical to their HEAD form in
// triage-pr-review.ts; only the import paths and the wrapper are new.

import type { CheckRunAnnotation, SubmitReviewBody, SubmitReviewComment } from "@/src/shared/types/github"
import { deriveSide, isPositionReviewable, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { type StackContext } from "@/src/lib/pr-stack"
import { isSubstantiveAnchorLine, isSubstantiveCodeAnchorLine } from "@/src/shared/util/anchor-lines"
import { hasStructuredFix, isDeletionSuggestion } from "@/src/shared/domain/pr-review-finding"
import type { PrReviewFinding, PrReviewVerdict, CoverageRoles } from "@/src/shared/domain/pr-review-finding"
import {
  chooseRenderedEventWithOverride,
  type ReviewEvent,
  type ReviewEventOverride,
} from "@/src/lib/ensemble/domain/verdict"
import {
  sanitizeVerdictForGitHub,
  sanitizeFindingsForGitHub,
  normalizeTestingFindingForFinalPolicy,
  normalizeFallbackBodyFindings,
  shouldDropUnanchoredTestingFinding,
  findingScope,
  resolveFindingConfidence,
  withLineMovedNote,
  isFindingAnchorable,
  isCommentAnchorable,
  countReplacementLines,
  MAX_SUGGESTED_REPLACEMENT_LINES,
  type BodyFindingLinkContext,
} from "./finding-format"
import {
  formatFindingComment,
  buildBodyOnlyCheckAnnotations,
  renderedSuggestionEmissions,
  type ReviewSuggestionEmission,
} from "./finding-comment"
import {
  renderApproveBody,
  renderCommentBody,
  renderRequestChangesBody,
  type RenderBodyArgs,
  type ProvenanceCtx,
  type DeltaBadgeCounts,
  type ReviewDisclosure,
} from "./review-body"

interface BuildReviewArgs {
  verdict: PrReviewVerdict
  prAuthor: string | null
  headSha: string
  /**
   * Explicit caller override for policy-level blockers that are not
   * represented by inline comments. Most body-only findings render as
   * COMMENT; approval-readiness can still force REQUEST_CHANGES.
   */
  eventOverride?: ReviewEventOverride
  /**
   * ARC-184: Override `Date.now()` for deterministic snapshots in
   * tests. Production callers omit this and the renderer falls back
   * to wall-clock time at submit-render time.
   */
  nowMs?: number
  /**
   * Findings that passed the hallucination guard but cannot be posted as
   * inline comments (GitHub would 422), so they get rolled into the single
   * non-inline dropdown in the review body. Without this, unanchored findings
   * were silently dropped on the success path of the orchestrator (only the
   * submit-fallback path recovered them). CodeRabbit + Sigilix both caught
   * the regression on PR #38.
   *
   * Default `[]` — the common case where every finding anchored
   * cleanly. When non-empty:
   *   - The chosen review event takes ALL findings into account
   *     (anchored + unanchored), so a verdict with only-unanchored
   *     blocking findings doesn't post as APPROVE.
   *   - The body grows with the single non-inline dropdown listing findings
   *     that genuinely cannot be anchored to a line.
   */
  unanchored?: PrReviewFinding[]
  /**
   * ARC-189: per-finding sigilix comment marker, aligned by INDEX
   * with `verdict.findings`. When `findingMarkers[i]` is a non-empty
   * string, it gets appended to the inline comment body on its own
   * line (with a blank line separator) so the cross-PR review-memory
   * capture pipeline can correlate dismissals back to the original
   * finding's category + severity tier.
   *
   * Optional + sparse: callers can pass `null` for findings that
   * shouldn't carry a marker (e.g., synth findings missing
   * provenance source-specialist). Length must equal
   * `verdict.findings.length` when supplied; the renderer reads by
   * index. Default behavior (omitted) is the pre-ARC-189 shape: no
   * marker appended.
   */
  findingMarkers?: ReadonlyArray<string | null>
  /**
   * ARC-182: optional stack context. When the PR is part of a
   * Graphite-style stack, the post-ARC-281 renderer appends a
   * `_(Stacked on #N)_` parenthetical to the summary paragraph.
   * Absent on unstacked PRs (renderer no-ops).
   */
  stack?: StackContext
  /**
   * ARC-281: specialist coverage roster. When supplied, the body
   * renders a `**Coverage:**` line under the heading; when
   * `dispatched ⊃ succeeded`, the line includes the unavailable
   * roles. Omitted when the caller hasn't plumbed this through yet
   * (back-compat).
   */
  coverage?: CoverageRoles
  /**
   * ARC-281: finding-delta counts vs the prior review. When non-
   * null, the REQUEST_CHANGES body renders a `**Δ:**` badge under
   * the heading and appends ` · Δ since last review` to the
   * heading. APPROVE bodies ignore delta (an approval is implicitly
   * "all clear"). `null` or omitted = no delta signal.
   */
  delta?: DeltaBadgeCounts | null
  /**
   * SIG-101: forwarded to the renderer's `reviewCounter` field. See
   * `RenderBodyArgs.reviewCounter`.
   */
  reviewCounter?: number
  /**
   * SIG-101: forwarded to the renderer's `retriggerUrl` field. See
   * `RenderBodyArgs.retriggerUrl`.
   */
  retriggerUrl?: string
  /**
   * SIG-125: the diff's reviewable-position map, used by
   * `formatFindingComment` to decide whether a finding's
   * `suggestedReplacement` can render as a committable ```suggestion
   * (RIGHT side + contiguous reviewable range) or must fall back to a
   * non-committable code snippet. Optional — omitted call sites fall
   * back to the snippet tier. SIG-103's structured-fix validator also
   * needs this map; when omitted, submission keeps the old trust-the-
   * model behavior for routing/back-compat and the renderer still
   * refuses committable suggestion blocks.
   */
  reviewable?: ReviewableMap
  /**
   * SIG-127: per-file map of new-side line number → added-line TEXT
   * (from `buildAddedLineTextByLine`). When supplied, a finding whose
   * anchored added line is NON-substantive (a bare `}`, blank line,
   * structural punctuation) is routed to the review summary BODY (via
   * the `unanchored` rendering path) instead of an inline comment that
   * would land "on an empty line."
   *
   * Back-compat: when omitted, EVERY finding is treated as substantive
   * and anchored inline exactly as before — zero behavior change. A
   * finding whose `(path, line)` isn't present in the map is also
   * treated as substantive (we only move findings we can positively
   * classify as non-substantive).
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  /**
   * SIG-216: when supplied, body-only finding anchors render as
   * clickable `[path:line](https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>)`
   * Markdown links instead of the back-compat inline-code shape
   * (`` `path:line` ``). Forwarded to `RenderBodyArgs.linkContext`.
   * Optional — ensemble callers that haven't plumbed
   * owner/repo through yet keep the inline-code rendering.
   */
  linkContext?: BodyFindingLinkContext
  /** SIG Trust Ledger v0: forwarded to `RenderBodyArgs.trustLedger` (render the
   *  trust layer when OPENCLAW_TRUST_LEDGER=on) + the inline-comment pills. */
  trustLedger?: boolean
  /** SIG-112: forwarded to body renderers + inline comments to show the
   *  collapsible evidence/provenance block when explicitly enabled. */
  showEvidence?: boolean
  /** Trust Ledger: forwarded to `RenderBodyArgs.trustLedgerSuppressed`. */
  trustLedgerSuppressed?: number
  /** SIG-414 Phase 1.2: the honest 3-way un-reviewed disclosure (policy /
   *  oversized / spillover). Forwarded to `RenderBodyArgs.disclosure` so the body
   *  renders three distinct, calm notices instead of one lumped "size budget" one. */
  disclosure?: ReviewDisclosure
  /**
   * SIG-436: forwarded to `prepareReviewSubmissionFindings.anchorPrecision`. When
   * true, the substantive-anchor forward-walk treats a whole-line COMMENT as
   * non-substantive, so a finding the model anchored to the `// comment` line
   * above the bug is re-homed onto the buggy statement. Default OFF (omitted →
   * byte-identical anchoring). Gated by `OPENCLAW_ANCHOR_PRECISION` in the app
   * layer; passed down as a boolean so this render module stays pure.
   */
  anchorPrecision?: boolean
}

/**
 * Translate a parsed verdict into the GitHub review submission body.
 * Approval logic is strict + two-state:
 *   - findings empty → APPROVE
 *   - any findings   → REQUEST_CHANGES
 *
 * Score still sorts/orders findings in the body but no longer changes
 * the verdict. Paired with synchronize-driven re-reviews (PR #28):
 * user pushes fixes → arc re-reviews → if findings now empty, flips
 * to APPROVE. Closed loop, no contradictory APPROVE-with-inline-fixes.
 *
 * Top-level body becomes a sticky summary with confidence + the model's
 * own confidenceReason so a reviewer skimming the PR sees OpenClaw's
 * read at a glance. Pure — exported for tests.
 */
export function buildReviewSubmission(args: BuildReviewArgs): SubmitReviewBody {
  return buildReviewSubmissionWithMetadata(args).submission
}

export interface ReviewSubmissionBuildResult {
  submission: SubmitReviewBody
  bodyOnlyFindings: PrReviewFinding[]
  bodyOnlyAnnotations: CheckRunAnnotation[]
  suggestionEmissions: ReviewSuggestionEmission[]
}

export interface PreparedReviewSubmissionFindings {
  verdict: PrReviewVerdict
  renderVerdict: PrReviewVerdict
  inlineFindings: PrReviewFinding[]
  inlineOriginalIndex: number[]
  // SIG-456: per-inline-finding diff side, aligned 1:1 with `inlineFindings` (and
  // `inlineOriginalIndex`). "RIGHT" unless the finding anchors to a deleted line.
  inlineSides: ("LEFT" | "RIGHT")[]
  unanchored: PrReviewFinding[]
}

// SIG-281 PR B (Rec 3): cap the number of inline review comments a
// single review posts. SIG-392 (2026-06-12): raised 15 → 50 — effectively
// uncapped. The 15-cap was demoting REAL findings to the body summary
// (un-anchored, easy to miss), which artificially suppressed posted recall;
// since precision is gate-controlled (grounding / refute / dedup / class-
// collapse — the recall-prompt audit posted ~0 genuine FP), every real finding
// SHOULD keep its inline thread, not be buried. 50 is NOT a recall limit (no
// real PR surfaces 50 gate-survived findings) — it's a pathological-runaway
// backstop (a malformed synth verdict can't post hundreds of comments). Below
// 50 the behavior is "post every finding inline." Overflow (50+) is still
// demoted to the body, never dropped, prioritized by severity/confidence.
const MAX_INLINE_COMMENTS = 50

// SIG-281 PR B (Rec 5): a finding is "grounded enough to keep inline"
// when it carries a committable fix (suggestedReplacement / deletion) OR
// a customer-visible repro (failureExample). Validator/citation metadata
// (evidenceRefs / evidenceId) is deliberately NOT counted — it is not an
// inline patch or a reproduction the reviewer can act on at the line.
function hasPatchOrRepro(finding: PrReviewFinding): boolean {
  return (
    hasStructuredFix(finding) ||
    (typeof finding.failureExample === "string" && finding.failureExample.trim().length > 0)
  )
}

// SIG-281 PR B (Rec 6 / Kimi K2.6): tag a finding demoted from inline to
// body by the Rec 3 cap so the body renderer can tell the reader WHY it
// is not an inline thread. Reuses the `anchorNote` suffix slot, which
// `renderBodyOnlyFindings` renders after `· score N`. Only cap-overflow
// findings get this note — naturally body-only and confidence-demoted
// findings do not (they were never inline candidates).
function markInlineCapOverflow(finding: PrReviewFinding): PrReviewFinding {
  return { ...finding, anchorNote: "*inline comment cap exceeded; shown here*" }
}

function stripStructuredFix(finding: PrReviewFinding): PrReviewFinding {
  const { kind: _kind, suggestedReplacement: _suggestedReplacement, ...rest } = finding
  return rest
}

function currentAnchoredLines(
  finding: PrReviewFinding,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string[] | null {
  const start = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
  const linesForPath = addedLineTextByLine.get(finding.path)
  if (!linesForPath) return null
  const lines: string[] = []
  for (let line = start; line <= finding.line; line++) {
    const text = linesForPath.get(line)
    if (text === undefined) return null
    lines.push(text)
  }
  return lines
}

function normalizeAnchoredTextForNoopComparison(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "")
}

function validatedStructuredFixForSubmission(
  finding: PrReviewFinding,
  reviewable: ReviewableMap | undefined,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
): PrReviewFinding {
  if (!hasStructuredFix(finding)) return finding
  if (reviewable === undefined || addedLineTextByLine === undefined) return finding
  if (!isFindingAnchorable(finding, reviewable)) return stripStructuredFix(finding)

  const currentLines = currentAnchoredLines(finding, addedLineTextByLine)
  if (currentLines === null) return stripStructuredFix(finding)
  if (isDeletionSuggestion(finding)) return finding

  const replacement = finding.suggestedReplacement
  if (typeof replacement !== "string") return stripStructuredFix(finding)
  if (replacement.trim().length === 0) return stripStructuredFix(finding)
  if (countReplacementLines(replacement) > MAX_SUGGESTED_REPLACEMENT_LINES) {
    return stripStructuredFix(finding)
  }
  if (
    normalizeAnchoredTextForNoopComparison(replacement) ===
    normalizeAnchoredTextForNoopComparison(currentLines.join("\n"))
  ) {
    return stripStructuredFix(finding)
  }
  return finding
}

/**
 * SIG-436 (suggestion path): re-home a STRUCTURED-FIX finding's anchor off a
 * whole-line COMMENT onto the buggy code line below it — BEFORE the suggestion is
 * validated against its anchored line. Structured-fix findings skip the inline
 * substantive-anchor walk (a suggestion's anchor is bound to its replacement), so
 * without this a committable ```suggestion the model anchored to the `// comment`
 * above the bug would post on the comment line.
 *
 * DELIBERATELY narrow + recall-safe (mirrors `applyReanchors` + the SIG-433
 * remap's conservatism):
 *   - only when `anchorPrecision` is on and the finding HAS a structured fix;
 *   - SINGLE-LINE only (`startLine` unset or == `line`) — a multi-line suggestion
 *     range is never moved (its endpoints anchor the replacement span);
 *   - only when the CURRENT anchor is a real added line whose text is a whole-line
 *     comment (`!isSubstantiveCodeAnchorLine` but the line text exists) — an
 *     off-diff or already-substantive anchor is left exactly as-is;
 *   - the target is the nearest SUBSTANTIVE CODE added line forward in window
 *     (`pickSubstantiveAnchorLineForward(..., codeOnly=true)`) and must be
 *     RIGHT-reviewable; no such line → NO move (the finding is unchanged, never
 *     dropped — validation/anchoring then proceed exactly as today).
 *
 * Returns the finding with `line` (and `startLine`, kept single-line) moved, or
 * the finding unchanged. Pure — exported for tests.
 */
export function rehomeSuggestionAnchorForward(
  finding: PrReviewFinding,
  reviewable: ReviewableMap | undefined,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined,
): PrReviewFinding {
  if (addedLineTextByLine === undefined) return finding
  if (!hasStructuredFix(finding)) return finding
  // DELETION suggestions are NEVER re-homed. A deletion renders an empty
  // committable ```suggestion ("delete the anchored line") and `validatedStructuredFixForSubmission`
  // skips the no-op content check for deletions — so moving a comment-targeted
  // deletion onto real code would turn it into a one-click delete of the wrong
  // statement. Only REPLACEMENT suggestions (content-validated against the
  // corrected line below) may re-home.
  if (isDeletionSuggestion(finding)) return finding
  // Single-line suggestions only — never move a multi-line replacement range.
  if (finding.startLine !== undefined && finding.startLine !== finding.line) return finding
  const addedLinesForPath = addedLineTextByLine.get(finding.path)
  if (addedLinesForPath === undefined) return finding
  const currentText = addedLinesForPath.get(finding.line)
  // Only re-home off a real added line that is a whole-line COMMENT — NOT a
  // brace/blank/structural line (the pre-SIG-436 structured-fix shield left those
  // alone, and moving a suggestion off them is out of scope here). A whole-line
  // comment is the line that is substantive by the BASE classifier (so not
  // blank/brace) yet NOT code-substantive (so it's a comment). Off-diff (no text)
  // or an already-code-substantive anchor is left untouched.
  if (currentText === undefined) return finding
  if (!isSubstantiveAnchorLine(currentText)) return finding
  if (isSubstantiveCodeAnchorLine(currentText)) return finding
  const resolved = pickSubstantiveAnchorLineForward(addedLinesForPath, finding.line, undefined, true)
  if (resolved === null || resolved === finding.line) return finding
  if (reviewable !== undefined && deriveSide(reviewable, finding.path, resolved) !== "RIGHT") return finding
  return finding.startLine !== undefined
    ? { ...finding, line: resolved, startLine: resolved }
    : { ...finding, line: resolved }
}

// SIG-281 PR B: carries an inline candidate with its ORIGINAL
// verdict.findings index so the Rec 3 priority sort + cap can reorder /
// truncate WITHOUT decoupling a finding from the index its SIG-247
// marker is keyed by (consumed at the marker lookup ~line 1019).
interface InlineFindingCandidate {
  finding: PrReviewFinding
  originalIndex: number
  confidence: number
  // SIG-456: diff side this comment anchors to. "RIGHT" (added/context) is the
  // default; "LEFT" is a deleted-line finding posted on the deletion side.
  side: "LEFT" | "RIGHT"
}

// SIG-426: exported so the CI-failure-triage synth pass (ci-triage-synth-run.ts)
// can reuse the SAME inline-vs-body routing the PR-review path uses — its
// `inlineFindings` are the anchorable survivors. Callers that pass only
// `reviewable` (no `addedLineTextByLine`, as the CI pass does) must STILL gate
// inline posting on `deriveSide(reviewable, path, line) === "RIGHT"`: without
// `addedLineTextByLine` the substantive-anchor forward-walk is skipped, so a
// line-scoped finding lands in `inlineFindings` regardless of whether its line
// is in the diff. The CI pass does that RIGHT-side check explicitly.
export function prepareReviewSubmissionFindings(args: {
  rawVerdict: PrReviewVerdict
  rawUnanchored: readonly PrReviewFinding[]
  headSha: string
  reviewable?: ReviewableMap
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  /**
   * SIG-436: when true, the substantive-anchor forward-walk uses the STRICTER
   * `isSubstantiveCodeAnchorLine` classifier, which also treats a WHOLE-LINE
   * comment (`// …`, `/* … *​/`, ` * …`, `#`, `{/* … *​/}`) as non-substantive —
   * so a finding the model anchored to the comment line directly ABOVE the bug
   * is re-homed forward onto the buggy code statement it describes. Default
   * `false` → byte-identical to the pre-SIG-436 walk (`isSubstantiveAnchorLine`).
   * Gated by `OPENCLAW_ANCHOR_PRECISION` (parsed in the app layer; this render
   * layer stays pure). Recall-safe: if no substantive code line is in
   * window/range the finding still body-demotes (surfaced, never dropped) and is
   * never anchored to a wrong line.
   */
  anchorPrecision?: boolean
  /**
   * SIG-456: when true, a finding whose anchor line is a DELETED line (LEFT side of
   * the diff) is posted as an inline comment on the deletion side instead of routed
   * to the body. Opt-in so the CI-failure-triage synth consumer (which re-gates RIGHT
   * and builds its own RIGHT payload) stays byte-identical; the PR-review payload
   * builder passes `true`.
   */
  allowDeletedLineAnchor?: boolean
}): PreparedReviewSubmissionFindings {
  const {
    rawVerdict,
    rawUnanchored,
    headSha,
    reviewable,
    addedLineTextByLine,
    anchorPrecision = false,
    allowDeletedLineAnchor = false,
  } = args
  const sanitizedVerdict = sanitizeVerdictForGitHub(rawVerdict)
  const verdict: PrReviewVerdict = {
    ...sanitizedVerdict,
    findings: sanitizedVerdict.findings.map(normalizeTestingFindingForFinalPolicy),
  }
  const sanitizedUnanchored = sanitizeFindingsForGitHub(rawUnanchored)
    .map(normalizeTestingFindingForFinalPolicy)
    .filter((finding) => !shouldDropUnanchoredTestingFinding(finding))

  const inlineCandidates: InlineFindingCandidate[] = []
  const bodyFindings: PrReviewFinding[] = []
  verdict.findings.forEach((rawFinding, i) => {
    // SIG-436 (suggestion path): re-home a single-line structured-fix finding off
    // a whole-line comment onto the buggy code line BEFORE validation, so the
    // suggestion's no-op / contiguous-range checks run against the corrected line.
    // No-op unless `anchorPrecision` is on and the current anchor is a comment
    // with a substantive code line forward in window (else returns `rawFinding`).
    const f = anchorPrecision ? rehomeSuggestionAnchorForward(rawFinding, reviewable, addedLineTextByLine) : rawFinding
    const validatedFinding = validatedStructuredFixForSubmission(f, reviewable, addedLineTextByLine)
    const structuredFixWasStripped = hasStructuredFix(f) && !hasStructuredFix(validatedFinding)
    const hasSuggestion = hasStructuredFix(validatedFinding)
    const scope = findingScope(validatedFinding)
    // SIG-281 PR B (Rec 5): resolve per-finding confidence once, up front,
    // for the severity/confidence routing gate below. `verdict.confidence`
    // is parse-guaranteed 1-5.
    const confidence = resolveFindingConfidence(validatedFinding, verdict.confidence)
    const findingForInline =
      hasSuggestion && scope !== "line" ? { ...validatedFinding, scope: "line" as const } : validatedFinding

    // SIG-127 wins over broad scope: a localized suggestedReplacement
    // or empty deletion suggestion needs an inline review thread or the
    // proposed fix disappears from the customer-visible review body.
    // Treat that shape as line-scoped even if the model supplied a
    // broader scope.
    // SIG-202: GitHub inline review comments are for exact line
    // anchors. Review-level, file-level, and comment-event findings stay
    // in the body even if they carry a nearby line for context.
    if (scope !== "line" && !hasSuggestion) {
      if (shouldDropUnanchoredTestingFinding(validatedFinding)) return
      bodyFindings.push(validatedFinding)
      return
    }

    // SIG-456: deleted-line finding → anchor on the LEFT (deletion) side and keep it
    // inline instead of body-routing. The added-line substantive forward-walk below is
    // RIGHT-only (reads new-file added-line text), so a deleted-line finding would always
    // fail it and demote to the body. Validate the LEFT endpoint directly with
    // isPositionReviewable (deriveSide prefers RIGHT on an ambiguous same-numbered line).
    // Opt-in via `allowDeletedLineAnchor` so the CI-synth consumer stays RIGHT-only.
    // A line that exists on BOTH sides (a replaced/collision line) defaults to RIGHT
    // (deriveSide prefers RIGHT). SIG-463: a finding `snapFindingLineToDeletedCode`
    // re-pointed to a deleted line carries an explicit `anchorSide:"LEFT"` — honor it
    // even on such a collision (the removed code is what it's about), gated on the
    // LEFT position actually being reviewable. Without the explicit signal, only a
    // LEFT-exclusive deleted line (deriveSide === "LEFT") takes the LEFT path.
    if (
      allowDeletedLineAnchor &&
      reviewable !== undefined &&
      (deriveSide(reviewable, findingForInline.path, findingForInline.line) === "LEFT" ||
        findingForInline.anchorSide === "LEFT") &&
      isPositionReviewable(reviewable, findingForInline.path, findingForInline.line, "LEFT")
    ) {
      inlineCandidates.push({ finding: findingForInline, originalIndex: i, confidence, side: "LEFT" })
      return
    }

    const addedLinesForPath = addedLineTextByLine?.get(findingForInline.path)
    let effective: PrReviewFinding = findingForInline
    const lineIsReviewable =
      reviewable !== undefined && deriveSide(reviewable, findingForInline.path, findingForInline.line) === "RIGHT"
    const needsSubstantiveAnchorValidation =
      addedLineTextByLine !== undefined && !hasSuggestion && (!structuredFixWasStripped || !lineIsReviewable)
    if (needsSubstantiveAnchorValidation) {
      // Walk forward to the nearest SUBSTANTIVE added line so an in-diff finding
      // whose anchor landed on a brace/blank stays INLINE on real code instead of
      // demoting to the body. For THIS anchoring step, fall back to the body only
      // when there's no substantive added line at/after the anchor. (The other
      // body-routing path below — the inline-comment cap overflow — can still body-route.)
      // SIG-436: with `anchorPrecision`, a whole-line COMMENT is also non-substantive,
      // so a finding anchored to the `// comment` above the bug walks onto the bug.
      // NOTE: findings carrying a structured fix (`hasSuggestion`) skip THIS walk
      // (the `!hasSuggestion` guard above) — their comment-anchor re-home is handled
      // separately and more conservatively by `rehomeSuggestionAnchorForward` (run
      // at the top of this loop), which only moves a SINGLE-LINE suggestion and
      // re-validates the replacement against the corrected line.
      const resolved = pickSubstantiveAnchorLineForward(
        addedLinesForPath,
        findingForInline.line,
        findingForInline.startLine,
        anchorPrecision,
      )
      const resolvedIsRightAnchor =
        resolved !== null &&
        (reviewable === undefined || deriveSide(reviewable, findingForInline.path, resolved) === "RIGHT")
      if (resolvedIsRightAnchor) {
        // Preferred: the walk found a substantive ADDED line that's a valid RIGHT anchor (SIG-436
        // anchor-exactness — moves a brace/blank/comment anchor onto the real code).
        if (resolved !== findingForInline.line) {
          const { startLine: _drop, ...rest } = findingForInline
          effective = { ...rest, line: resolved }
        }
      } else if (
        lineIsReviewable &&
        validatedFinding.category !== "testing" &&
        !(addedLinesForPath?.has(findingForInline.line) ?? false)
      ) {
        // SIG-451 (benchmark #29): the added-line walk found no usable substantive ADDED line, but the
        // finding's OWN line is RIGHT-reviewable — a context/unchanged line inside the diff hunk, which
        // GitHub DOES accept as an inline-comment anchor. Keep it INLINE on its own line instead of
        // burying it in a collapsed body dropdown (the dominant "found-but-bodied" recall leak: subtle
        // logic bugs anchor to a context line with no nearby `+` line). `effective` already ===
        // findingForInline, so no reassignment — we just fall through to the inline path. This never
        // demotes a real finding; it only UPGRADES a would-be-bodied one to inline.
        //
        // CONTEXT-LINE ONLY (`!addedLinesForPath.has(line)`): if the own line is an ADDED line that the
        // walk already rejected as non-substantive (a bare brace/blank/comment with no substantive code
        // after it), keep SIG-127/SIG-436's body-demotion — do NOT re-anchor an inline comment onto a
        // bad added line. Only a true context (unchanged) line gets the inline upgrade. (Codex review.)
        //
        // EXCLUDES `category:"testing"` findings: SIG-222 keeps tests-lane findings inline-ONLY when they
        // substantively anchor (else drop a missing-sibling, body-route coverage evidence). A context
        // line is not a valid testing anchor, so testing findings fall through to the drop/body path below.
      } else {
        // No usable substantive added anchor AND the own line isn't a valid inline target (off-diff /
        // LEFT-only) → body, as before.
        if (shouldDropUnanchoredTestingFinding(validatedFinding)) return
        bodyFindings.push(withLineMovedNote(validatedFinding, headSha))
        return
      }
    }

    // SIG-411 (founder 2026-06-14): the SIG-281 Rec 2/5 confidence-tier body
    // demotion was REMOVED. In prod the trust ledger stamps every anchored,
    // gate-surviving finding a `grounded-model` baseline, so demoting by the
    // model's self-reported confidence buried real, GROUNDED findings (e.g. a
    // P3 on PR #540) in the body where they were easy to miss. Precision is
    // controlled upstream by the grounding / refute / dedup / class-collapse
    // gates (SIG-392) — a finding that anchors AND survives them keeps its inline
    // thread regardless of confidence. P0/P1 (score >= 4) were never demoted
    // here anyway. Do NOT re-introduce a confidence-only demotion.

    // The forward-walk above already guaranteed a SUBSTANTIVE anchor line (or
    // routed to the body), so a separate non-substantive demotion is no longer
    // needed — the finding keeps its inline thread.
    inlineCandidates.push({ finding: effective, originalIndex: i, confidence, side: "RIGHT" })
  })

  // SIG-281 PR B (Rec 3): cap inline comments at MAX_INLINE_COMMENTS.
  // SELECT which findings keep their inline thread by priority (don't
  // plain-truncate — keep the highest-severity / highest-confidence /
  // best-grounded), but then restore ORIGINAL order for the kept set so
  // we never reorder inline comments when under the cap (the common
  // case stays byte-identical to pre-PR-B). Overflow is demoted to the
  // body, NEVER dropped. The {finding, originalIndex} pairing keeps the
  // SIG-247 marker invariant intact (inlineFindings[j] <->
  // verdict.findings[inlineOriginalIndex[j]]). The originalIndex
  // tiebreak makes the priority selection fully deterministic.
  let kept: InlineFindingCandidate[] = inlineCandidates
  if (inlineCandidates.length > MAX_INLINE_COMMENTS) {
    const prioritized = [...inlineCandidates].sort(
      (a, b) =>
        b.finding.score - a.finding.score ||
        b.confidence - a.confidence ||
        Number(hasPatchOrRepro(b.finding)) - Number(hasPatchOrRepro(a.finding)) ||
        a.originalIndex - b.originalIndex,
    )
    const keptIndices = new Set(prioritized.slice(0, MAX_INLINE_COMMENTS).map((c) => c.originalIndex))
    kept = inlineCandidates.filter((c) => keptIndices.has(c.originalIndex))
    for (const candidate of inlineCandidates) {
      if (!keptIndices.has(candidate.originalIndex)) {
        bodyFindings.push(markInlineCapOverflow(candidate.finding))
      }
    }
  }

  const inlineFindings: PrReviewFinding[] = kept.map((c) => c.finding)
  const inlineOriginalIndex: number[] = kept.map((c) => c.originalIndex)
  const inlineSides: ("LEFT" | "RIGHT")[] = kept.map((c) => c.side)
  const renderVerdict: PrReviewVerdict = { ...verdict, findings: inlineFindings }
  const unanchored: PrReviewFinding[] = [...sanitizedUnanchored, ...bodyFindings]

  return {
    verdict,
    renderVerdict,
    inlineFindings,
    inlineOriginalIndex,
    inlineSides,
    unanchored,
  }
}

export interface PreviewReviewSubmissionEventArgs {
  verdict: PrReviewVerdict
  headSha: string
  unanchored?: readonly PrReviewFinding[]
  reviewable?: ReviewableMap
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  eventOverride?: ReviewEventOverride
  /** SIG-436: forwarded to `prepareReviewSubmissionFindings` so the previewed
   *  event matches the built submission's inline/body split under the flag. */
  anchorPrecision?: boolean
}

export function previewReviewSubmissionEvent({
  verdict: rawVerdict,
  headSha,
  unanchored: rawUnanchored = [],
  reviewable,
  addedLineTextByLine,
  eventOverride,
  anchorPrecision,
}: PreviewReviewSubmissionEventArgs): ReviewEvent {
  const prepared = prepareReviewSubmissionFindings({
    rawVerdict,
    rawUnanchored,
    headSha,
    ...(reviewable !== undefined ? { reviewable } : {}),
    ...(addedLineTextByLine !== undefined ? { addedLineTextByLine } : {}),
    ...(anchorPrecision !== undefined ? { anchorPrecision } : {}),
  })
  return chooseRenderedEventWithOverride(
    {
      inlineFindings: prepared.inlineFindings,
      bodyOnlyFindings: prepared.unanchored,
    },
    eventOverride,
  )
}

export interface PreviewFallbackSubmissionEventArgs {
  verdict: PrReviewVerdict
  unanchored: readonly PrReviewFinding[]
  eventOverride?: ReviewEventOverride
}

export function previewFallbackSubmissionEvent({
  verdict: rawVerdict,
  unanchored: rawUnanchored,
  eventOverride,
}: PreviewFallbackSubmissionEventArgs): ReviewEvent {
  const verdict = sanitizeVerdictForGitHub(rawVerdict)
  const unanchored = sanitizeFindingsForGitHub(rawUnanchored)
  const all = normalizeFallbackBodyFindings([...verdict.findings, ...unanchored])
  return chooseRenderedEventWithOverride(
    {
      inlineFindings: [],
      bodyOnlyFindings: all,
    },
    eventOverride,
  )
}

export function buildReviewSubmissionWithMetadata({
  verdict: rawVerdict,
  // `prAuthor` is still part of the public args shape (older
  // call sites pass it) but ARC-281's renderers don't take it —
  // the Kimi redesign dropped per-author dialogue from the body.
  prAuthor: _prAuthor,
  headSha,
  unanchored: rawUnanchored = [],
  nowMs,
  findingMarkers,
  stack,
  coverage,
  delta,
  reviewCounter,
  retriggerUrl,
  reviewable,
  addedLineTextByLine,
  eventOverride,
  linkContext,
  trustLedger,
  showEvidence,
  trustLedgerSuppressed,
  disclosure,
  anchorPrecision,
}: BuildReviewArgs): ReviewSubmissionBuildResult {
  const { verdict, renderVerdict, inlineFindings, inlineOriginalIndex, inlineSides, unanchored } =
    prepareReviewSubmissionFindings({
      rawVerdict,
      rawUnanchored,
      headSha,
      // SIG-456: the PR-review payload posts LEFT-side comments on deleted lines.
      allowDeletedLineAnchor: true,
      ...(reviewable !== undefined ? { reviewable } : {}),
      ...(addedLineTextByLine !== undefined ? { addedLineTextByLine } : {}),
      // SIG-436: forward the (default-off) anchor-precision flag so the
      // substantive-anchor walk can skip a whole-line comment above the bug.
      ...(anchorPrecision !== undefined ? { anchorPrecision } : {}),
    })
  const event = chooseRenderedEventWithOverride(
    {
      inlineFindings,
      bodyOnlyFindings: unanchored,
    },
    eventOverride,
  )

  const prov: ProvenanceCtx = nowMs !== undefined ? { headSha, nowMs } : { headSha }
  // ARC-281: dispatch directly to the new renderers instead of
  // routing through the legacy `formatReviewBody`. Posture is set by
  // `chooseReviewEvent` above.
  const renderArgs: RenderBodyArgs = { verdict: renderVerdict, unanchored, prov }
  if (stack !== undefined) renderArgs.stack = stack
  if (coverage) renderArgs.coverage = coverage
  if (delta !== undefined) renderArgs.delta = delta
  // SIG-101: thread counter + retrigger URL through to the renderer.
  // APPROVE bodies stay marker-only (per SIG-94) and ignore these
  // fields, but it's cheaper / clearer to forward them unconditionally.
  if (typeof reviewCounter === "number") renderArgs.reviewCounter = reviewCounter
  if (retriggerUrl) renderArgs.retriggerUrl = retriggerUrl
  // SIG-216: forward linkContext so body-only finding anchors render
  // as clickable GitHub blob URLs. Omitted callers fall through to
  // the back-compat inline-code anchor.
  if (linkContext) renderArgs.linkContext = linkContext
  // SIG Trust Ledger v0: forward the render flag + the suppressed count.
  if (trustLedger) renderArgs.trustLedger = true
  if (showEvidence) renderArgs.showEvidence = true
  if (typeof trustLedgerSuppressed === "number") renderArgs.trustLedgerSuppressed = trustLedgerSuppressed
  // SIG-414 Phase 1.2: forward the 3-way un-reviewed disclosure (policy /
  // oversized / spillover). The renderers (incl. renderApproveBody) read it.
  if (disclosure) renderArgs.disclosure = disclosure
  const body =
    event === "APPROVE"
      ? renderApproveBody(renderArgs)
      : event === "COMMENT"
        ? renderCommentBody(renderArgs)
        : renderRequestChangesBody(renderArgs)
  const comments: SubmitReviewComment[] = inlineFindings.map((f, i) => {
    // ARC-189: append per-finding sigilix marker on its own line so
    // the cross-PR review-memory capture pipeline can correlate
    // future reply dismissals back to this finding's category + tier.
    // Marker is hidden HTML — invisible in rendered Markdown but
    // visible to the marker extractor. Sparse: nullish entries skip.
    //
    // SIG-127: `findingMarkers` is indexed by the ORIGINAL
    // `verdict.findings` index, so look it up via the carried original
    // index — NOT the filtered array's index, which would shift after
    // any body-routed finding.
    const marker = findingMarkers?.[inlineOriginalIndex[i] ?? i]
    // SIG-101: resolve per-finding confidence (verdict-level fallback)
    // and pass to the formatter so the inline comment carries the
    // P0/P1/P2 badge + `confidence: N/5` suffix.
    const confidence = resolveFindingConfidence(f, verdict.confidence)
    const baseBody = formatFindingComment(f, confidence, reviewable, addedLineTextByLine, trustLedger, showEvidence)
    const fullBody = marker ? `${baseBody}\n\n${marker}` : baseBody
    // SIG-456: anchor on the side prepareReviewSubmissionFindings derived (LEFT for a
    // deleted-line finding); default RIGHT for the test/fallback path with no sides.
    const side = inlineSides[i] ?? "RIGHT"
    const c: SubmitReviewComment = {
      path: f.path,
      line: f.line,
      side,
      body: fullBody,
    }
    // SIG-164 PR 5: emit `start_line` only when both endpoints survive
    // the lax comment-anchor check (`isCommentAnchorable`). This is
    // separate from `isFindingAnchorable` (which gates committable
    // ```suggestion blocks via the stricter contiguous-RIGHT check).
    // GitHub's multi-line comment endpoints must both be on the diff;
    // in-between lines can be context within the hunk.
    //
    // When `reviewable` isn't supplied (test paths / fallback), keep
    // the prior trust-the-model behavior (emit `start_line` as
    // model-given). Production paths always pass `reviewable`.
    const emitStartLine =
      f.startLine != null &&
      (reviewable === undefined || isCommentAnchorable(reviewable, f.path, f.startLine, f.line, side))
    if (emitStartLine && f.startLine != null) {
      c.start_line = f.startLine
      c.start_side = side
    }
    return c
  })
  const submission: SubmitReviewBody = {
    event,
    body,
    commit_id: headSha,
  }
  if (comments.length > 0) submission.comments = comments
  return {
    submission,
    bodyOnlyFindings: unanchored,
    bodyOnlyAnnotations: buildBodyOnlyCheckAnnotations(unanchored),
    suggestionEmissions: renderedSuggestionEmissions(comments),
  }
}

/**
 * SIG-159 PR1 (anchor walk-forward): when a finding's anchor line isn't
 * an added line on its file (the model anchored to a context line — e.g.
 * the bare `}` closing the block ABOVE the new code it actually means to
 * comment on), search forward for the nearest added line on the same
 * file and return that as the resolved anchor.
 *
 * Returns:
 *   - `requestedLine` itself if it's already in `addedLinesForPath`
 *     (fast path — model anchored to a real added line).
 *   - The smallest line number > `requestedLine` that IS in the map.
 *   - `null` when the map is absent for the file, OR when no added line
 *     exists at or after `requestedLine` (caller routes to summary).
 *
 * Why forward, not backward (Codex/DeepSeek 2026-05-23 review): the
 * SIG-127 regression observed on PR #138 anchored at line 960 (a `}`
 * closing the prior `queue` block). The actual subject of the finding
 * — the new `scheduled` handler — was lines 975-987, BELOW the brace.
 * Walking backward would land on unrelated code in the prior block.
 *
 * Pure — exported for tests.
 */
export function pickAnchorLineForward(
  addedLinesForPath: ReadonlyMap<number, string> | undefined,
  requestedLine: number,
): number | null {
  if (addedLinesForPath === undefined) return null
  if (addedLinesForPath.has(requestedLine)) return requestedLine
  let best: number | null = null
  for (const line of addedLinesForPath.keys()) {
    if (line > requestedLine && (best === null || line < best)) {
      best = line
    }
  }
  return best
}

/**
 * Like `pickAnchorLineForward`, but SKIPS non-substantive added lines (blank, a
 * lone `}` / `)` / `;`) to land on the nearest SUBSTANTIVE added line at or after
 * `requestedLine`. Completes SIG-159's forward-walk: the model often anchors to
 * the brace ABOVE the code it means, and the nearest added line can itself be
 * that brace — previously the finding then demoted to the body. Walking to the
 * nearest substantive added line keeps it INLINE on real code instead (CodeRabbit
 * parity for anchor-quality routing). Returns null when no
 * substantive added line exists at/after the anchor WITHIN the forward window
 * (genuinely outside the meaningful diff → caller routes to the body). Pure —
 * exported for tests.
 *
 * The forward window (`MAX_SUBSTANTIVE_ANCHOR_WALK`) bounds the walk so a finding
 * can't be inline-anchored to unrelated code an arbitrary distance away (e.g. a
 * trailing `}` whose next substantive added line is in a different hunk) — a
 * confidently-wrong inline comment is worse than a body finding. SIG-159's
 * motivating case (the `}` above the real subject) is only a handful of lines,
 * so a small cap keeps that case inline while preventing cross-hunk drift.
 *
 * Optional `rangeStartLine`: when the model emitted an explicit multi-line
 * range and the forward walk finds nothing (the primary `line` landed on a
 * trailing blank/brace at the range's bottom), fall back to the nearest
 * substantive added line WITHIN [rangeStartLine..requestedLine] instead of
 * demoting the finding to the body — bounded by the model's own asserted
 * range, so it can't drift to unrelated code. Recall-safe (body → inline only).
 *
 * SIG-436 `codeOnly`: when true the walk uses the stricter
 * `isSubstantiveCodeAnchorLine` — a whole-line COMMENT (`// …`, `/* … *​/`,
 * ` * …`, `{/* … *​/}`) is also non-substantive, so a finding the model anchored
 * to the `// comment` line directly above the bug is re-homed forward onto the
 * buggy code statement the comment annotates. Default false → byte-identical
 * pre-SIG-436 behavior (a comment counts as substantive and stops the walk).
 */
export const MAX_SUBSTANTIVE_ANCHOR_WALK = 25
export function pickSubstantiveAnchorLineForward(
  addedLinesForPath: ReadonlyMap<number, string> | undefined,
  requestedLine: number,
  rangeStartLine?: number,
  codeOnly = false,
): number | null {
  if (addedLinesForPath === undefined) return null
  const isSubstantive = codeOnly ? isSubstantiveCodeAnchorLine : isSubstantiveAnchorLine
  let best: number | null = null
  for (const [line, text] of addedLinesForPath) {
    if (
      line >= requestedLine &&
      line - requestedLine <= MAX_SUBSTANTIVE_ANCHOR_WALK &&
      isSubstantive(text) &&
      (best === null || line < best)
    ) {
      best = line
    }
  }
  if (best !== null) return best
  // Range-bounded backward fallback. When the model emitted an explicit
  // multi-line range [rangeStartLine..requestedLine] and the forward walk
  // found nothing substantive (the primary `line` landed on a trailing
  // blank/brace at the range's bottom edge, with no substantive added line
  // AFTER it), anchor INLINE to the nearest substantive added line WITHIN the
  // model's own asserted range instead of demoting the whole finding to the
  // body. Bounded by `rangeStartLine`, so — unlike an open backward walk
  // (Codex/DeepSeek 2026-05-23: avoid drift to unrelated code) — it can only
  // land inside the range the model itself claimed, never an arbitrary
  // distance away. Picks the line CLOSEST to the bottom (the primary anchor
  // intent). Recall-safe: only converts a body demotion into an inline anchor.
  if (rangeStartLine !== undefined && rangeStartLine < requestedLine) {
    let backBest: number | null = null
    for (const [line, text] of addedLinesForPath) {
      if (
        line >= rangeStartLine &&
        line < requestedLine &&
        isSubstantive(text) &&
        (backBest === null || line > backBest)
      ) {
        backBest = line
      }
    }
    if (backBest !== null) return backBest
  }
  return null
}
