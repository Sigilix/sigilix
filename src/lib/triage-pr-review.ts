// Proactive primary review (greptile-style). Reviews the PR in
// isolation — does its own pass independent of CR or any other
// reviewer. Each finding is anchored to a specific line, scored 1-5,
// and tagged with a category (logic / style / security / etc.) that
// leads the inline comment.
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
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { SIGILIX_BOT_LOGIN } from "./dismiss-prior-reviews"
import { parseFirstJsonObject } from "./json-extract"
import { type StackContext } from "./pr-stack"
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

type ReviewEvent = "APPROVE" | "REQUEST_CHANGES"

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
    findings: v.findings.map((f) => ({
      ...f,
      headline: wrapInlineHtmlTags(f.headline),
      body: wrapInlineHtmlTags(f.body),
    })),
  }
}

function sanitizeFindingsForGitHub(
  findings: ReadonlyArray<PrReviewFinding>,
): PrReviewFinding[] {
  return findings.map((f) => ({
    ...f,
    headline: wrapInlineHtmlTags(f.headline),
    body: wrapInlineHtmlTags(f.body),
  }))
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

export interface PrReviewFinding {
  path: string
  line: number
  startLine?: number
  score: number
  category: FindingCategory
  headline: string
  body: string
  /**
   * ARC-182: optional stack-origin tag. Emitted only when the input
   * prompt included a [STACK CONTEXT] block; absent for unstacked PRs.
   * Schema-bypass paths with an unknown value normalize to "current-pr".
   */
  stackOrigin?: StackOrigin
  /**
   * SIG-101: per-finding model confidence on a 1-5 scale (distinct from
   * `score`, which is severity). The synth specialist may emit a
   * per-finding confidence; when absent, callers default to the
   * verdict-level `confidence` field via `resolveFindingConfidence`
   * so every finding has a value downstream. `formatFindingComment`
   * renders the suffix `_confidence: N/5_` and wraps low-confidence
   * (≤2) bodies in a collapsed `<details>` block so noisy findings
   * de-emphasize.
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
}

export interface PrReviewVerdict {
  summary: string
  confidence: number
  confidenceReason: string
  findings: PrReviewFinding[]
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
 * ARC-281: per-Kimi spec the body now carries an explicit "**Δ:** +N
 * new · M likely-fixed" badge line under the heading instead of
 * prepending a `**Δ since last review:**` string into the summary.
 * Caller computes a `FindingDelta` via the existing
 * `computeFindingDelta` helper and passes the four counts through;
 * `renderDeltaBadge` formats them. Pure — exported for tests.
 *
 * Returns `null` when no signal is worth surfacing (all counts
 * zero), so the renderer can skip the line entirely rather than
 * print "**Δ:**".
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
  return `**Δ:** ${parts.join(" · ")}`
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

const DISMISSAL_HINT =
  "To dismiss this review, push new commits or comment `@sigilix dismiss` in a review thread."



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
    if (validStartLine != null) finalFinding.startLine = validStartLine
    if (stackOrigin) finalFinding.stackOrigin = stackOrigin
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
    findings.push(finalFinding)
    if (findings.length >= 8) break
  }

  return { summary, confidence, confidenceReason, findings }
}

interface BuildReviewArgs {
  verdict: PrReviewVerdict
  prAuthor: string | null
  headSha: string
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
   * markdown grouped by file. Without this, unanchored findings were
   * silently dropped on the success path of the orchestrator (only
   * the submit-fallback path recovered them). CodeRabbit + Sigilix
   * both caught the regression on PR #38.
   *
   * Default `[]` — the common case where every finding anchored
   * cleanly. When non-empty:
   *   - The chosen review event takes ALL findings into account
   *     (anchored + unanchored), so a verdict with only-unanchored
   *     blocking findings doesn't post as APPROVE.
   *   - The body grows with an `### Additional findings (could not
   *     anchor to diff)` section listing the unanchored set.
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
export function buildReviewSubmission({
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
}: BuildReviewArgs): SubmitReviewBody {
  // ARC-156 follow-up: sanitize every prose field for GitHub
  // rendering BEFORE downstream renderers see the verdict. Wraps
  // un-backticked HTML/JSX tags in backticks so an unclosed `<kbd>`
  // can't open a real DOM element that breaks paragraph rendering.
  const verdict = sanitizeVerdictForGitHub(rawVerdict)
  const unanchored = sanitizeFindingsForGitHub(rawUnanchored)
  // Event derivation merges anchored + unanchored so a verdict whose
  // only blocking findings happen to be unanchored doesn't post APPROVE
  // (CR + Sigilix PR #38 catch).
  const event = chooseReviewEvent([...verdict.findings, ...unanchored])
  const prov: ProvenanceCtx = nowMs !== undefined ? { headSha, nowMs } : { headSha }
  // ARC-281: dispatch directly to the new renderers instead of
  // routing through the legacy `formatReviewBody`. Posture is set by
  // `chooseReviewEvent` above.
  const renderArgs: RenderBodyArgs = { verdict, unanchored, prov }
  if (stack !== undefined) renderArgs.stack = stack
  if (coverage) renderArgs.coverage = coverage
  if (delta !== undefined) renderArgs.delta = delta
  // SIG-101: thread counter + retrigger URL through to the renderer.
  // APPROVE bodies stay marker-only (per SIG-94) and ignore these
  // fields, but it's cheaper / clearer to forward them unconditionally.
  if (typeof reviewCounter === "number") renderArgs.reviewCounter = reviewCounter
  if (retriggerUrl) renderArgs.retriggerUrl = retriggerUrl
  const body = event === "APPROVE"
    ? renderApproveBody(renderArgs)
    : renderRequestChangesBody(renderArgs)
  const comments: SubmitReviewComment[] = verdict.findings.map((f, i) => {
    // ARC-189: append per-finding sigilix marker on its own line so
    // the cross-PR review-memory capture pipeline can correlate
    // future reply dismissals back to this finding's category + tier.
    // Marker is hidden HTML — invisible in rendered Markdown but
    // visible to the marker extractor. Sparse: nullish entries skip.
    const marker = findingMarkers?.[i]
    // SIG-101: resolve per-finding confidence (verdict-level fallback)
    // and pass to the formatter so the inline comment carries the
    // P0/P1/P2 badge + `confidence: N/5` suffix.
    const confidence = resolveFindingConfidence(f, verdict.confidence)
    const baseBody = formatFindingComment(f, confidence)
    const fullBody = marker ? `${baseBody}\n\n${marker}` : baseBody
    const c: SubmitReviewComment = {
      path: f.path,
      line: f.line,
      side: "RIGHT",
      body: fullBody,
    }
    if (f.startLine != null) {
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
  return submission
}

interface BuildFallbackArgs {
  verdict: PrReviewVerdict
  unanchored: PrReviewFinding[]
  prAuthor: string | null
  headSha: string
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
}: BuildFallbackArgs): SubmitReviewBody {
  // ARC-156 follow-up: sanitize prose before rendering — same as
  // buildReviewSubmission, applied here for the anchorless-fallback
  // path so the body-rendered findings also get HTML-tag wrap.
  const verdict = sanitizeVerdictForGitHub(rawVerdict)
  const unanchored = sanitizeFindingsForGitHub(rawUnanchored)
  // Event derivation merges anchored + unanchored — same fix as
  // `buildReviewSubmission`. Without this, a verdict whose only
  // blocking findings are unanchored would post APPROVE while the
  // body lists blockers (CR + Sigilix PR #38 catch).
  const event = chooseReviewEvent([...verdict.findings, ...unanchored])
  const body = buildFallbackBody(
    verdict, unanchored, undefined, stack, coverage, delta, reviewCounter, retriggerUrl,
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
): string {
  // ARC-281: the anchorless-fallback path means GitHub silently
  // dropped the inline anchors, so the body must carry every
  // finding. Pour both `verdict.findings` and `unanchored` into the
  // single `unanchored` bucket of the new renderer — they render as
  // the "Additional findings (could not anchor to diff)" section
  // grouped by file, which is exactly the right place when none of
  // them landed inline. The Fix Plan (high/critical only) still
  // renders on top as a prioritized teaser.
  const all = [...verdict.findings, ...unanchored]
  const event = chooseReviewEvent(all)
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
  return renderRequestChangesBody(args)
}

export function chooseReviewEvent(
  findings: PrReviewFinding[],
  openItems: ReadonlyArray<AuthoredItem> = [],
): ReviewEvent {
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
 *     drives the `**Δ:** +N new · M likely-fixed` badge under the
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
  /** Findings that passed the hallucination guard but couldn't be
   *  anchored to a diff line. Surfaced via the "Additional findings"
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
 * ARC-281: REQUEST_CHANGES-posture body renderer per Kimi K2.6's
 * spec.
 *
 * Shape (delta variant — Kimi sample 2b):
 *   ```
 *   <!-- sigilix:pr-review -->
 *
 *   ## Sigilix: 2 findings · Δ since last review
 *
 *   **Δ:** +2 new · 3 likely-fixed
 *
 *   **Coverage:** logic · security · performance · tests
 *
 *   <verdict.summary paragraph> _(Stacked on #87)_
 *
 *   ### Fix Plan
 *   ...
 *
 *   ### Additional findings (could not anchor to diff)
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
  const unanchored = args.unanchored ?? []
  const totalFindings = args.verdict.findings.length + unanchored.length

  const lines: string[] = [SIGILIX_REVIEW_MARKER, ""]

  // Heading: "## Sigilix: N finding[s][ · Δ since last review]".
  const findingNoun = totalFindings === 1 ? "finding" : "findings"
  const deltaBadge = args.delta ? renderDeltaBadge(args.delta) : null
  const deltaSuffix = deltaBadge ? " · Δ since last review" : ""
  lines.push(`## Sigilix: ${totalFindings} ${findingNoun}${deltaSuffix}`)

  // Δ badge line — directly under heading, before coverage and
  // summary. Only present when delta has signal.
  if (deltaBadge) {
    lines.push("")
    lines.push(deltaBadge)
  }

  // Coverage line — full or degraded variant; absent when no
  // coverage args supplied (back-compat).
  const coverageLine = args.coverage ? renderCoverageLine(args.coverage) : null
  if (coverageLine) {
    lines.push("")
    lines.push(coverageLine)
  }

  // Summary paragraph (with optional stack-context parenthetical
  // appended to the LAST paragraph so it visually attaches to the
  // text rather than floating on its own line).
  const stackParen = renderStackParenthetical(args.stack)
  const summary = stackParen
    ? `${args.verdict.summary.trimEnd()} ${stackParen}`
    : args.verdict.summary
  lines.push("")
  lines.push(summary)

  // Fix Plan — high/critical findings (anchored + unanchored both
  // contribute since severity is the gate, not anchoring).
  const fixPlan = renderFixPlan([...args.verdict.findings, ...unanchored])
  if (fixPlan) {
    lines.push("")
    lines.push(fixPlan)
  }

  // Additional findings — unanchored set, grouped by file.
  if (unanchored.length > 0) {
    lines.push("")
    lines.push("### Additional findings (could not anchor to diff)")
    lines.push(...renderFindingsByFile(unanchored))
  }

  // Dismissal hint — REQUEST_CHANGES only, before the provenance
  // footer.
  lines.push("")
  lines.push(DISMISSAL_HINT)

  // SIG-101: retrigger hint. The original Greptile-style
  // `[🔄 Re-run review](URL)` button was dropped on founder feedback
  // 2026-05-19 — it read as visual noise inside the request-changes
  // body. The `<sub>` hint line remains as the discoverability
  // affordance: it tells the reader that re-running is a thing they
  // can do, without occupying header-weight real estate. GitHub
  // doesn't support pre-filled comment bodies on existing PRs, so a
  // URL-link wouldn't have actually triggered the rerun anyway.
  if (args.retriggerUrl) {
    lines.push("")
    lines.push("<sub>Comment `/sigilix review` on this PR to re-run on the current head.</sub>")
  }

  // SIG-101: per-PR review counter footer. 1-indexed (first review
  // is `#1`). The `last rendered` timestamp is the SAME wall-clock
  // value `renderProvenanceFooter` uses, so the two footers stay in
  // sync. APPROVE bodies render marker-only per SIG-94 and skip
  // this; only REQUEST_CHANGES bodies surface the counter.
  if (typeof args.reviewCounter === "number" && args.reviewCounter > 0) {
    const counterTs = new Date(args.prov?.nowMs ?? Date.now()).toISOString()
    lines.push("")
    lines.push(
      `_Sigilix · Review #${args.reviewCounter} for this PR · last rendered ${counterTs}._`,
    )
  }

  return capForGitHub(lines.join("\n"), args.prov)
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

function renderProvenanceFooter(prov: ProvenanceCtx | undefined): string | null {
  if (!prov || !prov.headSha) return null
  const headShort = prov.headSha.slice(0, 7)
  const ts = new Date(prov.nowMs ?? Date.now()).toISOString()
  return `_Reviewed against \`${headShort}\` at ${ts}._`
}

function capForGitHub(body: string, prov: ProvenanceCtx | undefined): string {
  const footer = renderProvenanceFooter(prov)
  // Always append the footer (or omit when there's no provenance ctx,
  // for backwards compatibility with callers that don't provide one).
  if (!footer) return body
  const withFooter = `${body}\n\n${footer}\n`
  if (withFooter.length <= GH_BODY_CAP) return withFooter
  // Truncate the body content (NOT the footer) and append a pointer
  // marker. The footer is appended below so the reader still sees
  // which head SHA the review was generated against.
  const TRUNC = "\n\n_[summary truncated to fit GitHub's 65535 limit]_"
  const overhead = TRUNC.length + footer.length + 4 // 4 = "\n\n" before footer + "\n" tail
  const room = GH_BODY_CAP - overhead
  const truncated = body.slice(0, Math.max(0, room))
  return `${truncated}${TRUNC}\n\n${footer}\n`
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

function formatFixPlanRow(f: PrReviewFinding): string {
  const range = f.startLine != null && f.startLine !== f.line
    ? `${f.path}:${f.startLine}-${f.line}`
    : `${f.path}:${f.line}`
  // Headline only — the inline comment carries the body. Truncate
  // defensively so an over-long headline can't break the bullet list.
  const headline = f.headline.length > 140 ? `${f.headline.slice(0, 137)}…` : f.headline
  return `- \`${range}\` — \`${f.category}\`: ${headline}`
}

/**
 * Group findings by file path, sort within each file by score DESC
 * then line ASC, and render as a Markdown bullet list. Shared by
 * `formatReviewBody` (when unanchored findings need to be surfaced
 * alongside the inline-anchored ones) and `buildFallbackBody` (when
 * the entire submission is anchorless and every finding lives in the
 * body).
 *
 * Returns an array of lines (caller joins with `\n`). Pure.
 */
function renderFindingsByFile(findings: PrReviewFinding[]): string[] {
  const byPath = new Map<string, PrReviewFinding[]>()
  for (const f of findings) {
    if (!byPath.has(f.path)) byPath.set(f.path, [])
    byPath.get(f.path)!.push(f)
  }
  const sortedPaths = [...byPath.keys()].sort()

  const lines: string[] = []
  for (const path of sortedPaths) {
    const arr = byPath.get(path)!
    arr.sort((a, b) => b.score - a.score || a.line - b.line)
    lines.push("")
    lines.push(`**${path}**`)
    for (const f of arr) {
      const range =
        f.startLine != null && f.startLine !== f.line
          ? `Lines ${f.startLine}-${f.line}`
          : `Line ${f.line}`
      lines.push(`- ${range} — **${f.category}:** ${f.headline}`)
      // Indent the body so it nests under the bullet visually.
      const bodyLines = f.body
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
      lines.push(bodyLines)
    }
  }
  return lines
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
export function severityBadgeForScore(score: number): string | null {
  if (score >= 5) return "🔴 P0"
  if (score >= 4) return "🟠 P1"
  if (score >= 3) return "🟡 P2"
  return null
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
 * Inline finding comment, greptile-style. The category leads as
 * \`**category:**\` (logic, style, security, performance, etc.) so
 * a reviewer can scan a thread and immediately see what kind of
 * concern it is. Body and any \`\`\`suggestion block flow underneath
 * verbatim.
 *
 * SIG-101: prefixed with a P0/P1/P2 severity badge (suppressed for
 * score 1-2), suffixed with `· _confidence: N/5_`. When confidence
 * ≤ 2, the body is collapsed inside a `<details>` block so noisy
 * low-confidence findings de-emphasize visually but the headline
 * (with its severity badge) stays visible.
 *
 * Pure — exported for tests. The `confidence` arg is the
 * already-resolved per-finding confidence (see
 * `resolveFindingConfidence`), passed in explicitly so the function
 * stays pure and snapshot-testable.
 */
export function formatFindingComment(
  finding: PrReviewFinding,
  confidence: number,
): string {
  const lines: string[] = ["<!-- sigilix:pr-review-finding -->"]
  const badge = severityBadgeForScore(finding.score)
  const heading = badge !== null
    ? `${badge} · **${finding.category}:** ${finding.headline} · _confidence: ${confidence}/5_`
    : `**${finding.category}:** ${finding.headline} · _confidence: ${confidence}/5_`
  lines.push(heading)
  lines.push("")
  if (confidence <= 2) {
    // Low-confidence findings collapse the body so the thread skims
    // cleanly. The headline + severity badge + confidence suffix stay
    // visible so a reviewer can still triage without expanding.
    lines.push("<details>")
    lines.push("<summary>Low-confidence finding — expand to read</summary>")
    lines.push("")
    lines.push(finding.body)
    lines.push("")
    lines.push("</details>")
  } else {
    lines.push(finding.body)
  }
  return lines.join("\n")
}


