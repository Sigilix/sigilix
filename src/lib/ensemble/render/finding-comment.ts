// SIG-365 (PR 13) — the per-finding RENDER composers (render layer).
//
// The higher-level finding emitters carved VERBATIM from triage-pr-review.ts:
// the inline review comment (`formatFindingComment`), the copy-paste AI-fix prompt
// block (`formatAiAgentPromptBlock`), the body-only finding rows
// (`renderBodyOnlyFindings`), the GitHub check-run annotations
// (`buildBodyOnlyCheckAnnotations`), and the committable-suggestion-emission
// scanner (`renderedSuggestionEmissions`). These COMPOSE the leaf primitives in
// `./finding-format`; they make no policy decisions.
//
// Split out of `finding-format.ts` purely to keep each render module ≤1k lines
// (the format leaf still hosts the primitives these call). Dependency rule:
// imports point inward only — the format leaf, the verdict domain
// (severity-label helper), the trust-ledger-render leaf (pills), the
// validate-security-finding leaf (remediation), and the shared/diff types. It
// NEVER imports the orchestrator god-file or any app/adapter module. The bodies
// are byte-identical to their HEAD form in triage-pr-review.ts; only the import
// paths and the wrapper are new.

import type { CheckRunAnnotation, SubmitReviewComment } from "@/src/shared/types/github"
import { type ReviewableMap } from "@/src/shared/util/diff-positions"
import { trustPill, trustSubTag } from "@/src/lib/trust-ledger-render"
import { remediationForFinding } from "@/src/lib/ensemble/domain/gates/validate-security-finding"
import { isDeletionSuggestion, isReplacementSuggestion } from "@/src/shared/domain/pr-review-finding"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { severityLabelForScore } from "@/src/lib/ensemble/domain/verdict"
import {
  stripAstMarkers,
  badgeImg,
  severityBadgeForScore,
  categoryBadgeForFinding,
  formatFindingCategory,
  formatBodyFindingSeverity,
  formatBodyFindingLocation,
  formatBodyFindingAnchor,
  formatFindingBodyMarkdown,
  formatFindingStructuredDetailsMarkdown,
  formatBodyFindingSuggestedChange,
  formatProposedChangeBlock,
  renderFindingEvidenceBlock,
  collectCitedLineText,
  extensionToFenceLang,
  fenceForContent,
  isFindingAnchorable,
  type BodyFindingLinkContext,
} from "./finding-format"

// SIG-125: confidence floor at/above which a finding's
// `suggestedReplacement` is eligible to render as a committable
// ```suggestion (still gated on clean anchorability).
const HIGH_CONFIDENCE_FLOOR = 4
const WHY_NOT_CAUGHT_LABEL = "Why this wasn't caught"

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
export function renderBodyOnlyFindings(
  findings: PrReviewFinding[],
  linkContext?: BodyFindingLinkContext,
  trustLedger?: boolean,
  showEvidence?: boolean,
): string[] {
  const sorted = [...findings].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  const lines: string[] = []
  for (const f of sorted) {
    const anchor = formatBodyFindingAnchor(f, linkContext)
    const anchorNote = f.anchorNote ? ` · ${f.anchorNote}` : ""
    const badge = severityBadgeForScore(f.score)
    const categoryBadge = categoryBadgeForFinding(f)
    // SIG Trust Ledger v0: the pill after the category glyph + the ` · TIER`
    // sub-tag after the score (zero-width concat; the helpers carry their spacing).
    const pill = trustLedger ? trustPill(f.trust, badgeImg) : ""
    const subTag = trustLedger ? trustSubTag(f.trust) : ""
    // Kimi (UI): lead the row with the BOLD, linked location so a reviewer sees
    // WHERE a body finding is at a glance (CodeRabbit parity) instead of hunting
    // grey <sub> metadata; score/trust collapse into a trailing subscript.
    lines.push("")
    lines.push(
      `- ${badge} ${categoryBadge}${pill} **${anchor}**: **${stripAstMarkers(f.headline)}** <sub>score ${f.score}${subTag}${anchorNote}</sub>`,
    )
    // Indent the body so it nests under the bullet visually.
    const detailLines = [
      formatFindingBodyMarkdown(f.body),
      showEvidence ? renderFindingEvidenceBlock(f) : "",
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
  const sorted = [...findings].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
  return (
    sorted
      // Out-of-PR-scope findings (code not in this PR) must NOT become check
      // annotations either — a `failure` annotation on an untouched file recreates
      // the "looks blocking" problem on the checks surface (CodeRabbit #334).
      // Filtering here covers every call site at once.
      .filter((f) => !f.outOfPrScope && f.path.trim().length > 0 && Number.isFinite(f.line) && f.line > 0)
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
          ]
            .filter((s) => s !== "")
            .join("\n"),
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
  )
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
  trustLedger?: boolean,
  showEvidence?: boolean,
): string {
  const lines: string[] = ["<!-- sigilix:pr-review-finding -->"]
  // SIG-164 PR 5: badge is always present (P3 covers low severity).
  // Heading shape: <img badge> **headline**. Category, severity, and
  // confidence stay machine-readable through hidden markers instead of
  // repeating as visible metadata on every stacked thread.
  const badge = severityBadgeForScore(finding.score)
  const categoryBadge = categoryBadgeForFinding(finding)
  // SIG Trust Ledger v0: the VERIFIED/GROUNDED/MODEL pill, appended right after
  // the category glyph (zero-width concat — the glyph carries its own spacing).
  const pill = trustLedger ? trustPill(finding.trust, badgeImg) : ""
  const headline = stripAstMarkers(finding.headline)
  const body = formatFindingBodyMarkdown(finding.body)
  lines.push(`${badge} ${categoryBadge}${pill} **${headline}**`)
  lines.push(`<!-- sigilix:category:${formatFindingCategory(finding)} -->`)
  lines.push(`<!-- sigilix:severity:${finding.score} -->`)
  lines.push(`<!-- sigilix:confidence:${confidence} -->`)
  // SIG-217: hidden content fingerprint, so a later `@sigilix` dismissal can
  // record it and content-equivalent re-fires are suppressed across pushes.
  if (finding.contentFingerprint) {
    lines.push(`<!-- sigilix:fingerprint:${finding.contentFingerprint} -->`)
  }
  lines.push("")
  const structuredDetails = formatFindingStructuredDetailsMarkdown(finding)
  const evidenceBlock = showEvidence ? renderFindingEvidenceBlock(finding) : ""
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
  if (evidenceBlock) {
    lines.push("")
    lines.push(evidenceBlock)
  }
  // SIG-282 Phase 3: append a deterministic, vetted remediation for a
  // confirmed security finding, keyed by its CWE bucket — rather than
  // relying on LLM-authored remediation prose. The model describes the
  // problem (the body); the system supplies the standard fix guidance.
  //
  // Believability gate (secret-remediation): the alarmist secrets-exposure
  // remediation ("treat as compromised / rewrite history") only fires when
  // the cited code actually contains a credential-like token. Thread the
  // cited added-line text (startLine..line) so the bucket can be gated on a
  // real credential signal. Other buckets ignore this argument.
  const citedLineText = collectCitedLineText(finding, addedLineTextByPath)
  const remediation = remediationForFinding(finding, citedLineText)
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

export interface ReviewSuggestionEmission {
  path: string
  line: number
  startLine?: number
}

export function renderedSuggestionEmissions(comments: readonly SubmitReviewComment[]): ReviewSuggestionEmission[] {
  return comments.flatMap((comment) => {
    if (!hasRenderedSuggestionBlock(comment.body)) return []
    if (typeof comment.line !== "number") return []
    const emission: ReviewSuggestionEmission = {
      path: comment.path,
      line: comment.line,
    }
    if (comment.start_line !== undefined) emission.startLine = comment.start_line
    return [emission]
  })
}

interface MarkdownFence {
  ch: "`" | "~"
  len: number
}

function hasRenderedSuggestionBlock(body: string): boolean {
  let openFence: MarkdownFence | null = null
  for (const line of body.split("\n")) {
    if (openFence === null) {
      if (/^```suggestion\s*$/.test(line)) return true
      const fence = /^(`{3,}|~{3,})[^`~]*$/.exec(line)
      if (fence?.[1]) {
        const seq = fence[1]
        const ch = seq[0]
        if (ch === "`" || ch === "~") openFence = { ch, len: seq.length }
      }
      continue
    }
    if (isClosingMarkdownFence(line, openFence)) openFence = null
  }
  return false
}

function isClosingMarkdownFence(line: string, fence: MarkdownFence): boolean {
  const closeRe =
    fence.ch === "`" ? new RegExp("^`{" + fence.len + ",}\\s*$") : new RegExp("^~{" + fence.len + ",}\\s*$")
  return closeRe.test(line)
}
