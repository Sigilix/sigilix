// SIG-365 (PR 13) — the per-finding RENDER leaf (render layer).
//
// The pure markdown/format primitives carved VERBATIM from triage-pr-review.ts:
// the GitHub-safe prose sanitizers, the finding-scope + structured-detail
// normalizers shared with the wire parser, the severity / category badges, the
// fence + anchor + body-markdown formatters, the per-finding inline comment
// (`formatFindingComment`), the body-only finding rows (`renderBodyOnlyFindings`),
// the check-run annotations, and the anchor-quality predicates. No policy
// decisions, no env / network / storage.
//
// Dependency rule: imports point inward only — the finding/verdict domain leaf
// (`@/shared/domain/pr-review-finding` + `finding-category`), the verdict domain
// (severity labels), and the pure lib leaves (badge-assets, diff-positions,
// trust-ledger-render, validate-security-finding remediation). It NEVER imports
// the orchestrator god-file or any app/adapter module. The bodies are
// byte-identical to their HEAD form in triage-pr-review.ts; only the import paths
// (canonicalized to `@/…` / the verdict-domain leaf) and the wrapper are new.

import {
  isContiguousRightRange,
  deriveSide,
  isPositionReviewable,
  type ReviewableMap,
} from "@/src/shared/util/diff-positions"
import { badgeAssetLabel, badgeAssetUrl, type ReviewBadgeAssetName } from "@/src/lib/badge-assets"
import type { FindingCategory } from "@/src/shared/domain/finding-category"
import {
  FINDING_MORE_INFO_SECTION_KEYS,
  FINDING_MORE_INFO_SECTION_LABELS,
  hasFindingMoreInfo,
  type FindingMoreInfo,
} from "@/src/shared/domain/finding-more-info"
import {
  REVIEW_FINDING_SCOPES,
  isDeletionSuggestion,
  isReplacementSuggestion,
  hasStructuredFix,
} from "@/src/shared/domain/pr-review-finding"
import type {
  ReviewFindingScope,
  EvidenceRecord,
  PrReviewFinding,
  PrReviewVerdict,
} from "@/src/shared/domain/pr-review-finding"
import { severityLabelForScore } from "@/src/lib/ensemble/domain/verdict"

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

const MARKDOWN_HEADING_LINE_RE = /^(\s{0,3})(#{1,6})(\s+)/gm
const MARKDOWN_TASK_LIST_LINE_RE = /^(\s{0,3})([-+*]\s+\[[ xX]\])(\s+)/gm

/** SIG-104 PR-3: cap the learned-rule text in the inline attribution `<sub>` line. */
const LEARNING_ATTRIBUTION_RULE_LIMIT = 160

/**
 * SIG-104 PR-3: the inline "applied learning" attribution line — a small muted
 * `<sub>` provenance note rendered under a finding whose suppression was shaped
 * by a learned rule (the carve-out kept it). Returns "" when the finding carries
 * no attribution. The rule text is user/LLM-derived (already secret-redacted at
 * capture) so it is HTML-escaped + length-capped before embedding, mirroring the
 * learnings render leaf's `escapeInlineMarkdown`. Pure — exported for tests.
 */
export function formatLearningAttribution(finding: PrReviewFinding): string {
  const ruleText = finding.shapedByLearning?.ruleText?.trim()
  if (!ruleText) return ""
  const capped =
    ruleText.length > LEARNING_ATTRIBUTION_RULE_LIMIT
      ? `${ruleText.slice(0, LEARNING_ATTRIBUTION_RULE_LIMIT - 1)}…`
      : ruleText
  return `<sub>shaped by learned rule: "${escapeInlineEvidenceValue(capped)}"</sub>`
}

export function sanitizeMoreInfoMarkdownText(s: string): string {
  const htmlSafe = wrapInlineHtmlTags(s)
  return htmlSafe.replace(MARKDOWN_HEADING_LINE_RE, "$1\\$2$3").replace(MARKDOWN_TASK_LIST_LINE_RE, "$1\\$2$3")
}

/**
 * Apply `wrapInlineHtmlTags` to every prose field on a verdict so
 * downstream renderers see GitHub-safe markdown. Pure.
 */
export function sanitizeVerdictForGitHub(v: PrReviewVerdict): PrReviewVerdict {
  return {
    ...v,
    summary: wrapInlineHtmlTags(v.summary),
    confidenceReason: wrapInlineHtmlTags(v.confidenceReason),
    findings: v.findings.map(sanitizeFindingForGitHub),
  }
}

export function sanitizeFindingsForGitHub(findings: ReadonlyArray<PrReviewFinding>): PrReviewFinding[] {
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
  if (f.moreInfo) {
    const moreInfo = sanitizeFindingMoreInfo(f.moreInfo)
    if (moreInfo) sanitized.moreInfo = moreInfo
    else delete sanitized.moreInfo
  }
  return sanitized
}

function sanitizeFindingMoreInfo(moreInfo: FindingMoreInfo): FindingMoreInfo | undefined {
  const sanitized: FindingMoreInfo = {}
  for (const key of FINDING_MORE_INFO_SECTION_KEYS) {
    const value = moreInfo[key]
    const clean = typeof value === "string" ? value.trim() : ""
    if (clean) sanitized[key] = sanitizeMoreInfoMarkdownText(clean)
  }
  return hasFindingMoreInfo(sanitized) ? sanitized : undefined
}

export function normalizeReviewFindingScope(raw: unknown): ReviewFindingScope | undefined {
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (value === "comment/event" || value === "event" || value === "review-comment") {
    return "comment"
  }
  if (value === "pull-request" || value === "pull_request" || value === "review") {
    return "pr"
  }
  return REVIEW_FINDING_SCOPES.has(value as ReviewFindingScope) ? (value as ReviewFindingScope) : undefined
}

export function findingScope(finding: PrReviewFinding): ReviewFindingScope {
  return finding.scope ?? "line"
}

export function normalizeFindingDetail(value: unknown): string | undefined {
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

// SIG-281 PR B: carries an inline candidate with its ORIGINAL
// verdict.findings index so the Rec 3 priority sort + cap can reorder /
// truncate WITHOUT decoupling a finding from the index its SIG-247
// marker is keyed by (consumed at the marker lookup ~line 1019).

// SIG-125 / SIG-162 PR 5: the max line count a `suggestedReplacement` may
// span before it stops being treated as a localized, committable fix.
export const MAX_SUGGESTED_REPLACEMENT_LINES = 10

function isExplicitRemovedTestCoverageFinding(f: PrReviewFinding): boolean {
  if (f.category !== "testing") return false
  return (
    Array.isArray(f.evidenceRefs) &&
    f.evidenceRefs.some((ref) => typeof ref === "string" && ref.trim().startsWith("testFileChanged:"))
  )
}

function isMissingSiblingTestingFinding(f: PrReviewFinding): boolean {
  if (f.category !== "testing") return false
  return (
    Array.isArray(f.evidenceRefs) &&
    f.evidenceRefs.some((ref) => {
      if (typeof ref !== "string") return false
      const trimmed = ref.trim()
      return trimmed.startsWith("siblingMapping:") && trimmed.endsWith("->NONE")
    })
  )
}

export function normalizeTestingFindingForFinalPolicy(f: PrReviewFinding): PrReviewFinding {
  if (f.category !== "testing") return f
  if (isExplicitRemovedTestCoverageFinding(f)) return f
  if (f.score <= 2) return f
  return { ...f, score: 2 }
}

export function normalizeFallbackBodyFindings(findings: readonly PrReviewFinding[]): PrReviewFinding[] {
  return findings
    .map(normalizeTestingFindingForFinalPolicy)
    .filter((finding) => !shouldDropUnanchoredTestingFinding(finding))
}

export function shouldDropUnanchoredTestingFinding(f: PrReviewFinding): boolean {
  return isMissingSiblingTestingFinding(f) && !isExplicitRemovedTestCoverageFinding(f)
}

function formatHeadSha(headSha: string): string {
  return headSha.slice(0, 7)
}

export function withLineMovedNote(f: PrReviewFinding, headSha: string): PrReviewFinding {
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
      return f.startLine != null && f.startLine !== f.line ? `Lines ${f.startLine}-${f.line}` : `Line ${f.line}`
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
function formatBodyFindingAnchor(f: PrReviewFinding, linkContext?: BodyFindingLinkContext): string {
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

const MAX_EVIDENCE_VALUES_PER_ROW = 8

function escapeInlineEvidenceValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/`/g, "&#96;")
}

function formatInlineEvidenceValue(value: string): string {
  return `\`${escapeInlineEvidenceValue(value)}\``
}

function formatEvidenceValues(values: readonly string[]): string {
  const shown = values.slice(0, MAX_EVIDENCE_VALUES_PER_ROW)
  const rest = values.length - shown.length
  const suffix = rest > 0 ? `, +${rest} more` : ""
  return `${shown.map(formatInlineEvidenceValue).join(", ")}${suffix}`
}

function evidencePieceCount(record: EvidenceRecord): number {
  return (
    record.specialistsThatFlagged.length +
    record.deterministicFactIds.length +
    record.retrievalChunkIds.length +
    record.relatedPriorPRs.length
  )
}

function renderFindingEvidenceBlock(finding: PrReviewFinding): string {
  const record = finding.evidence
  if (!record) return ""
  const count = evidencePieceCount(record)
  if (count === 0) return ""
  const lines = [
    `<details><summary>Why Sigilix flagged this (${count} ${count === 1 ? "piece" : "pieces"} of evidence)</summary>`,
    "",
    `- Flagged by: ${record.specialistsThatFlagged.length > 0 ? record.specialistsThatFlagged.map(escapeInlineEvidenceValue).join(", ") : "none recorded"}`,
  ]
  if (record.specialistsThatDeclined.length > 0) {
    lines.push(`- Did not flag: ${record.specialistsThatDeclined.map(escapeInlineEvidenceValue).join(", ")}`)
  }
  if (record.deterministicFactIds.length > 0) {
    lines.push(`- Deterministic facts: ${formatEvidenceValues(record.deterministicFactIds)}`)
  }
  if (record.retrievalChunkIds.length > 0) {
    lines.push(`- Retrieval chunks: ${formatEvidenceValues(record.retrievalChunkIds)}`)
  }
  if (record.relatedPriorPRs.length > 0) {
    lines.push(`- Related prior PRs: ${formatEvidenceValues(record.relatedPriorPRs)}`)
  }
  lines.push(`- Synth decision: ${escapeInlineEvidenceValue(record.synthDecision)}`)
  lines.push(`- Consensus: ${record.consensusScore} ${record.consensusScore === 1 ? "specialist" : "specialists"}`)
  lines.push("", "</details>")
  return lines.join("\n")
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

export function formatFindingBodyMarkdown(body: string): string {
  // Split the body STRUCTURALLY, not by length (founder 2026-05-31): the COMPLETE
  // issue stays in the main comment — readable on its own, never a mid-sentence
  // "..." — and only the deeper "why/how the model concluded this" reasoning goes
  // in a collapsed dropdown. The synthesizer is nudged to write the body as
  // "{complete issue}\n\n{deeper reasoning}", so we split on the FIRST blank-line
  // break: everything before it is the issue (main), everything after is the
  // reasoning (dropdown). No blank-line break → the body is a single self-contained
  // thought; show it whole inline. No character cap, no truncation marker — the
  // prompt is the brevity guardrail, the renderer's job is completeness.
  const clean = stripAstMarkers(body).replace(/\r\n/g, "\n")
  const breakIdx = clean.indexOf("\n\n")
  if (breakIdx === -1) return clean.trimEnd()
  const main = clean.slice(0, breakIdx).trimEnd()
  const reasoning = clean.slice(breakIdx + 2).trimStart()
  // Degenerate split (empty issue or empty reasoning) → just show the whole body.
  if (main.length === 0 || reasoning.length === 0) return clean.trimEnd()
  if (!isDetailedReasoningBlock(reasoning)) return clean.trimEnd()
  return [main, "", "<details><summary>Detailed reasoning</summary>", "", reasoning, "", "</details>"].join("\n")
}

function isDetailedReasoningBlock(reasoning: string): boolean {
  const clean = reasoning.trim()
  if (isTerseFixNote(clean)) return false
  const sentences = sentenceParts(clean)
  if (sentences.length >= 3 && clean.length >= 200) return true
  if (!hasMechanismReasoningShape(clean)) return false
  return sentences.length >= 2 || clean.length >= 160
}

function isTerseFixNote(value: string): boolean {
  if (!hasFixNotePrefix(value)) return false
  const sentences = sentenceParts(value)
  return value.length < 320 && sentences.length < 2 && !hasMechanismReasoningShape(value)
}

function hasFixNotePrefix(value: string): boolean {
  return /^(?:the\s+)?(?:minimal\s+fix|fix|fix\s+suggestion|mitigation|patch|possible\s+fix|proposed\s+fix|quick\s+fix|recommended\s+fix|suggested\s+(?:change|fix)|to\s+fix|workaround)\s*(?::|[-–—])/i.test(
    value,
  )
}

function sentenceParts(value: string): string[] {
  return value.split(/[.!?](?:\s+|$)/).filter((part) => part.trim().length > 0)
}

function hasMechanismReasoningShape(value: string): boolean {
  return hasCausalSignal(value) && (hasMechanismSignal(value) || hasCodeReferenceSignal(value))
}

function hasCausalSignal(value: string): boolean {
  return /\b(?:because|so|therefore|why|when|while|before|after|until|unless|means|as a result|root cause|causes?|leaves?|results? in|lets?|allows?|prevents?|bypasses?|skips?|misses?|fails? to|cannot|never|no longer|too early|too late)\b/i.test(
    value,
  )
}

function hasMechanismSignal(value: string): boolean {
  return /\b(?:auth(?:orization)?|boundary|cache|call|check|condition|control flow|data flow|decode|encode|escape|event|guard|handler|idempotenc(?:y|e)|invariant|lifetime|lock|marker|normalize|order(?:ing)?|parser?|precondition|promise|race|range|read|reachable|replacement|round-?trip|scan|serialize|session|side effect|state|transaction|trigger|validate|write)\b/i.test(
    value,
  )
}

function hasCodeReferenceSignal(value: string): boolean {
  return /`[^`]+`|\b[A-Za-z_$][\w$]*\s*\(|\b[\w./-]+\.(?:[cm]?[jt]sx?|json|ya?ml|py|rb|go|rs|java|sh|sql|md):\d+\b/.test(
    value,
  )
}

function formatFenceSection(label: string, content: string, lang: string): string {
  const clean = stripAstMarkers(content).trim()
  if (clean.length === 0) return ""
  const fence = fenceForContent(clean)
  return [label, fence + lang, clean, fence].join("\n")
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
  // SIG-317 step 6 Part B: the deterministic AST proof slice — turns a bare
  // injected emit into a grounded "here's the exact code" finding. The fenced
  // slice IS the smoking gun, so it leads (right after the example, before the
  // fix/test sections — Kimi UI sign-off: proof up front, not as fine print).
  // Capped defensively (the runner already redacts) so the section can't bloat.
  if (finding.astEvidence) {
    const lang = extensionToFenceLang(finding.path)
    const slice = finding.astEvidence.length > 300 ? `${finding.astEvidence.slice(0, 297)}…` : finding.astEvidence
    const section = formatFenceSection("**Static-analysis evidence:**", slice, lang)
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

function formatFindingMoreInfoMarkdown(finding: PrReviewFinding): string {
  const moreInfo = finding.moreInfo
  if (!hasFindingMoreInfo(moreInfo)) return ""
  const items: string[] = []
  for (const key of FINDING_MORE_INFO_SECTION_KEYS) {
    const value = moreInfo[key]
    const clean = typeof value === "string" ? stripAstMarkers(value).trim() : ""
    if (clean.length === 0) continue
    items.push(`- **${FINDING_MORE_INFO_SECTION_LABELS[key]}:** ${formatMoreInfoDetailText(clean)}`)
  }
  if (items.length === 0) return ""
  return ["<details><summary>More Info</summary>", "", ...items, "", "</details>"].join("\n")
}

function formatMoreInfoDetailText(value: string): string {
  return sanitizeMoreInfoMarkdownText(value)
    .replace(/\r?\n+/g, "<br>")
    .trim()
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
  return ["**Suggested change:**", fence + lang, repl.replace(/\n$/, ""), fence].join("\n")
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
export function resolveFindingConfidence(finding: PrReviewFinding, verdictConfidence: number): number {
  if (
    typeof finding.confidence === "number" &&
    Number.isFinite(finding.confidence) &&
    finding.confidence >= 1 &&
    finding.confidence <= 5
  ) {
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
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  json: "json",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
  sql: "sql",
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

export interface ProposedChangeScopeMismatch {
  anchorLines: number
  replacementLines: number
  replacementToAnchorRatio: number
}

export function countReplacementLines(replacement: string): number {
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
    (finding.kind === "replace" || finding.kind === undefined) && typeof repl === "string" && repl.length > 0
  if (!isReplace) return null
  if (!referencesMultipleSpecificLines(finding.body)) return null

  const startL = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
  const anchorLines = Math.max(1, finding.line - startL + 1)
  const replacementLines = countReplacementLines(repl)
  const replacementToAnchorRatio = replacementLines / anchorLines
  if (replacementToAnchorRatio >= SCOPE_MISMATCH_RATIO_THRESHOLD) return null
  return { anchorLines, replacementLines, replacementToAnchorRatio }
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
    (finding.kind === "replace" || finding.kind === undefined) && typeof repl === "string" && repl.length > 0
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
  const startL = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
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
 * Believability gate (secret-remediation): gather the cited added-line
 * text for a finding's range (startLine..line) from `addedLineTextByPath`,
 * joined with `\n`. This is the same range the "Current" block renders
 * (see `formatProposedChangeBlock`), so the credential check runs against
 * exactly the code the comment cites. Returns "" when no added-line text
 * is available for any line in the range — the gate then treats the
 * `secrets-exposure` finding as unverified (de-alarmed remediation).
 *
 * Pure — exported for tests.
 */
export function collectCitedLineText(
  finding: PrReviewFinding,
  addedLineTextByPath?: ReadonlyMap<string, ReadonlyMap<number, string>>,
): string {
  const startL = finding.startLine != null && finding.startLine < finding.line ? finding.startLine : finding.line
  const endL = finding.line
  const addedLines = addedLineTextByPath?.get(finding.path)
  if (!addedLines) return ""
  const citedLines: string[] = []
  for (let n = startL; n <= endL; n++) {
    const text = addedLines.get(n)
    if (text !== undefined) citedLines.push(text)
  }
  return citedLines.join("\n")
}

/**
 * SIG-125: a finding's anchored range `[startLine ?? line, line]` is
 * committable iff every line is RIGHT-reviewable (matches GitHub's
 * ```suggestion applyability requirement).
 */
export function isFindingAnchorable(finding: PrReviewFinding, reviewable: ReviewableMap): boolean {
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
  side: "LEFT" | "RIGHT" = "RIGHT",
): boolean {
  // RIGHT keeps the exact pre-existing semantics (deriveSide prefers RIGHT on an
  // ambiguous same-numbered line). For an explicit LEFT endpoint (SIG-456 deleted-line
  // anchoring), validate against the LEFT/deletion side directly via isPositionReviewable —
  // deriveSide would wrongly prefer RIGHT there.
  const endpointOk = (n: number): boolean =>
    side === "RIGHT" ? deriveSide(reviewable, path, n) === "RIGHT" : isPositionReviewable(reviewable, path, n, "LEFT")
  if (!endpointOk(line)) return false
  if (startLine === undefined || startLine >= line) return true
  return endpointOk(startLine)
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

// Re-export the per-finding leaf helpers consumed by the body + submission
// render modules and the legacy shim. These mirror the names the old god-file
// exposed (`stripAstMarkers`, `formatFindingCategory`, etc. were file-private
// there but are needed across the split render modules now).
export {
  stripAstMarkers,
  formatFindingCategory,
  formatBodyFindingSeverity,
  formatBodyFindingLocation,
  formatBodyFindingAnchor,
  formatFindingMoreInfoMarkdown,
  formatFindingStructuredDetailsMarkdown,
  formatBodyFindingSuggestedChange,
  renderFindingEvidenceBlock,
  categoryBadgeForFinding,
  badgeImg,
  FINDING_STRUCTURED_DETAIL_LIMIT,
}
