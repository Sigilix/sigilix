// Proactive primary review (greptile-style). Reviews the PR in
// isolation — does its own pass independent of CR or any other
// reviewer. Each finding carries a review surface scope, score 1-5,
// and category (logic / style / security / etc.) that is rendered in
// inline-comment metadata for scanability.
//
// Submits a single review via POST /pulls/{n}/reviews so all findings
// arrive as one coherent unit on GitHub. Approval state is derived from
// the max finding score:
//
//   findings empty   → APPROVE
//   any findings     → REQUEST_CHANGES
//
// Strict, two-state. Paired with synchronize-driven re-reviews
// (PR #28): user pushes fixes → arc re-reviews → if findings now
// empty, flips to APPROVE. The closed loop replaces the previous
// "APPROVE with score-3 nits posted as advisory inline comments,"
// which read as contradictory (green check + 'fix this' comments).
//
// Triggers (wired in src/index.ts):
//   pull_request.opened              first review pass when PR opens
//   pull_request.synchronize         re-run after each push
//
// Dedupe is keyed on (prNumber, headSha) — same head sha + same PR =
// skip. New push = new sha = re-runs.

// ARC-280: pure-helper-only module. Imports trimmed to the
// surface still used by `buildReviewSubmission`,
// `buildFallbackSubmission`, the ARC-281 body renderers
// (`renderApproveBody` / `renderRequestChangesBody`),
// `parsePrReviewResponse`, and the related sanitizers.
import {
  type CheckRunAnnotation,
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { SIGILIX_BOT_LOGIN } from "./dismiss-prior-reviews"
import {
  isContiguousRightRange,
  deriveSide,
  type ReviewableMap,
} from "./diff-positions"
import { parseFirstJsonObject } from "./json-extract"
import { type StackContext } from "./pr-stack"
import { badgeAssetLabel, badgeAssetUrl, type ReviewBadgeAssetName } from "./badge-assets"
import { remediationForFinding } from "./validate-security-finding"
// `renderStackContextSummary` is no longer used here — ARC-281
// replaced the multi-line stack block with a one-line parenthetical
// rendered by `renderStackParenthetical`. The original helper still
// lives in `pr-stack-prompt.ts` for any non-review-body callers that
// may still want the verbose form.

// ARC-280: `handlePrReview` (Phase 3 single-shot reviewer) deleted.
// ARC-281: `formatReviewBody` deleted — `renderApproveBody` and
// `renderRequestChangesBody` are the new body entry points.
//
// This file now exports ONLY the pure helpers the ensemble still
// uses — `buildReviewSubmission`, `buildFallbackSubmission`,
// `renderApproveBody`, `renderRequestChangesBody`, `chooseReviewEvent`,
// `parsePrReviewResponse`, `wrapInlineHtmlTags`, `renderFixPlan` —
// plus the shared types (`PrReviewFinding`, `PrReviewVerdict`,
// `FindingCategory`, `StackOrigin`, `ProvenanceCtx`, `CoverageRoles`,
// `DeltaBadgeCounts`, `RenderBodyArgs`). The `buildPrReviewDedupeKey`
// helper + the `pr-review:` dedupe-key family are gone with
// Phase 3 — the ensemble has its own coalesce.

// ARC-280: `LIMITS` + `truncate` were Phase-3-internal — used by
// `buildPrompt` to cap diff / body / CR-comments blocks before
// sending to the single-shot model. The ensemble has its own
// per-specialist hunk packing (`packFilesIntoBatches` in
// `diff-packing.ts`) and doesn't need this. Deleted with Phase 3.

/**
 * SIG-161 PR 4a: widened from the legacy two-state `"APPROVE" |
 * "REQUEST_CHANGES"` to three states by adding `"COMMENT"`.
 *
 * `"COMMENT"` is a real GitHub review event (POST /pulls/{n}/reviews
 * `event: "COMMENT"`) — posts inline comments without taking a
 * verdict. The legacy `chooseReviewEvent` never returns it; only the
 * new `chooseReviewEventWithGate` does, and only for findings whose
 * `gateScore` falls in the borderline band
 * `[FLOOR_SUPPRESS, chosenThreshold)`. See DESIGN.md §4.
 *
 * Exported (was previously file-local) because PR 4b's flag wrapper
 * + the renderer body builders need to switch on the widened union.
 */
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
export type ReviewEventOverride = Extract<ReviewEvent, "REQUEST_CHANGES">

/**
 * ARC-156 follow-up (rubberfit PR #232 catch): the model occasionally
 * emits literal HTML/JSX tag references in prose without wrapping
 * them in backticks (e.g., "redesigns cmdk shortcuts with per-key
 * <kbd> boxes…"). GitHub renders the markdown body as HTML, and an
 * unclosed `<kbd>` opens a real DOM element that wraps the rest of
 * the paragraph in monospace — producing a code-block-like glitch
 * in the rendered review.
 *
 * This helper wraps any un-backticked `<tag>` pattern in backticks
 * so GitHub renders the tag as inline code. The negative lookbehind/
 * lookahead skip tags that the model already wrapped in backticks
 * (avoids producing double-backticks like ``<Link>``).
 *
 * Paired with the prompt-level rule in `SHARED_NEGATIVE_CONSTRAINTS`
 * which tells the model to wrap tags in backticks itself — this
 * renderer-level wrap is the backstop for the prose that slips
 * through.
 *
 * Pure — exported for unit tests.
 */
const INLINE_HTML_TAG_RE = /(?<!`)(<\/?[A-Za-z][^<>`\n]*?>)(?!`)/g

export function wrapInlineHtmlTags(s: string): string {
  if (!s || s.indexOf("<") === -1) return s
  return s.replace(INLINE_HTML_TAG_RE, "`$1`")
}

/**
 * Apply `wrapInlineHtmlTags` to every prose field on a verdict so
 * downstream renderers see GitHub-safe markdown. Pure.
 */
function sanitizeVerdictForGitHub(v: PrReviewVerdict): PrReviewVerdict {
  return {
    ...v,
    summary: wrapInlineHtmlTags(v.summary),
    confidenceReason: wrapInlineHtmlTags(v.confidenceReason),
    findings: v.findings.map(sanitizeFindingForGitHub),
  }
}

function sanitizeFindingsForGitHub(
  findings: ReadonlyArray<PrReviewFinding>,
): PrReviewFinding[] {
  return findings.map(sanitizeFindingForGitHub)
}

function sanitizeFindingForGitHub(f: PrReviewFinding): PrReviewFinding {
  const sanitized: PrReviewFinding = {
    ...f,
    headline: wrapInlineHtmlTags(f.headline),
    body: wrapInlineHtmlTags(f.body),
  }
  if (f.failureExample) sanitized.failureExample = f.failureExample
  if (f.fixExample) sanitized.fixExample = f.fixExample
  if (f.testGap) sanitized.testGap = wrapInlineHtmlTags(f.testGap)
  return sanitized
}

export type FindingCategory =
  | "logic"
  | "security"
  | "performance"
  | "error-handling"
  | "testing"
  | "complexity"
  | "style"
  | "syntax"
  | "docs"

export const FINDING_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  "logic",
  "security",
  "performance",
  "error-handling",
  "testing",
  "complexity",
  "style",
  "syntax",
  "docs",
])

/**
 * ARC-182: stack-origin tag attached to findings on Graphite-style
 * stacked PRs. Optional — absent on unstacked PRs. See
 * `src/lib/pr-stack.ts` for the detection logic.
 */
export type StackOrigin = "current-pr" | "downstack-context" | "upstack-followup"

export const STACK_ORIGINS: ReadonlySet<StackOrigin> = new Set([
  "current-pr",
  "downstack-context",
  "upstack-followup",
])

export type ReviewFindingScope = "line" | "file" | "pr" | "comment"

export const REVIEW_FINDING_SCOPES: ReadonlySet<ReviewFindingScope> = new Set([
  "line",
  "file",
  "pr",
  "comment",
])

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  /**
   * SIG-202: where the finding belongs in GitHub's review surfaces.
   * Missing is treated as "line" for backwards compatibility.
   *
   *   - "line"    — exact changed line is the subject; render inline.
   *   - "file"    — file/module-level concern; render in review body.
   *   - "pr"      — PR-level/cross-file concern; render in review body.
   *   - "comment" — webhook/comment/review-event concern; body only.
   */
  scope?: ReviewFindingScope
  score: number
  category: FindingCategory
  headline: string
  body: string
  /**
   * Structured details: optional concrete example proving the finding. Intended
   * for minimal repro input/output, runtime exception text, parser
   * examples, or other compact evidence that is clearer in a fenced
   * block than prose. Raw text/code only — the renderer adds fences.
   */
  failureExample?: string
  /**
   * Structured details: optional non-committable fix shape. Used when an exact
   * contiguous GitHub suggestion is unsafe but a small snippet helps
   * the reviewer understand the intended direction. Raw code/text only
   * — `suggestedReplacement` remains the only one-click patch field.
   */
  fixExample?: string
  /**
   * Structured details: optional one-sentence explanation of why existing tests or
   * checks missed the issue. Only populated when the model has concrete
   * test/CI evidence; the renderer labels it explicitly.
   */
  testGap?: string
  /**
   * ARC-182: optional stack-origin tag. Emitted only when the input
   * prompt included a [STACK CONTEXT] block; absent for unstacked PRs.
   * Schema-bypass paths with an unknown value normalize to "current-pr".
   */
  stackOrigin?: StackOrigin
  /**
   * Renderer-only note for findings that had to move out of an inline
   * GitHub review comment because the original line no longer anchors
   * cleanly at the reviewed head.
   */
  anchorNote?: string
  /**
   * SIG-101: per-finding model confidence on a 1-5 scale (distinct from
   * `score`, which is severity). The synth specialist may emit a
   * per-finding confidence; when absent, callers default to the
   * verdict-level `confidence` field via `resolveFindingConfidence`
   * so every finding has a value downstream. `formatFindingComment`
   * preserves confidence in a hidden marker for tooling and wraps
   * low-confidence (≤2) bodies in a collapsed `<details>` block so
   * noisy findings de-emphasize.
   */
  confidence?: number
  /**
   * SIG-113: file paths the specialist inspected while forming the
   * finding. Populated by the tests specialist from the
   * [TESTING EVIDENCE] block's `inspectedTestFiles` list. Used by
   * `evaluateTestingFindingCitation` to drop "missing tests" findings
   * where the specialist never actually looked at any test file
   * (the PR #110 / PR #111 FP class).
   *
   * Absent on findings from specialists that don't yet emit this
   * field — back-compat with the staged rollout. Other roles may
   * adopt the same field for SIG-108 / SIG-109 / SIG-110.
   */
  inspectedTestFiles?: string[]
  /**
   * SIG-113: references into the role-scoped evidence block backing
   * the finding. Format is `<kind>:<value>` — e.g.
   *   "siblingMapping:src/lib/foo.ts->NONE"   (no test sibling exists)
   *   "inspectedTestFile:tests/foo.test.ts"   (specialist read this file)
   *   "secretScan:SCN-42"                     (security evidence ID)
   *   "depVuln:CVE-2025-1234"                 (security evidence ID)
   *
   * Used by the per-role validators (SIG-113 for testing,
   * SIG-108/109/110 for security/logic/perf) to require concrete
   * citations on high-severity or absence-claiming findings.
   */
  evidenceRefs?: string[]
  /**
   * SIG-108: CWE identifier backing a security finding (e.g. "CWE-89").
   * `validateSecurityFinding` requires it on score>=4 security findings
   * in scanner-covered buckets; absent findings are auto-enriched from a
   * matching deterministic fact when possible, else dropped. Absent on
   * non-security findings and on specialists not yet on the new prompt.
   */
  cweId?: string
  /**
   * SIG-108: verbatim copy of a deterministic security fact's id
   * ("tool:rule-id:hash:line"), or the literal "NONE" for access-control
   * findings no scanner can detect (paired with a body justification).
   * Cross-checked against the security fact manifest by
   * `validateSecurityFinding`.
   */
  evidenceId?: string
  /**
   * SIG-282: optional one-line verification rationale the security
   * specialist records when it adjudicates a scanner-backed finding
   * (analyst note). Audit/telemetry only — no gate depends on it.
   */
  independentAssessment?: string
  /**
   * SIG-110: complexity claim backing a performance finding — names the
   * changed loop/call and the input-growth source (e.g.
   * "O(n^2): rebuilds `acc` for each item in `rows`"). One of
   * `complexityEstimate` / `hotPathIdentifier` is required by
   * `evaluatePerfFinding` on score>=4 perf findings. Absent on
   * non-perf findings and on specialists not yet on the new prompt.
   */
  complexityEstimate?: string
  /**
   * SIG-110: a concrete changed route/handler/export token the perf
   * finding sits on (e.g. "GET /api/orders", "handleCheckout"). Anchors
   * a hot-path claim to a real token on a changed line; cross-checked by
   * `evaluatePerfFinding`.
   */
  hotPathIdentifier?: string
  /**
   * SIG-125: exact replacement lines for the finding's anchored range
   * `[startLine ?? line, line]` when the fix is a contiguous edit. Raw
   * code (no diff markers, no fence). Rendered by `formatFindingComment`
   * as a committable ```suggestion block (high-confidence + anchorable)
   * or a non-committable code snippet. Absent when no localized fix
   * applies (testing / architecture / multi-hunk).
   *
   * SIG-162 PR 5: when `kind === "delete"`, this field is REQUIRED but
   * must be the empty string `""` — signals deletion intent. The
   * renderer emits an empty ```suggestion block that GitHub treats as
   * a one-click deletion of the anchored range.
   */
  suggestedReplacement?: string
  /**
   * SIG-162 PR 5: shape of the proposed change. Drives renderer's
   * `suggestion` block contents:
   *   - `"delete"`  — emit an EMPTY suggestion block (one-click removal
   *                   of `[startLine ?? line, line]`). Requires
   *                   `suggestedReplacement === ""` to be set.
   *   - `"replace"` — emit a suggestion block with `suggestedReplacement`
   *                   as the new content. Same as the SIG-125 default.
   *   - `"insert"`  — reserved for future use (insertion at a single line).
   *   - `"describe"` — no suggestion block; the body is descriptive only.
   *
   * Absent → behaves like `"describe"` (back-compat with pre-PR5 model
   * output). Parser coerces inconsistent shapes:
   *   - `kind:"delete"` + non-empty `suggestedReplacement` → `kind:"replace"`
   *     (the replacement content is the actionable signal).
   *   - `kind:"delete"` + missing `suggestedReplacement` → drop `kind`
   *     (ambiguous intent — back-compat default).
   */
  kind?: "delete" | "replace" | "insert" | "describe"
  /**
   * SIG-161 PR 4a: deterministic gate score (0-1) driving the verdict
   * gate. NOT emitted by the LLM — computed post-parse by
   * `computeGateScore` from `confidence`, `score`, evidence-citation
   * presence, and specialist agreement (from `provenance.sourceSpecialists`).
   *
   * Absent on findings that haven't been scored yet (the rollout regime;
   * `chooseReviewEventWithGate` treats missing scores per `missingScorePolicy`).
   * Present on every finding that passes through PR 4b's ensemble post-
   * processing.
   *
   * Distinct from:
   *   - `confidence` (1-5, self-reported, drives renderer chrome)
   *   - `score` (1-5, severity)
   *
   * See DESIGN.md §3 for the naming rationale (`gateScore` over `calibratedScore`).
   */
  gateScore?: number
}

/**
 * SIG-282: an analyst (LLM) false-positive dismissal of a deterministic
 * scanner candidate. `evidenceId` is a verbatim manifest id; `reason` is a
 * one-line code-grounded justification. Reconciled against the manifest by
 * `evaluateScanFactDismissal` (telemetry + safety rail).
 */
export interface ScanFactDismissal {
  evidenceId: string
  reason: string
}

export interface PrReviewVerdict {
  summary: string
  confidence: number
  confidenceReason: string
  findings: PrReviewFinding[]
  /**
   * SIG-282: scanner candidates the security specialist refuted as false
   * positives (security-only; absent/empty for other specialists).
   */
  dismissedScanFacts?: ScanFactDismissal[]
}

function normalizeReviewFindingScope(raw: unknown): ReviewFindingScope | undefined {
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (value === "comment/event" || value === "event" || value === "review-comment") {
    return "comment"
  }
  if (value === "pull-request" || value === "pull_request" || value === "review") {
    return "pr"
  }
  return REVIEW_FINDING_SCOPES.has(value as ReviewFindingScope)
    ? (value as ReviewFindingScope)
    : undefined
}

function findingScope(finding: PrReviewFinding): ReviewFindingScope {
  return finding.scope ?? "line"
}

/**
 * ARC-281: specialist coverage signal injected into the review body
 * so customers can see which dimensions Sigilix actually ran. When
 * `dispatched ⊃ succeeded`, the body renders a degraded-coverage
 * notice listing the unavailable roles.
 *
 * `dispatched` is what the router asked for (subset of {logic,
 * security, performance, tests}); `succeeded` is what returned a
 * verdict. The renderer treats the role order verbatim — supply
 * them in the canonical order you want displayed.
 */
export interface CoverageRoles {
  readonly dispatched: readonly string[]
  readonly succeeded: readonly string[]
}

/**
 * ARC-281: per-Kimi spec the body now carries an explicit "**Changes:** +N
 * new · M likely-fixed" badge line under the heading instead of
 * prepending a "since last review" string into the summary. Caller
 * computes a `FindingDelta` via the existing `computeFindingDelta`
 * helper and passes the four counts through; `renderDeltaBadge`
 * formats them. Pure — exported for tests.
 *
 * Returns `null` when no signal is worth surfacing (all counts
 * zero), so the renderer can skip the line entirely rather than
 * print an empty "**Changes:**".
 *
 * 2026-05-23 rebrand: the Δ glyph (Greek capital delta, visually a
 * triangle) was removed from both the badge label and the heading
 * suffix per founder direction. Replaced with the literal word
 * "Changes" + "since last review" — same semantics, no triangle.
 */
export interface DeltaBadgeCounts {
  newCount: number
  stillOpenCount: number
  likelyFixedCount: number
  carriedOverCount: number
}

export function renderDeltaBadge(counts: DeltaBadgeCounts): string | null {
  const { newCount, stillOpenCount, likelyFixedCount, carriedOverCount } = counts
  const any =
    newCount > 0 || stillOpenCount > 0 || likelyFixedCount > 0 || carriedOverCount > 0
  if (!any) return null
  const parts: string[] = []
  if (newCount > 0) parts.push(`+${newCount} new`)
  if (stillOpenCount > 0) parts.push(`${stillOpenCount} still-open`)
  if (likelyFixedCount > 0) parts.push(`${likelyFixedCount} likely-fixed`)
  if (carriedOverCount > 0) parts.push(`${carriedOverCount} carried-over`)
  return `**Changes:** ${parts.join(" · ")}`
}

/**
 * ARC-281: build the **Coverage:** line per Kimi's spec. Three
 * shapes:
 *
 *   - Full coverage (`succeeded == dispatched`):
 *       "**Coverage:** logic · security · performance · tests"
 *
 *   - 1–2 roles missing (`dispatched - succeeded` is 1 or 2):
 *       "**Coverage:** logic · security · tests — _performance specialist unavailable_"
 *       "**Coverage:** logic · tests — _security, performance specialists unavailable_"
 *
 *   - 3+ roles missing OR unknown failure mode: caller renders a
 *     <details> block instead (see `renderCoverageDetails`).
 *
 * Returns `null` when `dispatched.length === 0` — no specialists
 * means no coverage signal to render (the bail-with-skip-notice
 * path runs).
 */
export function renderCoverageLine(roles: CoverageRoles): string | null {
  if (roles.dispatched.length === 0) return null
  const succeededSet = new Set(roles.succeeded)
  const succeeded = roles.dispatched.filter((r) => succeededSet.has(r))
  const missing = roles.dispatched.filter((r) => !succeededSet.has(r))
  const succeededLine = succeeded.length > 0 ? succeeded.join(" · ") : "_none_"
  if (missing.length === 0) {
    return `**Coverage:** ${succeededLine}`
  }
  if (missing.length <= 2) {
    const noun = missing.length === 1 ? "specialist" : "specialists"
    return `**Coverage:** ${succeededLine} — _${missing.join(", ")} ${noun} unavailable_`
  }
  // 3+ missing — the caller renders a <details> block instead of
  // this inline form per Kimi's spec.
  return `**Coverage:** ${succeededLine} — _${missing.length} specialists unavailable_`
}

/**
 * ARC-281: compress a `StackContext` into a one-line parenthetical
 * per Kimi's spec. Returns `null` when the PR isn't stacked OR the
 * parent walk degraded (no parent number to print).
 *
 *   `_(Stacked on #87)_`
 *
 * Multi-line stack-context blocks (current `renderStackContextSummary`
 * output) are deprecated by this redesign; the parenthetical replaces
 * them.
 */
export function renderStackParenthetical(stack: StackContext | undefined): string | null {
  if (!stack || !stack.isStacked) return null
  if (!stack.parent) return null
  return `_(Stacked on #${stack.parent.number})_`
}

const SIGILIX_REVIEW_MARKER = "<!-- sigilix:pr-review -->"
const BODY_ONLY_FINDINGS_HEADING = "### Review Body Findings"
// SIG-281 PR B (Rec 6 / Kimi K2.6): this section now holds only
// sub-blocker (score < 4) body-only findings — score >= 4 blockers are
// surfaced in the Fix Plan table + a collapsed evidence block above. The
// copy now covers both reasons a finding lands here: un-anchorable scope
// AND inline-comment-cap overflow (Rec 3).
const BODY_ONLY_FINDINGS_EXPLANATION =
  "<sub>These findings are shown in the review body because they could not be anchored to specific diff lines (file-level or PR-level scope) or because the inline comment cap was exceeded.</sub>"
// SIG-281 PR B (Rec 6 / Kimi K2.6): caption shown under the Fix Plan
// table only when it contains body-only blockers (rows with no inline
// thread), so a reviewer isn't confused by table rows that have no
// corresponding inline comment.
const FIX_PLAN_BODY_ONLY_CAPTION =
  "_Severity ≥ 4 only. Rows without a line number are file-level or PR-level findings that cannot be posted as inline review comments._"
const BODY_ONLY_BLOCKER_DETAILS_SUMMARY =
  "<summary><b>Evidence &amp; suggested changes for body-only blockers</b> (score ≥ 4)</summary>"




/**
 * Parse the model's primary-review response. Tolerates clean JSON,
 * fenced JSON, AND prose-wrapped JSON via balanced-brace extraction.
 * Returns null on shape errors so callers can fail loudly. Pure —
 * exported for tests.
 */
export function parsePrReviewResponse(text: string): PrReviewVerdict | null {
  const obj = parseFirstJsonObject(text)
  if (!obj) return null

  const summary = typeof obj.summary === "string" ? obj.summary.trim() : ""
  if (!summary) return null

  const confidenceRaw = Number(obj.confidence)
  if (!Number.isFinite(confidenceRaw) || confidenceRaw < 1 || confidenceRaw > 5) return null
  const confidence = Math.round(confidenceRaw)

  const confidenceReason =
    typeof obj.confidenceReason === "string" ? obj.confidenceReason.trim() : ""

  const findings: PrReviewFinding[] = []
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
  for (const f of rawFindings) {
    if (!f || typeof f !== "object") continue
    const finding = f as Record<string, unknown>
    const path = typeof finding.path === "string" ? finding.path.trim() : ""
    const line = Number(finding.line)
    const headline = typeof finding.headline === "string" ? finding.headline.trim() : ""
    const body = typeof finding.body === "string" ? finding.body.trim() : ""
    const scoreRaw = Number(finding.score)
    const categoryRaw = typeof finding.category === "string" ? finding.category.trim().toLowerCase() : ""
    if (!path || !Number.isFinite(line) || line <= 0) continue
    if (!headline || !body) continue
    if (!Number.isFinite(scoreRaw) || scoreRaw < 1 || scoreRaw > 5) continue
    // Default to "logic" when the model omits or returns an unknown
    // category — better than dropping the finding entirely. The schema
    // enforces the enum at decode time, so this fallback only catches
    // schema-bypass paths (jsonrepair, etc.).
    const category: FindingCategory = FINDING_CATEGORIES.has(categoryRaw as FindingCategory)
      ? (categoryRaw as FindingCategory)
      : "logic"
    const startLineRaw = Number(finding.startLine)
    const validStartLine =
      Number.isFinite(startLineRaw) && startLineRaw > 0 && startLineRaw < line
        ? Math.floor(startLineRaw)
        : null
    // ARC-182: read stackOrigin if present. Absent → leave undefined
    // (no-stack PR or model omitted it). Present-but-unknown enum
    // value → normalize to "current-pr" (the safe default per the
    // stack-awareness prompt instruction).
    const stackOriginRaw =
      typeof finding.stackOrigin === "string" ? finding.stackOrigin.trim() : ""
    let stackOrigin: StackOrigin | undefined
    if (stackOriginRaw.length > 0) {
      stackOrigin = STACK_ORIGINS.has(stackOriginRaw as StackOrigin)
        ? (stackOriginRaw as StackOrigin)
        : "current-pr"
    }
    const finalFinding: PrReviewFinding = {
      path,
      line: Math.floor(line),
      score: Math.max(1, Math.min(5, Math.round(scoreRaw))),
      category,
      headline,
      body,
    }
    const scope = normalizeReviewFindingScope(finding.scope)
    if (scope) finalFinding.scope = scope
    if (validStartLine != null) finalFinding.startLine = validStartLine
    if (stackOrigin) finalFinding.stackOrigin = stackOrigin
    const failureExample = normalizeFindingDetail(finding.failureExample)
    if (failureExample) finalFinding.failureExample = failureExample
    const fixExample = normalizeFindingDetail(finding.fixExample)
    if (fixExample) finalFinding.fixExample = fixExample
    const testGap = normalizeFindingDetail(finding.testGap)
    if (testGap) finalFinding.testGap = testGap
    // SIG-101: read per-finding confidence when the model supplies it.
    // Clamped to 1-5. Absent → leave undefined; downstream renderers
    // call `resolveFindingConfidence` which falls back to the
    // verdict-level `confidence` so every finding has a number.
    const confidenceRawF = Number(finding.confidence)
    if (Number.isFinite(confidenceRawF) && confidenceRawF >= 1 && confidenceRawF <= 5) {
      finalFinding.confidence = Math.round(confidenceRawF)
    }
    // SIG-113: read inspectedTestFiles + evidenceRefs when the
    // specialist supplies them. Both arrays are string-only;
    // non-string entries and empty strings are dropped silently
    // (defensive against schema-bypass paths). Both fields are
    // optional — staged rollout means many specialists won't emit
    // them yet, and that's fine; the validator handles the absence
    // case by dropping unevidenced testing findings.
    if (Array.isArray(finding.inspectedTestFiles)) {
      const files = (finding.inspectedTestFiles as unknown[])
        .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f) => f.trim())
      if (files.length > 0) finalFinding.inspectedTestFiles = files
    }
    if (Array.isArray(finding.evidenceRefs)) {
      const refs = (finding.evidenceRefs as unknown[])
        .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
        .map((r) => r.trim())
      if (refs.length > 0) finalFinding.evidenceRefs = refs
    }
    // SIG-108: read cweId + evidenceId (scalar strings) when supplied.
    // Both optional; the security validator handles absence.
    if (typeof finding.cweId === "string" && finding.cweId.trim().length > 0) {
      finalFinding.cweId = finding.cweId.trim()
    }
    if (typeof finding.evidenceId === "string" && finding.evidenceId.trim().length > 0) {
      finalFinding.evidenceId = finding.evidenceId.trim()
    }
    // SIG-282: optional analyst verification rationale on a scanner-backed
    // finding. Audit/telemetry only.
    if (typeof finding.independentAssessment === "string" && finding.independentAssessment.trim().length > 0) {
      finalFinding.independentAssessment = finding.independentAssessment.trim()
    }
    // SIG-110: read complexityEstimate + hotPathIdentifier (scalar
    // strings) when supplied. Both optional; the perf validator handles
    // absence.
    if (typeof finding.complexityEstimate === "string" && finding.complexityEstimate.trim().length > 0) {
      finalFinding.complexityEstimate = finding.complexityEstimate.trim()
    }
    if (typeof finding.hotPathIdentifier === "string" && finding.hotPathIdentifier.trim().length > 0) {
      finalFinding.hotPathIdentifier = finding.hotPathIdentifier.trim()
    }
    // SIG-125: read suggestedReplacement. Trim only to test emptiness —
    // the value is kept VERBATIM (indentation + trailing newline matter
    // for the rendered suggestion block).
    //
    // SIG-162 PR 5: also read `kind` and coerce inconsistent shapes.
    //   - kind:"delete" + suggestedReplacement:""    → preserve both (deletion)
    //   - kind:"delete" + suggestedReplacement:"..." → coerce to kind:"replace"
    //                                                  (replacement content is
    //                                                  the actionable signal)
    //   - kind:"delete" + no suggestedReplacement    → drop kind (ambiguous)
    //   - kind:"replace"|"insert" + non-empty repl   → preserve both
    //   - kind invalid or absent                     → existing behavior
    const kindRaw = typeof finding.kind === "string" ? finding.kind.trim() : ""
    const replRaw = finding.suggestedReplacement
    const replIsString = typeof replRaw === "string"
    const replIsEmpty = replIsString && replRaw.trim().length === 0
    const replIsNonEmpty = replIsString && replRaw.trim().length > 0

    if (kindRaw === "delete" && replIsEmpty) {
      finalFinding.kind = "delete"
      finalFinding.suggestedReplacement = replRaw
    } else if (kindRaw === "delete" && replIsNonEmpty) {
      // Inconsistent — model said delete but provided content. Trust the
      // content; reclassify as replace.
      finalFinding.kind = "replace"
      finalFinding.suggestedReplacement = replRaw
    } else if ((kindRaw === "replace" || kindRaw === "insert") && replIsNonEmpty) {
      finalFinding.kind = kindRaw
      finalFinding.suggestedReplacement = replRaw
    } else if (replIsNonEmpty) {
      // SIG-125 back-compat: kind absent or unknown, non-empty replacement.
      finalFinding.suggestedReplacement = replRaw
    }
    findings.push(finalFinding)
    if (findings.length >= 8) break
  }

  // SIG-282: parse the security specialist's explicit false-positive
  // dismissals. Each needs a manifest evidenceId + a concrete reason;
  // malformed entries are dropped. Reconciled against the manifest
  // downstream by `evaluateScanFactDismissal`.
  const dismissedScanFacts: ScanFactDismissal[] = []
  if (Array.isArray(obj.dismissedScanFacts)) {
    for (const d of obj.dismissedScanFacts as unknown[]) {
      if (!d || typeof d !== "object") continue
      const rec = d as Record<string, unknown>
      const evidenceId = typeof rec.evidenceId === "string" ? rec.evidenceId.trim() : ""
      const reason = typeof rec.reason === "string" ? rec.reason.trim() : ""
      if (evidenceId && reason) dismissedScanFacts.push({ evidenceId, reason })
      if (dismissedScanFacts.length >= 16) break
    }
  }

  return {
    summary,
    confidence,
    confidenceReason,
    findings,
    ...(dismissedScanFacts.length > 0 ? { dismissedScanFacts } : {}),
  }
}

function normalizeFindingDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  let clean = value.trim()
  const fenced = clean.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/)
  if (fenced) clean = fenced[1]?.trim() ?? ""
  if (clean.length === 0) return undefined
  if (clean.length > FINDING_STRUCTURED_DETAIL_LIMIT) {
    clean = clean.slice(0, FINDING_STRUCTURED_DETAIL_LIMIT).trimEnd()
  }
  return clean.length > 0 ? clean : undefined
}

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
   * Findings that passed the hallucination guard but failed the
   * line-validity check. The inline-comments path can't anchor them
   * (GitHub would 422), so they get rolled into the review body as
   * compact body-only findings. Without this, unanchored findings were
   * silently dropped on the success path of the orchestrator (only
   * the submit-fallback path recovered them). CodeRabbit + Sigilix
   * both caught the regression on PR #38.
   *
   * Default `[]` — the common case where every finding anchored
   * cleanly. When non-empty:
   *   - The chosen review event takes ALL findings into account
   *     (anchored + unanchored), so a verdict with only-unanchored
   *     blocking findings doesn't post as APPROVE.
   *   - The body grows with a "Review Body Findings" section listing
   *     the body-only set.
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
   * back to the snippet tier.
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
}

interface PreparedReviewSubmissionFindings {
  verdict: PrReviewVerdict
  renderVerdict: PrReviewVerdict
  inlineFindings: PrReviewFinding[]
  inlineOriginalIndex: number[]
  unanchored: PrReviewFinding[]
}

// SIG-281 PR B (Rec 3): cap the number of inline review comments a
// single review posts, so a large PR doesn't bury the diff under dozens
// of threads. Overflow is demoted to the review body (never dropped),
// prioritized so the highest-severity / highest-confidence findings keep
// their inline thread. 15 = the upper end of the proposed 10-15 range,
// chosen to minimize SIG-247 marker loss (markers are inline-only) while
// still bounding inline noise. No sigilix.json config in PR B.
const MAX_INLINE_COMMENTS = 15

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

// SIG-281 PR B: carries an inline candidate with its ORIGINAL
// verdict.findings index so the Rec 3 priority sort + cap can reorder /
// truncate WITHOUT decoupling a finding from the index its SIG-247
// marker is keyed by (consumed at the marker lookup ~line 1019).
interface InlineFindingCandidate {
  finding: PrReviewFinding
  originalIndex: number
  confidence: number
}

function prepareReviewSubmissionFindings(args: {
  rawVerdict: PrReviewVerdict
  rawUnanchored: readonly PrReviewFinding[]
  headSha: string
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
}): PreparedReviewSubmissionFindings {
  const { rawVerdict, rawUnanchored, headSha, addedLineTextByLine } = args
  const verdict = sanitizeVerdictForGitHub(rawVerdict)
  const sanitizedUnanchored = sanitizeFindingsForGitHub(rawUnanchored)

  const inlineCandidates: InlineFindingCandidate[] = []
  const bodyFindings: PrReviewFinding[] = []
  verdict.findings.forEach((f, i) => {
    const hasSuggestion = hasStructuredFix(f)
    const scope = findingScope(f)
    // SIG-281 PR B (Rec 5): resolve per-finding confidence once, up front,
    // for the severity/confidence routing gate below. `verdict.confidence`
    // is parse-guaranteed 1-5.
    const confidence = resolveFindingConfidence(f, verdict.confidence)
    const findingForInline =
      hasSuggestion && scope !== "line"
        ? { ...f, scope: "line" as const }
        : f

    // SIG-127 wins over broad scope: a localized suggestedReplacement
    // or empty deletion suggestion needs an inline review thread or the
    // proposed fix disappears from the customer-visible review body.
    // Treat that shape as line-scoped even if the model supplied a
    // broader scope.
    // SIG-202: GitHub inline review comments are for exact line
    // anchors. Review-level, file-level, and comment-event findings stay
    // in the body even if they carry a nearby line for context.
    if (scope !== "line" && !hasSuggestion) {
      bodyFindings.push(f)
      return
    }

    const addedLinesForPath = addedLineTextByLine?.get(findingForInline.path)
    let effective: PrReviewFinding = findingForInline
    if (addedLineTextByLine !== undefined && !hasSuggestion) {
      const resolved = pickAnchorLineForward(addedLinesForPath, f.line)
      if (resolved === null) {
        bodyFindings.push(withLineMovedNote(f, headSha))
        return
      }
      if (resolved !== f.line) {
        const { startLine: _drop, ...rest } = f
        effective = { ...rest, line: resolved }
      }
    }

    // SIG-281 PR B (Recs 2/5): confidence-tiered severity routing. A
    // low/medium-severity line finding (score < 4) with weak grounding is
    // demoted to the review body so the inline surface stays high-signal.
    // Runs on `effective` (post-line-move) and short-circuits the
    // substantiveness gate below — severity/confidence is orthogonal to
    // anchor quality. NEVER demotes score >= 4 (P0/P1 — the believability
    // floor). The tiers (per Codex backend sign-off, the conservative
    // unification of the ticket's Recs 2 + 5):
    //   - confidence <= 2: demote unless it carries a committable fix.
    //   - confidence === 3: demote unless it carries a fix OR a repro.
    //   - confidence >= 4: never demoted here (high-confidence signal
    //     keeps its inline thread even without a patch).
    if (
      findingScope(effective) === "line" &&
      effective.score < 4 &&
      ((confidence <= 2 && !hasStructuredFix(effective)) ||
        (confidence === 3 && !hasPatchOrRepro(effective)))
    ) {
      bodyFindings.push(effective)
      return
    }

    const lineText = addedLineTextByLine?.get(effective.path)?.get(effective.line)
    const isNonSubstantive =
      !hasSuggestion &&
      addedLineTextByLine !== undefined &&
      lineText !== undefined &&
      !isSubstantiveAnchorLine(lineText)
    if (isNonSubstantive) {
      bodyFindings.push(effective)
    } else {
      inlineCandidates.push({ finding: effective, originalIndex: i, confidence })
    }
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
    const keptIndices = new Set(
      prioritized.slice(0, MAX_INLINE_COMMENTS).map((c) => c.originalIndex),
    )
    kept = inlineCandidates.filter((c) => keptIndices.has(c.originalIndex))
    for (const candidate of inlineCandidates) {
      if (!keptIndices.has(candidate.originalIndex)) {
        bodyFindings.push(markInlineCapOverflow(candidate.finding))
      }
    }
  }

  const inlineFindings: PrReviewFinding[] = kept.map((c) => c.finding)
  const inlineOriginalIndex: number[] = kept.map((c) => c.originalIndex)
  const renderVerdict: PrReviewVerdict = { ...verdict, findings: inlineFindings }
  const unanchored: PrReviewFinding[] = [...sanitizedUnanchored, ...bodyFindings]

  return {
    verdict,
    renderVerdict,
    inlineFindings,
    inlineOriginalIndex,
    unanchored,
  }
}

export interface PreviewReviewSubmissionEventArgs {
  verdict: PrReviewVerdict
  headSha: string
  unanchored?: readonly PrReviewFinding[]
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>>
  eventOverride?: ReviewEventOverride
}

export function previewReviewSubmissionEvent({
  verdict: rawVerdict,
  headSha,
  unanchored: rawUnanchored = [],
  addedLineTextByLine,
  eventOverride,
}: PreviewReviewSubmissionEventArgs): ReviewEvent {
  const prepared = prepareReviewSubmissionFindings({
    rawVerdict,
    rawUnanchored,
    headSha,
    ...(addedLineTextByLine !== undefined ? { addedLineTextByLine } : {}),
  })
  return chooseRenderedEventWithOverride({
    inlineFindings: prepared.inlineFindings,
    bodyOnlyFindings: prepared.unanchored,
  }, eventOverride)
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
  const all = [...verdict.findings, ...unanchored]
  return chooseRenderedEventWithOverride({
    inlineFindings: [],
    bodyOnlyFindings: all,
  }, eventOverride)
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
}: BuildReviewArgs): ReviewSubmissionBuildResult {
  const {
    verdict,
    renderVerdict,
    inlineFindings,
    inlineOriginalIndex,
    unanchored,
  } = prepareReviewSubmissionFindings({
    rawVerdict,
    rawUnanchored,
    headSha,
    ...(addedLineTextByLine !== undefined ? { addedLineTextByLine } : {}),
  })
  const event = chooseRenderedEventWithOverride({
    inlineFindings,
    bodyOnlyFindings: unanchored,
  }, eventOverride)

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
    const baseBody = formatFindingComment(f, confidence, reviewable, addedLineTextByLine)
    const fullBody = marker ? `${baseBody}\n\n${marker}` : baseBody
    const c: SubmitReviewComment = {
      path: f.path,
      line: f.line,
      side: "RIGHT",
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
      (reviewable === undefined || isCommentAnchorable(reviewable, f.path, f.startLine, f.line))
    if (emitStartLine && f.startLine != null) {
      c.start_line = f.startLine
      c.start_side = "RIGHT"
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
  }
}

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
}: BuildFallbackArgs): SubmitReviewBody {
  // ARC-156 follow-up: sanitize prose before rendering — same as
  // buildReviewSubmission, applied here for the anchorless-fallback
  // path so the body-rendered findings also get HTML-tag wrap.
  const verdict = sanitizeVerdictForGitHub(rawVerdict)
  const unanchored = sanitizeFindingsForGitHub(rawUnanchored)
  const all = [...verdict.findings, ...unanchored]
  const event = chooseRenderedEventWithOverride({
    inlineFindings: [],
    bodyOnlyFindings: all,
  }, eventOverride)
  const body = buildFallbackBody(
    verdict, unanchored, undefined, stack, coverage, delta, reviewCounter, retriggerUrl,
    event === "REQUEST_CHANGES" ? event : undefined,
  )
  return {
    event,
    body,
    commit_id: headSha,
    // No `comments` array — every finding lives in `body`.
  }
}

export interface ProvenanceCtx {
  /** Head SHA of the PR being reviewed (40-char hex). */
  headSha: string
  /** Override Date.now() for deterministic tests. */
  nowMs?: number
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
): string {
  // ARC-281: the anchorless-fallback path means GitHub silently
  // dropped the inline anchors, so the body must carry every
  // finding. Pour both `verdict.findings` and `unanchored` into the
  // single `unanchored` bucket of the new renderer — they render as
  // the body-only findings section grouped by file, which is exactly
  // the right place when none of them landed inline.
  const all = [...verdict.findings, ...unanchored]
  const event = chooseRenderedEventWithOverride({
    inlineFindings: [],
    bodyOnlyFindings: all,
  }, eventOverride)
  if (event === "APPROVE") {
    const args: RenderBodyArgs = { verdict, unanchored: [] }
    if (stack !== undefined) args.stack = stack
    if (prov !== undefined) args.prov = prov
    if (coverage) args.coverage = coverage
    if (delta !== undefined) args.delta = delta
    return renderApproveBody(args)
  }
  const args: RenderBodyArgs = {
    verdict: { ...verdict, findings: [] },
    unanchored: all,
  }
  if (stack !== undefined) args.stack = stack
  if (prov !== undefined) args.prov = prov
  if (coverage) args.coverage = coverage
  if (delta !== undefined) args.delta = delta
  if (typeof reviewCounter === "number") args.reviewCounter = reviewCounter
  if (retriggerUrl) args.retriggerUrl = retriggerUrl
  return event === "COMMENT"
    ? renderCommentBody(args)
    : renderRequestChangesBody(args)
}

export function chooseReviewEvent(
  findings: PrReviewFinding[],
  openItems: ReadonlyArray<AuthoredItem> = [],
): Exclude<ReviewEvent, "COMMENT"> {
  // Strict: any inline finding the model surfaces is a blocker. The
  // verdict is two-state (APPROVE | REQUEST_CHANGES) — score still
  // sorts/severity-tags the findings but doesn't decide the gate.
  // Closed loop comes from synchronize-driven re-reviews (PR #28):
  // user pushes fixes → arc re-reviews → empty findings → APPROVE.
  //
  // ARC-276: the APPROVE event is a real GitHub review-approval that
  // counts toward branch-protection's required-reviewer count on
  // repos that don't exclude bot reviewers. This is the
  // "rubber-stamp" trade-off documented in the README; the founder's
  // call is that always-vocal Sigilix beats silent skips even at the
  // cost of bot-approval-counts-as-reviewer.
  //
  // SIG-37: `openItems` is an optional list of open PR threads /
  // review comments / blocking items that a caller wants to factor
  // into the gate. Items NOT authored by `sigilix[bot]` (i.e.
  // CodeRabbit, Greptile, other bots, human reviewers) are filtered
  // out BEFORE the gate runs. Only Sigilix-authored open items count
  // — establishes the clean Sigilix-only signal needed for the
  // head-to-head measurement framework (SIG-200, separately tracked).
  //
  // Defaults to `[]` so existing call sites (which pass only the
  // synth verdict's own findings) are unaffected — those findings
  // are Sigilix-authored by construction.
  if (findings.length > 0) return "REQUEST_CHANGES"
  const sigilixOpenItems = filterToSigilixAuthored(openItems)
  return sigilixOpenItems.length === 0 ? "APPROVE" : "REQUEST_CHANGES"
}

export interface ChooseReviewEventForRenderedFindingsArgs {
  inlineFindings: readonly PrReviewFinding[]
  bodyOnlyFindings: readonly PrReviewFinding[]
  openItems?: ReadonlyArray<AuthoredItem>
}

/**
 * Verdict gate for the final rendered surface.
 *
 * Inline review comments are blocking because GitHub places them on
 * changed code. Body-only findings of low/medium severity (score < 4)
 * are surfaced as a non-blocking COMMENT — off-diff/global feedback
 * stays visible without pretending it is an inline fix.
 *
 * SIG-281 PR A: a body-only finding of score >= 4 (P0/P1) DOES escalate
 * to REQUEST_CHANGES. A real blocker can land body-only (no anchorable
 * inline location, or demoted by the PR B/C routing discipline), and a
 * markdown table row does not gate a merge — only the review event does.
 * A separate policy blocker can still override the event upward.
 */
export function chooseReviewEventForRenderedFindings(
  args: ChooseReviewEventForRenderedFindingsArgs,
): ReviewEvent {
  if (args.inlineFindings.length > 0) return "REQUEST_CHANGES"

  const sigilixOpenItems = filterToSigilixAuthored(args.openItems ?? [])
  if (sigilixOpenItems.length > 0) return "REQUEST_CHANGES"

  if (args.bodyOnlyFindings.length === 0) return "APPROVE"
  // SIG-281 PR A — believability floor: a blocker (score >= 4 = P0/P1) that
  // landed body-only (unanchorable inline, or demoted by the PR B/C routing
  // discipline) must STILL block the merge. Appearing in body TEXT does not
  // gate GitHub's merge — only the review event does — so without this a real
  // P0 routed to the body would surface as a non-blocking COMMENT (green merge).
  // Sub-4 body-only findings stay COMMENT (nits don't block).
  if (args.bodyOnlyFindings.some((f) => f.score >= 4)) return "REQUEST_CHANGES"
  return "COMMENT"
}

function chooseRenderedEventWithOverride(
  args: ChooseReviewEventForRenderedFindingsArgs,
  eventOverride?: ReviewEventOverride,
): ReviewEvent {
  // Only escalation is safe here. COMMENT/APPROVE overrides can hide
  // rendered findings, so even an unsafe cast at runtime is ignored.
  if (eventOverride === "REQUEST_CHANGES") return "REQUEST_CHANGES"
  return chooseReviewEventForRenderedFindings(args)
}

// ─── SIG-161 PR 4a: thresholded gate ─────────────────────────────────
// Sits alongside the legacy `chooseReviewEvent`. The flag wrapper in
// PR 4b switches between them based on `OPENCLAW_GATE`. The legacy
// path is preserved unchanged for back-compat (every existing call
// site still uses it; nothing in PR 4a routes findings through the
// new path in production).
//
// See DESIGN.md §4 for the four-event table and §5 for the score
// blend.

/** Compile-time policy for a finding whose `gateScore` is absent. */
export type MissingScorePolicy =
  /** Treat missing as `1.0` — finding blocks like today. Rollout default. */
  | "block"
  /** Treat missing as a pipeline-invariant failure — throw. Post-calibration default. */
  | "throw"
  /** Treat missing as `0.0` — non-blocking; useful for offline replay / backfill. */
  | "permit"

export interface ChooseReviewEventWithGateArgs {
  findings: PrReviewFinding[]
  /** Calibrated cutoff. A finding with `gateScore >= threshold` blocks. */
  threshold: number
  /** Optional list of open PR threads — same SIG-37 semantics as legacy. */
  openItems?: ReadonlyArray<AuthoredItem>
  missingScorePolicy: MissingScorePolicy
}

/**
 * SIG-161 PR 4a — four-event verdict gate.
 *
 *   - any finding's `gateScore >= threshold`  → REQUEST_CHANGES
 *   - no blocking + any Sigilix-authored open → REQUEST_CHANGES
 *   - no blocking + any finding present       → COMMENT
 *   - no blocking + no findings + no items    → APPROVE
 *
 * `missingScorePolicy` controls handling of `gateScore === undefined`:
 *   - `"block"`: effective score = 1.0 (matches legacy + rollout).
 *   - `"throw"`: pipeline invariant — every finding MUST be scored
 *                by the time it reaches the gate. Production
 *                `enforce`-mode setting.
 *   - `"permit"`: effective score = 0.0 (offline replay / backfill).
 *
 * Pure — exported for tests. PR 4b's flag wrapper is the production
 * call site; PR 4a itself never reaches this function in prod (the
 * existing call sites continue to use legacy `chooseReviewEvent`).
 *
 * NOTE: this function does NOT apply the `FLOOR_SUPPRESS = 0.60`
 * suppression. That happens upstream in the ensemble's pre-emit
 * filter (alongside review-memory softening, withdrawal suppression,
 * structural-glue suppression). The gate sees only findings that
 * already survived suppression and decides which event to emit.
 */
export function chooseReviewEventWithGate(
  args: ChooseReviewEventWithGateArgs,
): ReviewEvent {
  const { findings, threshold, openItems = [], missingScorePolicy } = args

  const effectiveScore = (f: PrReviewFinding): number => {
    // Guard non-finite: `typeof NaN === "number"`, and `NaN >= threshold`
    // is always false, so a NaN gateScore would silently bypass the
    // blocking branch instead of routing through missingScorePolicy.
    // Treat NaN / +Infinity / -Infinity as "missing" and fall through.
    if (typeof f.gateScore === "number" && Number.isFinite(f.gateScore)) {
      return f.gateScore
    }
    if (missingScorePolicy === "block") return 1.0
    if (missingScorePolicy === "permit") return 0.0
    // throw
    throw new Error(
      `gateScore missing on finding ${f.path}:${f.line} (${f.headline.slice(0, 60)}); ` +
        `pipeline invariant — every finding reaching the gate must be scored. ` +
        `If this fires in prod, the ensemble's post-processing is bypassing computeGateScore.`,
    )
  }

  const blocking = findings.filter((f) => effectiveScore(f) >= threshold)
  if (blocking.length > 0) return "REQUEST_CHANGES"

  const sigilixOpenItems = filterToSigilixAuthored(openItems)
  if (sigilixOpenItems.length > 0) return "REQUEST_CHANGES"

  // No blocking finding, no open items — distinguish empty (APPROVE)
  // from "had findings, none blocking" (COMMENT, the new event).
  if (findings.length > 0) return "COMMENT"

  return "APPROVE"
}

/**
 * SIG-161 PR 4a — provenance subset relevant to gate scoring.
 *
 * The full `provenance` shape lives on the synth verdict (see
 * `synth-verdict.ts`) but `computeGateScore` only needs the
 * specialist-agreement count per finding. Decoupled so the function
 * stays pure + snapshot-testable.
 */
export interface GateScoreProvenance {
  /**
   * Specialists whose findings merged into this synth finding.
   * Length ≥ 1 (single-source findings are admissible per the
   * synthesizer prompt). More specialists = stronger agreement.
   */
  sourceSpecialists: ReadonlyArray<string>
}

/**
 * SIG-161 PR 4a — does this finding carry the evidence its category
 * requires? Used as a 0/1 boost input to `computeGateScore`.
 *
 *   - `security` + score>=4 → cweId AND evidenceId  (SIG-108 contract)
 *   - `performance` + score>=4 → complexityEstimate OR hotPathIdentifier
 *   - `testing` (all severities) → inspectedTestFiles OR evidenceRefs
 *   - any other category → true (no per-category requirement today)
 *
 * Mirrors the per-category validators that drop findings without
 * evidence; the score-blend boost is a soft echo of the hard validator
 * gate — findings WITH evidence get +0.10 even before the validator
 * applies, findings WITHOUT evidence (and below their validator
 * threshold) don't get the boost. Pure — exported for tests.
 */
export function hasRequiredEvidence(f: PrReviewFinding): boolean {
  if (f.category === "security") {
    if (f.score < 4) return true
    return (
      typeof f.cweId === "string" &&
      f.cweId.length > 0 &&
      typeof f.evidenceId === "string" &&
      f.evidenceId.length > 0
    )
  }
  if (f.category === "performance") {
    if (f.score < 4) return true
    return (
      (typeof f.complexityEstimate === "string" && f.complexityEstimate.length > 0) ||
      (typeof f.hotPathIdentifier === "string" && f.hotPathIdentifier.length > 0)
    )
  }
  if (f.category === "testing") {
    return (
      (Array.isArray(f.inspectedTestFiles) && f.inspectedTestFiles.length > 0) ||
      (Array.isArray(f.evidenceRefs) && f.evidenceRefs.length > 0)
    )
  }
  // logic / error-handling / complexity / style / syntax / docs — no
  // per-category requirement in v1. The category-specific validators
  // (SIG-109 logic) handle their own admissibility.
  return true
}

/**
 * SIG-161 PR 4a — deterministic gate-score blend.
 *
 * `gateScore = clamp01(rescale(confidence) + evidence + agreement + severity)`
 *
 *   rescale: 1→0.10, 2→0.30, 3→0.50, 4→0.75, 5→0.90
 *     (conservative at the high end — overconfident "5/5" claims
 *      don't collapse to 1.0)
 *   evidence: +0.10 if `hasRequiredEvidence(f)`, else 0
 *   agreement: +0.05 per specialist beyond the first, capped at +0.10
 *   severity: score 1→-0.10, 2→-0.05, 3→0, 4→+0.05, 5→+0.10
 *
 * Hand-tuned coefficients in v1; PR 4c replaces this with a logistic-
 * regression fit on the labeled dataset (see DESIGN.md §8c). The
 * hand-blend stays in the codebase as the fallback when the calibrated
 * model artifact is unavailable (KV miss).
 *
 * Properties:
 *   - WEAKLY monotone in each input (clamp at 1.0 + 0.0 saturates).
 *   - Bounded in [0, 1].
 *   - Pure — exported for tests.
 *
 * NOT called by the renderer or any production code path in PR 4a.
 * PR 4b's ensemble post-processing calls this on each finding before
 * emit; PR 4c flips the flag so the score actually drives the gate.
 */
export function computeGateScore(
  f: PrReviewFinding,
  p: GateScoreProvenance,
): number {
  // Rescale self-reported 1-5 confidence to 0-1, conservative on the
  // high end. Missing self-report defaults to 3 (neutral) to mirror
  // `resolveFindingConfidence`'s "as confident as the verdict" fallback.
  const confRaw = typeof f.confidence === "number" ? f.confidence : 3
  const confBucket = Math.max(1, Math.min(5, Math.round(confRaw))) as 1 | 2 | 3 | 4 | 5
  const confMap = { 1: 0.10, 2: 0.30, 3: 0.50, 4: 0.75, 5: 0.90 } as const
  const conf = confMap[confBucket]

  const evidence = hasRequiredEvidence(f) ? 0.10 : 0

  // Cap agreement at +0.10 (two extra specialists). Beyond that, more
  // agreement doesn't add precision — diminishing returns + risk of
  // false-consensus boosts on category-overlap noise.
  const extraSpecs = Math.max(0, p.sourceSpecialists.length - 1)
  const agreement = Math.min(0.10, 0.05 * extraSpecs)

  const sevBucket = Math.max(1, Math.min(5, Math.round(f.score))) as 1 | 2 | 3 | 4 | 5
  const sevMap = { 1: -0.10, 2: -0.05, 3: 0, 4: 0.05, 5: 0.10 } as const
  const severity = sevMap[sevBucket]

  return Math.max(0, Math.min(1, conf + evidence + agreement + severity))
}

// ─── SIG-161 PR 4b — shadow-mode divergence helper ────────────────────
// Pulled out of the inline ensemble call site (per Sigilix self-review
// on PR #146 — the inline 95-LOC block was untestable; the helper is
// pure + unit-coverable).

/**
 * Inputs to `computeShadowGateDivergence`. Decoupled from the
 * ensemble's `Env` / `console.log` / provenance shape so the helper
 * stays pure.
 */
export interface ShadowDivergenceInputs {
  /** Findings that will render inline (anchored). Parallel to `provenance`. */
  renderable: PrReviewFinding[]
  /** Findings that fell out of inline anchoring; no parallel provenance. */
  unanchored: PrReviewFinding[]
  /**
   * Per-renderable-finding provenance. Each entry maps to the same
   * index in `renderable`; `undefined` entries signal "no source
   * specialists information" (treated as zero agreement signal).
   */
  provenance: ReadonlyArray<{ sourceSpecialists?: ReadonlyArray<string> } | undefined>
  /** Calibrated threshold (from KV at the call site). */
  threshold: number
  /** Verdict the legacy `chooseReviewEvent` already computed. */
  legacyEvent: Exclude<ReviewEvent, "COMMENT">
}

/**
 * Result of running the shadow-mode gate. `divergence` is populated
 * only when the gate verdict differs from `legacyEvent`; otherwise
 * null (the caller writes no log).
 */
export interface ShadowDivergenceResult {
  gateEvent: ReviewEvent
  divergence:
    | {
        threshold: number
        legacyEvent: ReviewEvent
        gateEvent: ReviewEvent
        findingCount: number
        blockingFindingCount: number
        scoreSummary: string
      }
    | null
}

/**
 * SIG-161 PR 4b — compute the gate's shadow-mode verdict + the
 * divergence-log payload (when it disagrees with the legacy verdict).
 *
 * Pure — no env / KV / console access. The ensemble call site reads
 * the env + threshold + provenance, calls this, and writes the log if
 * `result.divergence !== null`.
 *
 * Behavior:
 *   - Each finding's `gateScore` is preserved when already a finite
 *     number; otherwise computed via `computeGateScore` with the
 *     parallel provenance (or empty `sourceSpecialists` for unanchored
 *     findings, which lack a provenance row).
 *   - The verdict is taken from `chooseReviewEventWithGate` with
 *     `missingScorePolicy: "block"` — non-finite or missing scores
 *     contribute as 1.0 (= blocking), matching the rollout regime.
 *   - When the gate's verdict disagrees with the legacy verdict, the
 *     divergence payload's `blockingFindingCount` aligns with the
 *     `"block"` policy: non-finite scores count as blocking even
 *     though `score >= threshold` is false on NaN.
 *
 * Exported for tests. Production caller is `handlePrReviewEnsemble`
 * (single call site as of PR 4b).
 */
export function computeShadowGateDivergence(
  args: ShadowDivergenceInputs,
): ShadowDivergenceResult {
  const { renderable, unanchored, provenance, threshold, legacyEvent } = args

  const fillScore = (
    f: PrReviewFinding,
    specialists: ReadonlyArray<string>,
  ): PrReviewFinding => ({
    ...f,
    gateScore: typeof f.gateScore === "number" && Number.isFinite(f.gateScore)
      ? f.gateScore
      : computeGateScore(f, { sourceSpecialists: specialists }),
  })

  const scoredRenderable = renderable.map((f, i) =>
    fillScore(f, provenance[i]?.sourceSpecialists ?? []),
  )
  const scoredUnanchored = unanchored.map((f) => fillScore(f, []))
  const allScored = [...scoredRenderable, ...scoredUnanchored]

  const gateEvent = chooseReviewEventWithGate({
    findings: allScored,
    threshold,
    missingScorePolicy: "block",
  })

  if (gateEvent === legacyEvent) {
    return { gateEvent, divergence: null }
  }

  // `"block"` policy treats non-finite gateScore as effective 1.0
  // (blocking). Align the telemetry counter so it doesn't under-report
  // in the (rare today, common during PR 4b shadow) case where a
  // finding sneaks through with no scored value.
  const isBlocking = (f: PrReviewFinding): boolean => {
    if (typeof f.gateScore !== "number" || !Number.isFinite(f.gateScore)) {
      return true
    }
    return f.gateScore >= threshold
  }

  return {
    gateEvent,
    divergence: {
      threshold,
      legacyEvent,
      gateEvent,
      findingCount: allScored.length,
      blockingFindingCount: allScored.filter(isBlocking).length,
      scoreSummary: allScored.map((f) => f.gateScore?.toFixed(2)).join(","),
    },
  }
}

/**
 * SIG-37 — minimal shape for items that carry a GitHub-style author
 * login. Wide enough to cover review comments, review threads' root
 * comments, and PR-review records (`listPullRequestReviews` rows) —
 * every shape Sigilix might want to gate on in the future. `user`
 * may be `null` (GitHub returns `null` for deleted authors); a
 * missing `user` deterministically falls out of the Sigilix-only
 * filter, never the other way.
 */
export interface AuthoredItem {
  user: { login: string | null } | null
}

/**
 * SIG-37 — filter any list of authored items down to those Sigilix
 * itself authored. The canonical predicate for the approval-gate
 * decision; any new call site that lists open items should run them
 * through this before checking `length === 0` for an APPROVE intent.
 *
 * Pure — `user.login === SIGILIX_BOT_LOGIN`. Items with a missing /
 * null user object, or a non-matching login, are dropped. The match
 * is case-sensitive because GitHub's bot logins always lowercase the
 * slug (`sigilix[bot]` is the exact App-emitted form).
 *
 * Exported so non-`chooseReviewEvent` callers (e.g. observability
 * code that wants to count "Sigilix-authored unresolved threads vs
 * other-actor threads" separately) reuse the same predicate.
 */
export function filterToSigilixAuthored<T extends AuthoredItem>(
  items: ReadonlyArray<T>,
): T[] {
  return items.filter((item) => item.user?.login === SIGILIX_BOT_LOGIN)
}

/**
 * ARC-281: shared args for both `renderApproveBody` and
 * `renderRequestChangesBody`. Mirrors the historical
 * `formatReviewBody` signature but adds two fields surfaced by
 * Kimi K2.6's spec:
 *
 *   - `coverage` — which specialists were dispatched vs returned;
 *     drives the new `**Coverage:**` line (full or degraded).
 *   - `delta` — finding delta vs the prior review's manifest;
 *     drives the `**Changes:** +N new · M likely-fixed` badge under the
 *     heading. `null` means no prior review or no signal.
 *
 * The new renderers do NOT consume `verdict.confidenceReason` —
 * Kimi flagged it as redundant with the summary (it routinely
 * echoes the same content) so the redesign drops it from the
 * customer-facing body. Per-finding inline comments still use it
 * via `formatFindingComment` (ARC-282 will revisit).
 */
export interface RenderBodyArgs {
  verdict: PrReviewVerdict
  /** Line-scoped findings that passed review but could not be anchored
   *  to a diff line. Non-line-scoped findings may remain in
   *  `verdict.findings`; the renderer routes them to the same body-only
   *  section. Default `[]`. */
  unanchored?: PrReviewFinding[]
  /** Specialist dispatch/success roster. When absent, the coverage
   *  line is omitted (back-compat shim for call sites that haven't
   *  plumbed coverage through yet — ensemble will always supply). */
  coverage?: CoverageRoles
  /** Per-Kimi delta badge counts (already computed). `null` skips. */
  delta?: DeltaBadgeCounts | null
  /** Stack context. When `stack.isStacked === true && stack.parent`,
   *  a `_(Stacked on #N)_` parenthetical appends to the summary
   *  paragraph. */
  stack?: StackContext
  /** Provenance footer context (head SHA + nowMs override). When
   *  supplied, `capForGitHub` appends the `_Reviewed against
   *  \`{sha7}\` at {iso8601}._` footer. */
  prov?: ProvenanceCtx
  /**
   * SIG-101: 1-indexed sequence number for the per-PR review counter.
   * When supplied, `renderRequestChangesBody` appends a
   * `_Sigilix · Review #N for this PR · last rendered <iso>._`
   * footer line. APPROVE bodies stay marker-only (per SIG-94) and
   * ignore this field. Omitted → counter line not rendered.
   */
  reviewCounter?: number
  /**
   * SIG-101: URL to the PR (used as the click target of the
   * `[🔄 Re-run review](URL)` retrigger link). GitHub doesn't
   * support pre-filled comment bodies on existing PRs, so the
   * link lands the user on the PR page; an accompanying sub-line
   * tells them to comment `/sigilix review` to re-run. Omitted →
   * retrigger CTA not rendered.
   */
  retriggerUrl?: string
  /**
   * SIG-216: when present, body-only finding anchors render as
   * clickable `[path:line](https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>)`
   * markdown links instead of the back-compat inline-code shape
   * (`` `path:line` ``). Threaded through `renderBodyOnlyFindings`
   * → `formatBodyFindingAnchor`. Callers that haven't plumbed
   * owner/repo through (e.g. older unit tests) keep the
   * inline-code rendering.
   */
  linkContext?: BodyFindingLinkContext
}

/**
 * SIG-216: source-repo coordinates needed to build a GitHub blob
 * URL for a body-only finding anchor.
 */
export interface BodyFindingLinkContext {
  owner: string
  repo: string
  headSha: string
}

/**
 * ARC-281 / ARC-293 / SIG-94: APPROVE-posture body renderer.
 *
 * Shape (SIG-94 marker-only on every APPROVE):
 *   ```
 *   <!-- sigilix:pr-review -->
 *   ```
 *
 * Pure — exported for tests.
 */
export function renderApproveBody(_args: RenderBodyArgs): string {
  // SIG-94: marker-only on every APPROVE, regardless of coverage state.
  // GitHub's native "approved these changes" line is the entire
  // customer-visible signal. Degraded-coverage state remains observable
  // via the existing `ensemble-specialists-degraded` log event for
  // operators; customers do NOT need to see it on the PR.
  return `${SIGILIX_REVIEW_MARKER}\n`
}

/**
 * SIG-161 PR 4a — COMMENT-posture body renderer.
 *
 * Posted when the gate decides at least one finding is in the
 * borderline band `[FLOOR_SUPPRESS, chosenThreshold)` but none cross
 * the threshold. GitHub event is `COMMENT` — comments post but no
 * verdict change.
 *
 * Body shape mirrors `renderRequestChangesBody` for the finding layout,
 * but uses non-blocking copy and omits REQUEST_CHANGES-only affordances
 * so borderline findings don't read as blocker framing.
 *
 * In PR 4a this function is UNREACHABLE in production — the legacy
 * `chooseReviewEvent`'s narrowed return excludes "COMMENT". PR 4b
 * wires the shadow-mode log path; PR 4c wires `enforce`.
 *
 * Pure — exported for tests.
 */
export function renderCommentBody(args: RenderBodyArgs): string {
  // Strip pattern: denylist-by-name via rest spread so any new
  // optional field added to RenderBodyArgs later (a stack hint, a
  // delta variant, etc.) flows through without an opt-in step. The
  // ONLY two fields we omit are REQUEST_CHANGES-specific affordances.
  const { reviewCounter: _rc, retriggerUrl: _rt, ...stripped } = args
  void _rc
  void _rt
  return renderFindingsReviewBody(stripped, "comment")
}

/**
 * ARC-281: REQUEST_CHANGES-posture body renderer per Kimi K2.6's
 * spec.
 *
 * Shape (delta variant — Kimi sample 2b):
 *   ```
 *   <!-- sigilix:pr-review -->
 *
 *   ## Sigilix: 2 findings · since last review
 *
 *   **Changes:** +2 new · 3 likely-fixed
 *
 *   **Coverage:** logic · security · performance · tests
 *
 *   <verdict.summary paragraph> _(Stacked on #87)_
 *
 *   ### Fix Plan
 *   ...
 *
 *   ### Review Body Findings
 *   ...
 *
 *   To dismiss this review, push new commits or comment `@sigilix dismiss` in a review thread.
 *
 *   _Reviewed against `c6fdc29` at 2026-05-18T05:41:45.506Z._
 *   ```
 *
 * Pure — exported for tests.
 */
export function renderRequestChangesBody(args: RenderBodyArgs): string {
  return renderFindingsReviewBody(args, "request_changes")
}

type FindingsReviewPosture = "request_changes" | "comment"

function renderFindingsReviewBody(args: RenderBodyArgs, posture: FindingsReviewPosture): string {
  // SIG (Kimi K2.6 r1, 2026-05-27): compact redesign. Founder feedback:
  // the prior shape (H2 "Sigilix: N findings" + H3 "Fix Plan" + bold
  // severity subheading + bullets + 4 separate footer lines) had ~10
  // lines of chrome around 1 line of content for a single-finding
  // review. The "N findings" count in the header also didn't match
  // the Fix Plan count (Fix Plan shows score>=4 only) — readers had
  // no idea where lower-severity findings went.
  //
  // New shape (Kimi spec):
  //   <!-- sigilix:pr-review -->
  //
  //   **N high-severity findings** [+ M lower-severity inline] · coverage: ...
  //
  //   <summary paragraph>
  //
  //   | Severity | Location | Issue |
  //   |:---|:---|:---|
  //   | **High (4)** | `path:line` | category: headline |
  //
  //   <sub>Dismiss: `@sigilix dismiss` · Re-run: `/sigilix review` · Review #N · `sha`</sub>
  //
  // The H2/H3 headings are gone (GitHub already shows "Bot requested
  // changes" at the comment top), the Fix Plan severity subheading is
  // collapsed into a table row, and all 4 footer lines merge into one
  // `<sub>`. Body-only findings still get a separate section because
  // their failure mode (no inline thread possible) needs the
  // explanation copy.
  const inlineFindings = args.verdict.findings.filter((f) => findingScope(f) === "line")
  const bodyOnlyFindings = [
    ...(args.unanchored ?? []),
    ...args.verdict.findings.filter((f) => findingScope(f) !== "line"),
  ]
  const totalFindings = inlineFindings.length + bodyOnlyFindings.length
  const zeroFindingBlocker = posture === "request_changes" && totalFindings === 0
  // CR Major (PR #200): high-severity count must include body-only
  // findings too — an unanchored critical finding was rendering as
  // "**1 finding**" instead of "**1 high-severity finding**", which
  // weakens the prioritization signal in the compact lead line. The
  // lower-severity-inline count stays scoped to inline only — body-
  // only findings already get an explicit "+ N body" segment in the
  // lead, so counting them here too would double-count.
  const highOrCriticalCount =
    inlineFindings.filter((f) => f.score >= 4).length
    + bodyOnlyFindings.filter((f) => f.score >= 4).length
  const lowerSeverityInlineCount = inlineFindings.filter((f) => f.score < 4).length

  const lines: string[] = [SIGILIX_REVIEW_MARKER, ""]

  // Lead line — compact, bold, with coverage inlined. Drops the H2
  // heading entirely (the comment-header above already says "Sigilix
  // Bot requested changes" — a second H2 was redundant).
  const deltaBadge = args.delta ? renderDeltaBadge(args.delta) : null
  const coverageLine = args.coverage ? renderCoverageLine(args.coverage) : null
  // Strip the `**Coverage:**` prefix from the coverage line so we can
  // inline-append it after the lead. `renderCoverageLine` always emits
  // `**Coverage:** <rest>`, so the prefix strip is a stable contract.
  const coverageInline = coverageLine ? coverageLine.replace(/^\*\*Coverage:\*\* /, "coverage: ") : null
  let lead: string
  if (zeroFindingBlocker) {
    lead = "**Approval pending**"
  } else {
    const postureCopy = posture === "comment" ? "non-blocking " : ""
    const findingNoun = (n: number): string => (n === 1 ? "finding" : "findings")
    if (highOrCriticalCount === 0 && lowerSeverityInlineCount === 0 && bodyOnlyFindings.length > 0) {
      // All findings are body-only AND lower-severity (the high-
      // severity body-only case falls into the next branch via
      // highOrCriticalCount > 0 — CR Major fold).
      lead = `**${bodyOnlyFindings.length} ${postureCopy}${findingNoun(bodyOnlyFindings.length)}**`
    } else if (highOrCriticalCount === 0) {
      // Lower-severity inline only (no Fix Plan table).
      lead = `**${lowerSeverityInlineCount} ${postureCopy}${findingNoun(lowerSeverityInlineCount)}** posted inline`
    } else {
      // High-severity tier — includes body-only criticals per CR
      // Major. The "+ M lower-severity inline" clause tells the
      // reader where the rest live; body-only findings already get
      // their own "### Review Body Findings" section below so we
      // don't double-count them in the lead.
      lead = `**${highOrCriticalCount} ${postureCopy}high-severity ${findingNoun(highOrCriticalCount)}**`
      if (lowerSeverityInlineCount > 0) {
        lead += ` + ${lowerSeverityInlineCount} lower-severity inline`
      }
    }
  }
  const leadParts: string[] = [lead]
  if (deltaBadge) leadParts.push(deltaBadge.replace(/^\*\*Changes:\*\* /, "since last review: "))
  if (coverageInline) leadParts.push(coverageInline)
  lines.push(leadParts.join(" · "))

  // Summary paragraph (with optional stack-context parenthetical).
  const stackParen = renderStackParenthetical(args.stack)
  const summary = stackParen
    ? `${args.verdict.summary.trimEnd()} ${stackParen}`
    : args.verdict.summary
  lines.push("")
  if (zeroFindingBlocker) {
    lines.push(
      "Approval is pending because Sigilix has an unresolved policy-level blocker, " +
      "but no line-specific findings were rendered in this review.",
    )
    lines.push("")
  }
  lines.push(summary)

  // SIG-281 PR B (Rec 6 / Kimi K2.6): body-only blockers (score >= 4)
  // that can't anchor inline still belong in the scannable Fix Plan
  // table — otherwise a body-only-only P0 advertises "1 high-severity
  // finding" in the lead but has NO Fix Plan row, leaving the blocker
  // buried in the detail section. Split the body-only set by the blocker
  // floor:
  //   - blockers (score >= 4): feed the Fix Plan table (alongside inline
  //     findings) AND render their full evidence in a collapsed details
  //     block right after the table, so failureExample/fixExample survive
  //     without scroll-taxing the surface. They are NOT repeated in the
  //     lower "Review Body Findings" section.
  //   - non-blockers (score < 4): unchanged — the "Review Body Findings"
  //     section, with the load-bearing explanation copy.
  // The blocker stays VISIBLE (table row, never collapsed); only the
  // supplementary evidence is collapse-on-demand.
  const bodyOnlyBlockers = bodyOnlyFindings.filter((f) => f.score >= 4)
  const bodyOnlyNonBlockers = bodyOnlyFindings.filter((f) => f.score < 4)

  const fixPlanTable = renderFixPlanTable([...inlineFindings, ...bodyOnlyBlockers])
  if (fixPlanTable) {
    lines.push("")
    lines.push(fixPlanTable)
    if (bodyOnlyBlockers.length > 0) {
      // Clarify the table can contain non-inline-anchored rows.
      lines.push("")
      lines.push(FIX_PLAN_BODY_ONLY_CAPTION)
      // Full evidence for body-only blockers, collapsed by default.
      lines.push("")
      lines.push("<details>")
      lines.push(BODY_ONLY_BLOCKER_DETAILS_SUMMARY)
      lines.push("")
      lines.push(...renderBodyOnlyFindings(bodyOnlyBlockers, args.linkContext))
      lines.push("")
      lines.push("</details>")
    }
  }

  // Body-only findings BELOW the blocker floor (score < 4) — unanchored
  // or non-line-scoped or inline-cap overflow. The explanation copy is
  // load-bearing (these can't anchor to a diff line, or overflowed the
  // inline cap). Blockers were rendered above (table + collapsed
  // evidence) and are intentionally excluded here to avoid duplication.
  if (bodyOnlyNonBlockers.length > 0) {
    lines.push("")
    lines.push(BODY_ONLY_FINDINGS_HEADING)
    lines.push("")
    lines.push(BODY_ONLY_FINDINGS_EXPLANATION)
    lines.push(...renderBodyOnlyFindings(bodyOnlyNonBlockers, args.linkContext))
  }

  // Single-line footer (replaces the four separate metadata lines).
  // Built separately from `lines` so the 65k cap can truncate the
  // body content without slicing through the footer's `<sub>` and
  // losing the SHA (Sigilix-bot HIGH + CR MINOR on PR #200 —
  // provenance invariant).
  const headShort = args.prov?.headSha ? args.prov.headSha.slice(0, 7) : null
  const footer = renderCompactReviewFooter({
    posture,
    reviewCounter: args.reviewCounter,
    headShort,
  })

  return capForGitHub(lines.join("\n"), footer)
}

/**
 * SIG (Kimi K2.6 r1): one-line footer that merges what used to be FOUR
 * separate metadata lines at the bottom of the review body — dismiss
 * hint, re-run hint, Review #N counter, "Reviewed against SHA at
 * TIMESTAMP" provenance. One `<sub>` block keeps the body lightweight
 * while preserving every piece of info the prior multi-line shape
 * provided.
 *
 * The timestamp is dropped because the GitHub comment header already
 * shows the "N minutes ago" timestamp at the top of the rendered
 * comment — two timestamps in the body for the same event was
 * redundant. The SHA stays because it's the only piece of info NOT
 * available from GitHub's chrome.
 */
function renderCompactReviewFooter(args: {
  posture: FindingsReviewPosture
  reviewCounter: number | undefined
  headShort: string | null
}): string {
  const parts: string[] = []
  if (args.posture === "request_changes") {
    parts.push("Dismiss: `@sigilix dismiss` in a review thread")
  }
  parts.push("Re-run: `/sigilix review`")
  if (typeof args.reviewCounter === "number" && args.reviewCounter > 0) {
    parts.push(`Review #${args.reviewCounter}`)
  }
  if (args.headShort) {
    parts.push(`\`${args.headShort}\``)
  }
  return `<sub>${parts.join(" · ")}</sub>`
}

// ARC-184: provenance footer + writer-side 65k cap.
//
// GitHub PR review bodies and issue comments are capped at 65,535
// chars. Sigilix's bodies almost never approach this (typical 2-8 KB),
// so the cap here is defense-in-depth — it preserves the footer
// exactly so the manifest's reviewed-at SHA always appears, and
// truncates the body content above with a marker that links the
// reader to the full review history.
const GH_BODY_CAP = 65000

function capForGitHub(body: string, footer: string): string {
  // SIG Kimi K2.6 r1 + Sigilix HIGH (PR #200): the compact footer
  // carries the SHA (the provenance invariant). It MUST survive the
  // 65k truncation — a naive tail-cut would slice through the `<sub>`
  // and break the invariant. So we cap by truncating BODY CONTENT
  // and re-appending the footer afterwards, the same shape the
  // pre-r1 renderProvenanceFooter / capForGitHub pair used.
  const joined = `${body}\n\n${footer}`
  if (joined.length <= GH_BODY_CAP) return joined
  const TRUNC = "\n\n_[summary truncated to fit GitHub's 65535 limit]_"
  const overhead = TRUNC.length + footer.length + 4 // "\n\n" between body & footer + a hair
  const room = GH_BODY_CAP - overhead
  const truncated = body.slice(0, Math.max(0, room))
  return `${truncated}${TRUNC}\n\n${footer}`
}

/**
 * ARC-180: render the "Fix Plan" section listing score >= 4 findings
 * (high or critical) as a prioritized repair queue. Returns the
 * Markdown string ready to drop into the review body, or null when
 * there are no findings at that severity (in which case the section
 * is omitted entirely — no empty headers).
 *
 * Format:
 *   ### Fix Plan
 *
 *   **Critical (score 5)**
 *   - \`src/foo.ts:42\` — \`logic\`: Headline
 *   - \`src/bar.ts:88\` — \`security\`: Headline
 *
 *   **High (score 4)**
 *   - \`src/baz.ts:15\` — \`error-handling\`: Headline
 *
 * Within each severity, ordered by path then line so the queue stays
 * stable across runs (a reviewer working top-to-bottom can re-run
 * /sigilix review and the queue won't shuffle on them).
 *
 * Pure — exported for tests.
 */
export function renderFixPlan(findings: PrReviewFinding[]): string | null {
  const critical: PrReviewFinding[] = []
  const high: PrReviewFinding[] = []
  for (const f of findings) {
    if (f.score >= 5) critical.push(f)
    else if (f.score >= 4) high.push(f)
  }
  if (critical.length === 0 && high.length === 0) return null

  const sortByLocation = (a: PrReviewFinding, b: PrReviewFinding): number => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.line - b.line
  }
  critical.sort(sortByLocation)
  high.sort(sortByLocation)

  const lines: string[] = ["### Fix Plan"]
  if (critical.length > 0) {
    lines.push("")
    lines.push(`**Critical (score 5)** — ${critical.length} ${critical.length === 1 ? "finding" : "findings"}`)
    for (const f of critical) lines.push(formatFixPlanRow(f))
  }
  if (high.length > 0) {
    lines.push("")
    lines.push(`**High (score 4)** — ${high.length} ${high.length === 1 ? "finding" : "findings"}`)
    for (const f of high) lines.push(formatFixPlanRow(f))
  }
  return lines.join("\n")
}

/**
 * SIG (Kimi K2.6 r1): Fix Plan in compact table form. Replaces the
 * H3 heading + per-severity subheading + bullet list shape with a
 * single markdown table. ~50% less vertical space per row.
 *
 * Critical (score 5) and High (score 4) findings only — same filter
 * as `renderFixPlan`. Lower-severity findings are referenced in the
 * lead-line "+ N lower-severity inline" copy so the reader knows
 * where they went without surfacing them in the table.
 *
 * Pure — exported for tests.
 */
export function renderFixPlanTable(findings: PrReviewFinding[]): string | null {
  const eligible = findings
    .filter((f) => f.score >= 4)
    .sort((a, b) => {
      // Critical first, then high. Within each severity, sort by
      // path/line so the table is stable across runs.
      if (a.score !== b.score) return b.score - a.score
      if (a.path !== b.path) return a.path < b.path ? -1 : 1
      return a.line - b.line
    })
  if (eligible.length === 0) return null

  const lines: string[] = [
    "| Severity | Location | Issue |",
    "|:---|:---|:---|",
  ]
  for (const f of eligible) {
    // SIG-281 PR B (Rec 6 / Kimi Q3): the table can now contain body-only
    // blockers (file-level / PR-level scope) that have no specific diff
    // line. For those, show the path with NO `:line` suffix (the absence
    // of a line is the visual signal that the row isn't diff-anchored);
    // an empty path (pure PR-level) renders as "PR-level". Line- and
    // comment-scoped findings keep the `path:line` (or range) form.
    const scope = findingScope(f)
    const range =
      scope === "pr" || scope === "file"
        ? f.path.trim().length > 0
          ? f.path
          : "PR-level"
        : f.startLine != null && f.startLine !== f.line
          ? `${f.path}:${f.startLine}-${f.line}`
          : `${f.path}:${f.line}`
    const cleanHeadline = stripAstMarkers(f.headline)
    // Escape the pipe in headlines so a finding that says "use a | b"
    // doesn't collapse the table. Hand the reader a safer message and
    // a slightly longer truncation budget since each row is only one
    // line tall (vs prior bullet that could wrap visually).
    const safeHeadline = cleanHeadline.replace(/\|/g, "\\|")
    const headline = safeHeadline.length > 160 ? `${safeHeadline.slice(0, 157)}…` : safeHeadline
    const severityLabel = f.score >= 5 ? "**Critical (5)**" : "**High (4)**"
    lines.push(`| ${severityLabel} | \`${range}\` | \`${formatFindingCategory(f)}\`: ${headline} |`)
  }
  return lines.join("\n")
}

function formatFixPlanRow(f: PrReviewFinding): string {
  const range = f.startLine != null && f.startLine !== f.line
    ? `${f.path}:${f.startLine}-${f.line}`
    : `${f.path}:${f.line}`
  // Headline only — the inline comment carries the body. Truncate
  // defensively so an over-long headline can't break the bullet list.
  const cleanHeadline = stripAstMarkers(f.headline)
  const headline = cleanHeadline.length > 140 ? `${cleanHeadline.slice(0, 137)}…` : cleanHeadline
  return `- \`${range}\` — \`${formatFindingCategory(f)}\`: ${headline}`
}

function formatHeadSha(headSha: string): string {
  return headSha.slice(0, 7)
}

function withLineMovedNote(f: PrReviewFinding, headSha: string): PrReviewFinding {
  return {
    ...f,
    anchorNote: `(line moved — see file at \`${formatHeadSha(headSha)}\`)`,
  }
}

function formatBodyFindingLocation(f: PrReviewFinding): string {
  switch (findingScope(f)) {
    case "pr":
      return "PR-level"
    case "file":
      return "File-level"
    case "comment":
      return "Comment-level"
    case "line":
      return f.startLine != null && f.startLine !== f.line
        ? `Lines ${f.startLine}-${f.line}`
        : `Line ${f.line}`
  }
}

/**
 * Render the path:line anchor for a body-only finding.
 *
 * Back-compat (no `linkContext`): emits the inline-code shape
 * `` `path:line` `` so callers that haven't plumbed owner/repo/headSha
 * (older tests, the check-annotation path which strips backticks) keep
 * the prior rendering and don't break.
 *
 * SIG-216 (with `linkContext`): emits a clickable Markdown link
 * `[path:line](https://github.com/<owner>/<repo>/blob/<sha>/<path>#L<line>)`
 * with NO backticks (Greptile-direction per Kimi R3) so a reviewer
 * scanning the body can jump straight to the file at the reviewed SHA.
 *
 * URL shape by scope:
 *   - `pr`   → file at HEAD, no line anchor
 *   - `file` → same as `pr` (file-level, no line anchor)
 *   - `line` with range → `#L<startLine>-L<line>`
 *   - `line` single     → `#L<line>`
 */
function formatBodyFindingAnchor(
  f: PrReviewFinding,
  linkContext?: BodyFindingLinkContext,
): string {
  const scope = findingScope(f)
  const isPrOrFile = scope === "pr" || scope === "file"
  const label = isPrOrFile
    ? f.path
    : f.startLine != null && f.startLine !== f.line
      ? `${f.path}:${f.startLine}-${f.line}`
      : `${f.path}:${f.line}`
  if (!linkContext) {
    return `\`${label}\``
  }
  // SIG-216 fix-up: URL-encode each path segment + markdown-escape the
  // label. Filenames with spaces / parens / brackets otherwise produce
  // broken markdown links (a literal space in the URL is rejected by
  // GitHub; a `]` in the label truncates the link text). Segment-wise
  // encoding (not whole-path) preserves the `/` separators.
  const { owner, repo, headSha } = linkContext
  const encodedPath = encodePathSegments(f.path)
  const base = `https://github.com/${owner}/${repo}/blob/${headSha}/${encodedPath}`
  const url = isPrOrFile
    ? base
    : f.startLine != null && f.startLine !== f.line
      ? `${base}#L${f.startLine}-L${f.line}`
      : `${base}#L${f.line}`
  return `[${escapeMarkdownLinkLabel(label)}](${url})`
}

/**
 * SIG-216 fix-up: URL-encode each path segment individually so `/`
 * separators stay intact. `encodeURIComponent` on the whole path would
 * turn `/` into `%2F`, breaking the blob URL.
 *
 * We also explicitly encode `(` → `%28` and `)` → `%29`. RFC 3986
 * leaves parens unreserved so `encodeURIComponent` doesn't touch them
 * — but parens are markdown's link-target delimiter (`](url)`), so a
 * raw `)` inside the URL terminates the link prematurely. Encoding
 * them is harmless on the GitHub side (it accepts either) and
 * mandatory for the markdown round-trip.
 */
function encodePathSegments(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/\(/g, "%28").replace(/\)/g, "%29"))
    .join("/")
}

/**
 * SIG-216 fix-up: backslash-escape markdown-special chars in a link
 * label so paths containing `[`, `]`, `(`, `)`, or `\` render as
 * literal text instead of truncating the link or opening a nested
 * group.
 */
function escapeMarkdownLinkLabel(text: string): string {
  return text.replace(/([\\[\]()])/g, "\\$1")
}

function formatBodyFindingSeverity(f: PrReviewFinding): string {
  if (f.score >= 5) return "critical, score 5"
  if (f.score >= 4) return "high, score 4"
  return `score ${f.score}`
}

function formatFindingCategory(f: PrReviewFinding): string {
  return f.category ?? "logic"
}

/**
 * Sort findings by severity DESC, then path, then line, and render a
 * compact Markdown list. Body-only findings deliberately do not use
 * standalone file headings: if GitHub could not create an inline
 * thread, a naked filename header looks like lost context rather than
 * a deliberate fallback surface.
 *
 * SIG-216: the meta sub-line under each finding was tightened from
 * `<location> (<severity>) · <anchor>` to just `<anchor> · score N`.
 * "File-level" / "Comment-level" / "Line N" is implicit from the
 * anchor shape; the bracketed severity duplicates the P0/P1/P2/P3
 * badge that already prefixes the headline. The middle-dot separator
 * is U+00B7 (`·`).
 *
 * `linkContext` (optional) makes the anchor a clickable GitHub blob
 * URL; absent it the anchor falls back to the back-compat inline-code
 * shape so callers that haven't plumbed owner/repo through don't
 * break.
 *
 * Returns an array of lines (caller joins with `\n`). Pure.
 */
function renderBodyOnlyFindings(
  findings: PrReviewFinding[],
  linkContext?: BodyFindingLinkContext,
): string[] {
  const sorted = [...findings].sort((a, b) =>
    b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
  )
  const lines: string[] = []
  for (const f of sorted) {
    const anchor = formatBodyFindingAnchor(f, linkContext)
    const anchorNote = f.anchorNote ? ` · ${f.anchorNote}` : ""
    const badge = severityBadgeForScore(f.score)
    const categoryBadge = categoryBadgeForFinding(f)
    lines.push("")
    lines.push(`- ${badge} ${categoryBadge} **${stripAstMarkers(f.headline)}**`)
    lines.push(`  <sub>${anchor} · score ${f.score}${anchorNote}</sub>`)
    // Indent the body so it nests under the bullet visually.
    const detailLines = [
      formatFindingBodyMarkdown(f.body),
      formatFindingStructuredDetailsMarkdown(f),
      formatBodyFindingSuggestedChange(f),
    ].filter((s) => s !== "")
    const bodyLines = detailLines
      .join("\n\n")
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")
    lines.push(bodyLines)
  }
  return lines
}

export const CHECK_ANNOTATION_TEXT_LIMIT = 60000
export const CHECK_ANNOTATION_TITLE_LIMIT = 240

export function buildBodyOnlyCheckAnnotations(findings: PrReviewFinding[]): CheckRunAnnotation[] {
  const sorted = [...findings].sort((a, b) =>
    b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line,
  )
  return sorted
    .filter((f) => f.path.trim().length > 0 && Number.isFinite(f.line) && f.line > 0)
    .map((f) => {
      const start = Math.max(1, Math.min(f.startLine ?? f.line, f.line))
      const end = Math.max(start, Math.max(f.startLine ?? f.line, f.line))
      const category = formatFindingCategory(f)
      const priority = severityLabelForScore(f.score)
      const anchor = formatBodyFindingAnchor(f).replace(/`/g, "")
      const location = formatBodyFindingLocation(f)
      const title = truncateCheckAnnotationText(
        `[${priority}] ${category}: ${stripAstMarkers(f.headline)}`,
        CHECK_ANNOTATION_TITLE_LIMIT,
      )
      const message = truncateCheckAnnotationText(
        [
          formatFindingBodyMarkdown(f.body),
          formatFindingStructuredDetailsMarkdown(f),
          "",
          `${location} (${formatBodyFindingSeverity(f)}) · ${anchor}${f.anchorNote ? ` · ${f.anchorNote}` : ""}`,
        ].filter((s) => s !== "").join("\n"),
        CHECK_ANNOTATION_TEXT_LIMIT,
      )
      const rawDetails = formatBodyFindingSuggestedChange(f)
      const annotation: CheckRunAnnotation = {
        path: f.path,
        start_line: start,
        end_line: end,
        annotation_level: checkAnnotationLevelForScore(f.score),
        title,
        message,
      }
      if (rawDetails) {
        annotation.raw_details = truncateCheckAnnotationText(rawDetails, CHECK_ANNOTATION_TEXT_LIMIT)
      }
      return annotation
    })
}

function checkAnnotationLevelForScore(score: number): CheckRunAnnotation["annotation_level"] {
  if (score >= 5) return "failure"
  if (score >= 3) return "warning"
  return "notice"
}

function truncateCheckAnnotationText(value: string, max: number): string {
  const clean = stripAstMarkers(value).trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/**
 * SIG-101: severity badge prefix on inline finding comments. Scores
 * map to Greptile-style P0/P1/P2 priority tags so a reviewer scanning
 * a thread sees severity at a glance instead of having to follow the
 * link to the Fix Plan or read the score field. Score 1-2 is
 * informational — no badge, the category prefix is signal enough.
 *
 * Pure — exported for tests.
 */
/**
 * SIG-164/SIG-200: replace the prior emoji badges with SVG chips
 * matching Greptile/CR convention — a compact colored chip rendered
 * inline via `<img>` tag. The assets use path-drawn glyphs rather than
 * font text so GitHub cannot fall back to a generic typeface. Severity map:
 *   - score 5  → P0 (critical / merge-blocker)
 *   - score 4  → P1 (high)
 *   - score 3  → P2 (medium)
 *   - score 1-2 → P3 (low / nit)
 *
 * Always returns a string (was `string | null`) — P3 covers the prior
 * low-severity null case, so every finding now carries a visible
 * classification.
 */
const FINDING_BODY_PREVIEW_LIMIT = 500
const FINDING_STRUCTURED_DETAIL_LIMIT = 2000
const WHY_NOT_CAUGHT_LABEL = "Why this wasn't caught"

function badgeImg(file: ReviewBadgeAssetName): string {
  const label = badgeAssetLabel(file)
  // SIG-238 r9 pattern. Empirical: this combo defeats Primer's bubble
  // rule on github.com PR comments. Specifically:
  //   - `<a href="#">` WRAP (we used to drop this per r4; that
  //     diagnosis was wrong — the anchor is REQUIRED, not harmful).
  //   - `<img>` with `align="top"` and NO explicit width/height. The
  //     missing dimensions appear to suppress whichever Primer CSS
  //     rule paints `bgColor-muted` under the image (the "bubble"
  //     visible in r7).
  // Why this works: not fully understood — empirical. See
  // `badge-geometry.ts:BADGE_PADDING_PX` for r4-through-r9 history.
  return `<a href="#"><img alt="${label}" src="${badgeAssetUrl(file)}" align="top"></a>`
}

function severityBadgeImg(file: "p0" | "p1" | "p2" | "p3"): string {
  return badgeImg(file)
}

export function severityLabelForScore(score: number): "P0" | "P1" | "P2" | "P3" {
  if (score >= 5) return "P0"
  if (score >= 4) return "P1"
  if (score >= 3) return "P2"
  return "P3"
}

export function severityBadgeForScore(score: number): string {
  const label = severityLabelForScore(score)
  const file = label.toLowerCase() as "p0" | "p1" | "p2" | "p3"
  return severityBadgeImg(file)
}

function categoryBadgeAssetName(category: FindingCategory): ReviewBadgeAssetName {
  return category
}

function categoryBadgeForFinding(finding: PrReviewFinding): string {
  const category = formatFindingCategory(finding) as FindingCategory
  return badgeImg(categoryBadgeAssetName(category))
}

function stripAstMarkers(text: string): string {
  return text.replace(/<!--\s*ast\/[\s\S]*?-->/g, "").trim()
}

function formatFindingBodyMarkdown(body: string): string {
  const clean = stripAstMarkers(body)
  if (clean.length <= FINDING_BODY_PREVIEW_LIMIT) return clean
  // SIG-216: word-boundary-aware truncation. Find the last whitespace
  // in `[0, FINDING_BODY_PREVIEW_LIMIT)` so a body like
  // "Add a unit test that mocks a chat stream..." becomes
  // "Add a unit test that mocks a..." in the preview and
  // "chat stream..." in the More Info disclosure — not the previous
  // mid-character "...mocks a c" / "hat stream..." split. When the
  // preview window contains no whitespace at all (artificial long
  // single token), fall back to the hard character slice so the
  // function still terminates.
  const sliceEnd = (() => {
    const hardSlice = clean.slice(0, FINDING_BODY_PREVIEW_LIMIT)
    const lastWs = hardSlice.search(/\s\S*$/)
    return lastWs > 0 ? lastWs : FINDING_BODY_PREVIEW_LIMIT
  })()
  const preview = clean.slice(0, sliceEnd).trimEnd()
  const rest = clean.slice(sliceEnd).trimStart()
  return [
    `${preview}...`,
    "",
    "<details><summary>More Info</summary>",
    "",
    rest,
    "",
    "</details>",
  ].join("\n")
}

function formatFenceSection(label: string, content: string, lang: string): string {
  const clean = stripAstMarkers(content).trim()
  if (clean.length === 0) return ""
  const fence = fenceForContent(clean)
  return [label, fence + lang, clean, fence].join("\n")
}

function isDeletionSuggestion(finding: PrReviewFinding): boolean {
  const repl = finding.suggestedReplacement
  return finding.kind === "delete" && typeof repl === "string" && repl.length === 0
}

function isReplacementSuggestion(finding: PrReviewFinding): boolean {
  const repl = finding.suggestedReplacement
  return (
    (finding.kind === "replace" || finding.kind === undefined) &&
    typeof repl === "string" &&
    repl.length > 0
  )
}

function hasStructuredFix(finding: PrReviewFinding): boolean {
  return isDeletionSuggestion(finding) || isReplacementSuggestion(finding)
}

function formatFindingStructuredDetailsMarkdown(
  finding: PrReviewFinding,
  opts: { includeFixExample?: boolean } = {},
): string {
  const includeFixExample = opts.includeFixExample ?? !hasStructuredFix(finding)
  const sections: string[] = []
  if (finding.failureExample) {
    const section = formatFenceSection("**Example:**", finding.failureExample, "text")
    if (section) sections.push(section)
  }
  if (includeFixExample && finding.fixExample) {
    const lang = extensionToFenceLang(finding.path)
    const section = formatFenceSection("**Suggested fix:**", finding.fixExample, lang)
    if (section) sections.push(section)
  }
  if (finding.testGap) {
    const clean = stripAstMarkers(finding.testGap).trim()
    if (clean) sections.push(`**${WHY_NOT_CAUGHT_LABEL}:** ${clean}`)
  }
  return sections.join("\n\n")
}

function formatBodyFindingSuggestedChange(finding: PrReviewFinding): string {
  const repl = finding.suggestedReplacement
  const isDeletion = isDeletionSuggestion(finding)
  const isReplace = isReplacementSuggestion(finding)
  if (isDeletion) {
    const range =
      finding.startLine != null && finding.startLine < finding.line
        ? `lines ${finding.startLine}-${finding.line}`
        : `line ${finding.line}`
    return `**Suggested change:** remove ${range}.`
  }
  if (!isReplace || typeof repl !== "string") return ""
  const lang = extensionToFenceLang(finding.path)
  const fence = fenceForContent(repl)
  return [
    "**Suggested change:**",
    fence + lang,
    repl.replace(/\n$/, ""),
    fence,
  ].join("\n")
}

/**
 * SIG-101: resolve a finding's per-finding confidence, falling back to
 * the verdict-level value when the model didn't supply one. The
 * fallback is deliberate — the renderer always wants a number to
 * print, and "as confident as the verdict overall" is the most
 * defensible default when the model gives one score for everything.
 *
 * Pure — exported for tests.
 */
export function resolveFindingConfidence(
  finding: PrReviewFinding,
  verdictConfidence: number,
): number {
  if (typeof finding.confidence === "number" &&
      Number.isFinite(finding.confidence) &&
      finding.confidence >= 1 &&
      finding.confidence <= 5) {
    return finding.confidence
  }
  // Clamp the fallback defensively in case a caller passes a bad
  // verdict-confidence value.
  return Math.max(1, Math.min(5, Math.round(verdictConfidence)))
}

/**
 * SIG-125: map a file path's extension to a Markdown fence language for
 * the non-committable "Proposed change" snippet. Empty string when
 * unknown (renders a plain fence). Pure — exported for tests.
 */
const FENCE_LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
  mts: "ts", cts: "ts", json: "json", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", sh: "bash", yml: "yaml",
  yaml: "yaml", toml: "toml", css: "css", html: "html", sql: "sql",
  md: "markdown",
}
export function extensionToFenceLang(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return ""
  const ext = path.slice(dot + 1).toLowerCase()
  // `Object.hasOwn` guard: a path like `x.constructor` / `x.__proto__`
  // would otherwise resolve to an inherited Object.prototype member
  // (`?? ""` doesn't catch a non-nullish function/object), emitting a
  // broken fence label.
  return Object.hasOwn(FENCE_LANG_BY_EXT, ext) ? FENCE_LANG_BY_EXT[ext]! : ""
}

/**
 * SIG-125: a Markdown fence long enough to wrap `content` — one backtick
 * longer than the longest backtick run inside it (min 3). Lets the
 * non-committable snippet safely contain code that itself uses fences.
 */
export function fenceForContent(content: string): string {
  let maxRun = 0
  let cur = 0
  for (const ch of content) {
    if (ch === "`") {
      cur += 1
      if (cur > maxRun) maxRun = cur
    } else {
      cur = 0
    }
  }
  return "`".repeat(Math.max(3, maxRun + 1))
}

// SIG-125: confidence floor at/above which a finding's
// `suggestedReplacement` is eligible to render as a committable
// ```suggestion (still gated on clean anchorability).
const HIGH_CONFIDENCE_FLOOR = 4

export interface ProposedChangeScopeMismatch {
  anchorLines: number
  replacementLines: number
  replacementToAnchorRatio: number
}

function countReplacementLines(replacement: string): number {
  const normalized = replacement.replace(/\n$/, "")
  if (normalized.length === 0) return 0
  return normalized.split("\n").length
}

function referencesMultipleSpecificLines(body: string): boolean {
  return /\blines?\s+\d+(?:\s*(?:,|\band\b)\s*(?:and\s+)?\d+)+\b/i.test(body)
}

// SIG-179: below this ratio, a replacement is treated as much smaller
// than its anchor and the illustrative Current/Proposed block is skipped.
const SCOPE_MISMATCH_RATIO_THRESHOLD = 0.5

export function getProposedChangeScopeMismatch(finding: PrReviewFinding): ProposedChangeScopeMismatch | null {
  const repl = finding.suggestedReplacement
  const isReplace =
    (finding.kind === "replace" || finding.kind === undefined) &&
    typeof repl === "string" && repl.length > 0
  if (!isReplace) return null
  if (!referencesMultipleSpecificLines(finding.body)) return null

  const startL =
    finding.startLine != null && finding.startLine < finding.line
      ? finding.startLine
      : finding.line
  const anchorLines = Math.max(1, finding.line - startL + 1)
  const replacementLines = countReplacementLines(repl)
  const replacementToAnchorRatio = replacementLines / anchorLines
  if (replacementToAnchorRatio >= SCOPE_MISMATCH_RATIO_THRESHOLD) return null
  return { anchorLines, replacementLines, replacementToAnchorRatio }
}

/**
 * SIG-127: classify a finding's anchored added-line TEXT as substantive
 * code or a structural line. File/block-level findings (e.g. "lacks
 * integration tests") often get anchored by the model to a structural
 * line — a bare `}`, a blank line — and then render as an inline
 * comment "on an empty line." Such findings are routed to the review
 * summary body instead (see `buildReviewSubmission`).
 *
 * Non-substantive when `text` is undefined, empty/whitespace-only, or
 * consists ONLY of structural punctuation/whitespace
 * (`{ } ( ) [ ] ; ,` and whitespace). Substantive otherwise.
 *
 * Pure — exported for tests.
 */
export function isSubstantiveAnchorLine(text: string | undefined): boolean {
  if (text === undefined) return false
  if (text.trim() === "") return false
  return !/^[\s{}()[\];,]*$/.test(text)
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
 * SIG-164 (PR 5): render the "Current / Proposed" illustrative code
 * blocks inside a finding's body — Greptile-style. Always shown when
 * the finding has a localized change in scope (replace / delete),
 * regardless of whether the suggestion is committable. The committable
 * ```suggestion block (when emitted) is ADDITIVE — separate, sits
 * below this block.
 *
 * Shape:
 *
 *   **Current:**
 *   ```lang
 *   <addedLineTextByPath[path][startLine..line] joined with \n>
 *   ```
 *
 *   **Proposed:**
 *   ```lang
 *   <suggestedReplacement>
 *   ```
 *
 * For `kind === "delete"` (suggestedReplacement === ""): only the
 * **Current:** block (no Proposed — the proposal IS the deletion of
 * what's shown above).
 *
 * For `kind === "describe"` or absent / no suggestedReplacement: returns
 * "" (no block). The body prose already covers the description.
 *
 * Returns "" when there's no actionable "Current" content to show
 * (e.g., the diff context isn't available, or the model anchored to
 * lines that aren't in the added-lines map).
 *
 * Pure — exported for tests.
 */
export function formatProposedChangeBlock(
  finding: PrReviewFinding,
  addedLineTextByPath?: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string {
  const repl = finding.suggestedReplacement
  const isDeletion = finding.kind === "delete" && typeof repl === "string" && repl.length === 0
  const isReplace =
    (finding.kind === "replace" || finding.kind === undefined) &&
    typeof repl === "string" && repl.length > 0
  if (!isDeletion && !isReplace) return ""

  // SIG-179: when a very small replacement is paired with a broad
  // anchor and the prose names multiple exact lines, showing the full
  // anchor as "Current" makes a local patch look like a wholesale
  // rewrite. Keep the committable suggestion path, but skip this
  // illustrative block.
  if (getProposedChangeScopeMismatch(finding) !== null) return ""

  // Pull the current-state lines from the diff context (added lines on
  // the finding's range). When the map is absent or doesn't include
  // any of the range lines, we can't render an honest "Current" block
  // — return "" rather than emit a misleading empty fence.
  const startL =
    finding.startLine != null && finding.startLine < finding.line
      ? finding.startLine
      : finding.line
  const endL = finding.line
  const addedLines = addedLineTextByPath?.get(finding.path)
  const currentLines: string[] = []
  if (addedLines) {
    for (let n = startL; n <= endL; n++) {
      const text = addedLines.get(n)
      if (text !== undefined) currentLines.push(text)
    }
  }
  if (currentLines.length === 0) return ""

  const lang = extensionToFenceLang(finding.path)
  const out: string[] = []
  // Each block uses its own fence so a backtick run in user code can't
  // close both at once. We also pick a long-enough fence for the
  // replacement specifically.
  const currentFence = fenceForContent(currentLines.join("\n"))
  out.push("**Current:**", currentFence + lang, ...currentLines, currentFence)

  if (isReplace && typeof repl === "string") {
    const propFence = fenceForContent(repl)
    out.push("")
    out.push("**Proposed:**", propFence + lang, repl.replace(/\n$/, ""), propFence)
  }
  return out.join("\n")
}

/**
 * SIG-164 (PR 5): "Prompt To Fix With AI" block — mirrors Greptile's
 * exact summary + body shape (no leading emoji; the words are the
 * affordance). Folds the finding into a structured Markdown prompt
 * that a reviewer can copy-paste into any LLM-based fix tool (Cursor,
 * Aider, Claude Code, etc.). Always appended at the bottom of
 * `formatFindingComment` so it never displaces the prose, and wrapped
 * in `<details>` so collapsed-by-default.
 *
 * Pure — exported for tests.
 */
export function formatAiAgentPromptBlock(finding: PrReviewFinding): string {
  const range =
    finding.startLine != null && finding.startLine < finding.line
      ? `${finding.startLine}-${finding.line}`
      : String(finding.line)
  // The inner prompt body is wrapped in a fenced code block so the
  // structured prompt is visually demarcated AND copy-pasteable into
  // an AI assistant without picking up the surrounding GitHub Markdown
  // chrome (the badge image, the heading, the suggestion block).
  // Use ` ```text ` (not ` ```ts `) — the body is prose, not code, and
  // a `ts` fence would syntax-highlight English. The literal output
  // includes the inner markdown (e.g. `**headline**`) as plain text;
  // that's intentional — the AI assistant gets the unrendered prompt
  // identical to what we'd hand it via copy-paste.
  const promptLines = [
    "This is a comment left during a code review.",
    `Path: ${finding.path}`,
    `Line: ${range}`,
    "",
    "Comment:",
    `**${stripAstMarkers(finding.headline)}**`,
    "",
    stripAstMarkers(finding.body),
  ]
  if (finding.failureExample) {
    promptLines.push("", "Example:", stripAstMarkers(finding.failureExample))
  }
  if (finding.fixExample) {
    promptLines.push("", "Suggested fix shape:", stripAstMarkers(finding.fixExample))
  }
  if (finding.testGap) {
    promptLines.push("", `${WHY_NOT_CAUGHT_LABEL}:`, stripAstMarkers(finding.testGap))
  }
  promptLines.push("", "How can I resolve this? If you propose a fix, please make it concise.")
  const promptBody = promptLines.join("\n")
  const fence = fenceForContent(promptBody)
  return [
    "<details><summary>Prompt To Fix With AI</summary>",
    "",
    fence + "text",
    promptBody,
    fence,
    "",
    "</details>",
  ].join("\n")
}

/**
 * Inline finding comment, greptile-style. The headline carries the
 * bold line and the badge carries visible severity. Body and any
 * ```suggestion block flow underneath verbatim.
 *
 * SIG-101: prefixed with a P0/P1/P2/P3 severity badge. When
 * confidence ≤ 2, the body is collapsed inside a `<details>` block so
 * noisy low-confidence findings de-emphasize visually but the headline
 * stays visible.
 *
 * Pure — exported for tests. The `confidence` arg is the
 * already-resolved per-finding confidence (see
 * `resolveFindingConfidence`), passed in explicitly so the function
 * stays pure and snapshot-testable.
 */
export function formatFindingComment(
  finding: PrReviewFinding,
  confidence: number,
  reviewable?: ReviewableMap,
  addedLineTextByPath?: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string {
  const lines: string[] = ["<!-- sigilix:pr-review-finding -->"]
  // SIG-164 PR 5: badge is always present (P3 covers low severity).
  // Heading shape: <img badge> **headline**. Category, severity, and
  // confidence stay machine-readable through hidden markers instead of
  // repeating as visible metadata on every stacked thread.
  const badge = severityBadgeForScore(finding.score)
  const categoryBadge = categoryBadgeForFinding(finding)
  const headline = stripAstMarkers(finding.headline)
  const body = formatFindingBodyMarkdown(finding.body)
  lines.push(`${badge} ${categoryBadge} **${headline}**`)
  lines.push(`<!-- sigilix:category:${formatFindingCategory(finding)} -->`)
  lines.push(`<!-- sigilix:severity:${finding.score} -->`)
  lines.push(`<!-- sigilix:confidence:${confidence} -->`)
  lines.push("")
  const structuredDetails = formatFindingStructuredDetailsMarkdown(finding)
  if (confidence <= 2 && finding.score < 4) {
    // Low-confidence findings collapse the body so the thread skims
    // cleanly. The headline + severity badge + confidence suffix stay
    // visible so a reviewer can still triage without expanding.
    // SIG-281 PR A: but NEVER collapse a P0/P1 (score >= 4) — burying a
    // high-severity finding behind `<details>` even at low confidence
    // hurts believability more than the skim-noise it saves.
    lines.push("<details>")
    lines.push("<summary>Low-confidence finding — expand to read</summary>")
    lines.push("")
    lines.push(body)
    if (structuredDetails) {
      lines.push("")
      lines.push(structuredDetails)
    }
    lines.push("")
    lines.push("</details>")
  } else {
    lines.push(body)
    if (structuredDetails) {
      lines.push("")
      lines.push(structuredDetails)
    }
  }
  // SIG-282 Phase 3: append a deterministic, vetted remediation for a
  // confirmed security finding, keyed by its CWE bucket — rather than
  // relying on LLM-authored remediation prose. The model describes the
  // problem (the body); the system supplies the standard fix guidance.
  const remediation = remediationForFinding(finding)
  if (remediation) {
    lines.push("")
    lines.push(`**Remediation:** ${remediation}`)
  }
  // SIG-164 PR 5: Greptile-style "Current / Proposed" illustrative
  // blocks. Always shown when we have enough diff context to render an
  // honest "Current" snippet. Independent of committable-ness.
  const proposedBlock = formatProposedChangeBlock(finding, addedLineTextByPath)
  if (proposedBlock !== "") {
    lines.push("")
    lines.push(proposedBlock)
  }
  // SIG-125 / SIG-162 PR 5: committable ```suggestion block. Additive
  // on top of the illustrative block above when:
  //   - confidence >= HIGH_CONFIDENCE_FLOOR
  //   - reviewable map is supplied
  //   - finding's range is RIGHT-reviewable contiguously (suggestion
  //     applyability requirement — stricter than the comment-anchor
  //     check; see `isFindingAnchorable` vs `isCommentAnchorable`)
  //   - replacement contains no 3+ backtick run that would close the
  //     fence (replacements only — deletions have empty content).
  const repl = finding.suggestedReplacement
  const isDeletion = isDeletionSuggestion(finding)
  const hasReplacement = isReplacementSuggestion(finding) && typeof repl === "string"
  const fenceSafe = isDeletion || (hasReplacement && repl !== undefined && !/`{3,}/.test(repl))
  const committable =
    fenceSafe &&
    confidence >= HIGH_CONFIDENCE_FLOOR &&
    reviewable !== undefined &&
    isFindingAnchorable(finding, reviewable)
  if (committable && isDeletion) {
    lines.push("")
    lines.push("```suggestion", "", "```")
  } else if (committable && hasReplacement && repl !== undefined) {
    lines.push("")
    lines.push("```suggestion", repl.replace(/\n$/, ""), "```")
  } else if (proposedBlock === "" && isDeletion) {
    // Last-resort fallback for a deletion when neither the illustrative
    // block (no diff context) nor the committable suggestion (out of
    // hunk) could render — a descriptive prose note so the reader at
    // least knows what's intended.
    const range =
      finding.startLine != null && finding.startLine < finding.line
        ? `lines ${finding.startLine}-${finding.line}`
        : `line ${finding.line}`
    lines.push("")
    lines.push(`**Proposed change:** remove ${range}.`)
  } else if (proposedBlock === "" && hasReplacement && repl !== undefined) {
    // Last-resort fallback for a replacement when the illustrative
    // block couldn't render — show a non-committable code-snippet
    // tier as we did before SIG-164.
    const lang = extensionToFenceLang(finding.path)
    const fence = fenceForContent(repl)
    lines.push("")
    lines.push("**Proposed change:**", fence + lang, repl.replace(/\n$/, ""), fence)
  }
  // SIG-164 PR 5: copy-pastable AI-agent prompt block at the very
  // bottom. Collapsed by default. Never displaces prose; reader can
  // expand to grab a structured prompt for an LLM-based fix tool.
  lines.push("")
  lines.push(formatAiAgentPromptBlock(finding))
  return lines.join("\n")
}

/**
 * SIG-125: a finding's anchored range `[startLine ?? line, line]` is
 * committable iff every line is RIGHT-reviewable (matches GitHub's
 * ```suggestion applyability requirement).
 */
function isFindingAnchorable(finding: PrReviewFinding, reviewable: ReviewableMap): boolean {
  if (deriveSide(reviewable, finding.path, finding.line) !== "RIGHT") return false
  const start = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
  return isContiguousRightRange(reviewable, finding.path, start, finding.line)
}

/**
 * SIG-164 (PR 5): GitHub multi-line PR review comments require only that
 * the `start_line` and `line` endpoints are on the diff (same side) —
 * in-between lines may be unchanged context within the same hunk. This
 * is laxer than `isFindingAnchorable` (which requires every line to be
 * RIGHT-reviewable contiguously — correct for committable suggestions
 * but too strict for the COMMENT anchor itself).
 *
 * Used by `buildReviewSubmission` to decide whether to emit `start_line`
 * on a multi-line comment. When the model picks a wide range covering a
 * whole function (per the SIG-164 prompt update) but some interior
 * lines are context (unchanged) rather than added, this returns true
 * and the comment renders with the full function as inline context.
 *
 * Pure — exported for tests.
 */
export function isCommentAnchorable(
  reviewable: ReviewableMap,
  path: string,
  startLine: number | undefined,
  line: number,
): boolean {
  if (deriveSide(reviewable, path, line) !== "RIGHT") return false
  if (startLine === undefined || startLine >= line) return true
  return deriveSide(reviewable, path, startLine) === "RIGHT"
}
