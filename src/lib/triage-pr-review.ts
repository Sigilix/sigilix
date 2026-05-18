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
// `buildFallbackSubmission`, `formatReviewBody`,
// `parsePrReviewResponse`, and the related sanitizers.
import {
  type SubmitReviewBody,
  type SubmitReviewComment,
} from "./github"
import { parseFirstJsonObject } from "./json-extract"
import { type StackContext } from "./pr-stack"
import { renderStackContextSummary } from "../prompts/pr-stack-prompt"

// ARC-280: `handlePrReview` (Phase 3 single-shot reviewer) deleted.
// This file now exports ONLY the pure helpers the ensemble still
// uses — `buildReviewSubmission`, `buildFallbackSubmission`,
// `formatReviewBody`, `chooseReviewEvent`, `parsePrReviewResponse`,
// `wrapInlineHtmlTags`, `renderFixPlan` — plus the shared types
// (`PrReviewFinding`, `PrReviewVerdict`, `FindingCategory`,
// `StackOrigin`, `ProvenanceCtx`). The `buildPrReviewDedupeKey`
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
}

export interface PrReviewVerdict {
  summary: string
  confidence: number
  confidenceReason: string
  findings: PrReviewFinding[]
}



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
   * Graphite-style stack, a "### Stack context" block is injected
   * into the sticky-summary body so a human reviewer sees the stack
   * picture at a glance. Absent on unstacked PRs (renderer no-ops).
   */
  stack?: StackContext
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
  prAuthor,
  headSha,
  unanchored: rawUnanchored = [],
  nowMs,
  findingMarkers,
  stack,
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
  const body = formatReviewBody(verdict, prAuthor, event, unanchored, prov, stack)
  const comments: SubmitReviewComment[] = verdict.findings.map((f, i) => {
    // ARC-189: append per-finding sigilix marker on its own line so
    // the cross-PR review-memory capture pipeline can correlate
    // future reply dismissals back to this finding's category + tier.
    // Marker is hidden HTML — invisible in rendered Markdown but
    // visible to the marker extractor. Sparse: nullish entries skip.
    const marker = findingMarkers?.[i]
    const baseBody = formatFindingComment(f)
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
 * `### Findings` section. The dedupe marker `<!-- openclaw:pr-review -->`
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
  const body = buildFallbackBody(verdict, unanchored, undefined, stack)
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
): string {
  const all = [...verdict.findings, ...unanchored]
  if (all.length === 0) {
    // No inline findings to relocate; the standard prose body is fine.
    // Still flow through formatReviewBody to keep the marker + summary.
    return formatReviewBody(verdict, null, chooseReviewEvent(verdict.findings), [], prov, stack)
  }

  const lines: string[] = ["<!-- openclaw:pr-review -->", ""]
  lines.push("### Sigilix Summary")
  lines.push("")
  lines.push(verdict.summary)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }
  // ARC-182: inject "### Stack context" between the summary and the
  // findings list (mirrors placement in formatReviewBody). No-op when
  // stack is absent or unstacked.
  if (stack && stack.isStacked) {
    const stackBlock = renderStackContextSummary(stack)
    if (stackBlock.length > 0) {
      lines.push("")
      lines.push(stackBlock)
    }
  }
  // ARC-180 deliberately does NOT add a Fix Plan section here — the
  // fallback already renders every finding grouped by file (a few
  // lines below), so a severity-prioritized header above the same
  // data would duplicate content. The inline-anchor path uses Fix
  // Plan because findings live BELOW the body as separate inline
  // comments, not in the body itself.
  lines.push("")
  lines.push(`### Findings (${all.length})`)
  lines.push(...renderFindingsByFile(all))

  return capForGitHub(lines.join("\n"), prov)
}

export function chooseReviewEvent(findings: PrReviewFinding[]): ReviewEvent {
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
  return findings.length === 0 ? "APPROVE" : "REQUEST_CHANGES"
}

/**
 * Greptile-style review body. Prose-first with structured headers and
 * NO mechanical "Findings: N (max score N)" footer or numerical
 * confidence score in the body. The model's confidenceReason becomes
 * the lead, the summary is sub-text, and findings live as inline
 * comments below — so the body itself reads like a senior reviewer's
 * one-paragraph take, not a structured report.
 *
 * Reference shape (per Codex's audit of greptile-apps output):
 *   ### Arc Summary
 *   <prose paragraph>
 *
 *   <optional approval note when applicable>
 *
 *   <optional `### Important Files Changed` section, only when useful>
 *
 *   <"See N findings inline below" pointer when findings exist>
 */
function formatReviewBody(
  verdict: PrReviewVerdict,
  _prAuthor: string | null,
  event: ReviewEvent,
  unanchored: PrReviewFinding[] = [],
  prov?: ProvenanceCtx,
  stack?: StackContext,
): string {
  // Body is greptile-styled and prose-only. The structure is fixed
  // (marker, header, model's summary, model's confidence reason,
  // finding count pointer) but every word inside is the model's. No
  // hardcoded author notes ("@author — items below are non-blocking,
  // approving") because canned dialogue feels mechanical when it
  // recurs across PRs. The model's summary already addresses the
  // engineer reviewing the PR — that's the message.
  //
  // ARC-276: when the event is `APPROVE` (no findings) the body opens
  // with an affirmative headline + a one-line statement of what
  // Sigilix did. Without this, a no-findings APPROVE body would
  // just be "### Sigilix Summary\n<summary>" with no clear pass
  // signal at the top — the engineer reviewing the PR would have to
  // read the model's prose to know whether anything was flagged.
  //
  // When `unanchored` is non-empty, an "Additional findings" section
  // is appended so findings whose lines fell outside the diff still
  // get surfaced (rather than silently dropped on the success path).
  const lines: string[] = ["<!-- openclaw:pr-review -->", ""]
  const totalFindings = verdict.findings.length + unanchored.length
  if (event === "APPROVE" && totalFindings === 0) {
    // CodeRabbit catch on PR #88: this renderer is shared between
    // the ensemble path (4 specialists + synth) AND the Phase 3
    // single-shot path. Claiming "Four-specialist ensemble ran"
    // here would be factually wrong on the Phase 3 path. Use
    // path-agnostic copy until ARC-280 deletes Phase 3 (or
    // ARC-281's formatting redesign supersedes this lead entirely).
    lines.push("## ✅ Sigilix reviewed this PR — no issues found")
    lines.push("")
    lines.push("Sigilix reviewed the current head and found nothing worth flagging.")
    lines.push("")
  }
  lines.push("### Sigilix Summary")
  lines.push("")
  lines.push(verdict.summary)
  if (verdict.confidenceReason) {
    lines.push("")
    lines.push(verdict.confidenceReason)
  }
  // ARC-182: inject "### Stack context" between Sigilix Summary and
  // either the finding-count pointer or the Fix Plan. No-op when
  // stack is absent or unstacked (`renderStackContextSummary` returns
  // empty string in that case).
  if (stack && stack.isStacked) {
    const stackBlock = renderStackContextSummary(stack)
    if (stackBlock.length > 0) {
      lines.push("")
      lines.push(stackBlock)
    }
  }
  if (verdict.findings.length > 0) {
    lines.push("")
    lines.push(
      `_${verdict.findings.length} ${verdict.findings.length === 1 ? "finding" : "findings"} inline below._`
    )
  }
  // ARC-180: Fix Plan — surface high/critical findings (score >= 4)
  // as a prioritized repair queue at the top of the review. Anchored
  // and unanchored findings both contribute, since the prioritization
  // is severity-based and a blocker is a blocker regardless of
  // whether the inline comment landed cleanly.
  const fixPlan = renderFixPlan([...verdict.findings, ...unanchored])
  if (fixPlan) {
    lines.push("")
    lines.push(fixPlan)
  }
  if (unanchored.length > 0) {
    lines.push("")
    lines.push(`### Additional findings (could not anchor to diff)`)
    lines.push(...renderFindingsByFile(unanchored))
  }
  return capForGitHub(lines.join("\n"), prov)
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
 * Inline finding comment, greptile-style. The category leads as
 * \`**category:**\` (logic, style, security, performance, etc.) so
 * a reviewer can scan a thread and immediately see what kind of
 * concern it is. Severity is implicit in the body / approval state,
 * not in the inline tag — that's how greptile-apps does it. Body and
 * any \`\`\`suggestion block flow underneath verbatim.
 */
function formatFindingComment(finding: PrReviewFinding): string {
  const lines: string[] = ["<!-- openclaw:pr-review-finding -->"]
  lines.push(`**${finding.category}:** ${finding.headline}`)
  lines.push("")
  lines.push(finding.body)
  return lines.join("\n")
}


