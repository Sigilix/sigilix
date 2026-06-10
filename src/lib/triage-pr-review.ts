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

// SIG-365 (PR 13): the RENDER layer moved out to `ensemble/render/`
// (finding-format → review-body → submission / fallback). This file is now a
// thin SHIM: it owns only the wire parser (`parsePrReviewResponse` — INPUT
// parsing, not render) + the cleared-logic-candidate telemetry builder, and it
// RE-EXPORTS the full render surface (+ the long-standing finding/verdict/anchor
// type shims) so every existing importer of `./triage-pr-review` resolves
// unchanged. The public surface is byte-for-byte the same as before the move.

import { parseFirstJsonObject } from "../shared/util/json-extract"
import {
  normalizeReviewFindingScope,
  normalizeFindingDetail,
  countReplacementLines,
  MAX_SUGGESTED_REPLACEMENT_LINES,
} from "./ensemble/render/finding-format"

// SIG-361 (PR 9): the verdict-event types moved to the ensemble/domain/verdict
// leaf. Re-exported so existing importers (e.g. approval-readiness, the ensemble)
// are unchanged.
import type { ReviewEvent, ReviewEventOverride } from "./ensemble/domain/verdict"
export type { ReviewEvent, ReviewEventOverride }

import { FINDING_CATEGORIES } from "@/shared/domain/finding-category"
import type { FindingCategory } from "@/shared/domain/finding-category"

// SIG-318: `FindingCategory` + `FINDING_CATEGORIES` moved to a shared/domain leaf
// so features can reference the finding-category vocabulary without importing
// this god-file (which would invert the dependency rule). Re-exported here so the
// existing importers of this module are unchanged.
export { FINDING_CATEGORIES }
export type { FindingCategory }

import {
  STACK_ORIGINS,
  REVIEW_FINDING_SCOPES,
  hasStructuredFix,
} from "@/shared/domain/pr-review-finding"
import type {
  StackOrigin,
  ReviewFindingScope,
  FindingTrustTier,
  FindingTrust,
  EvidenceRecord,
  PrReviewFinding,
  ScanFactDismissal,
  ClearedLogicCandidate,
  PrReviewVerdict,
  CoverageRoles,
} from "@/shared/domain/pr-review-finding"

// SIG-384: the PrReviewFinding type cluster (finding/verdict/trust vocabulary)
// moved to a shared/domain leaf so domain/feature code can reference it without
// importing this god-file (which would invert the dependency rule). Re-exported
// here so the existing importers of this module are unchanged.
export { STACK_ORIGINS, REVIEW_FINDING_SCOPES }
// SIG-385: the structured-fix predicate trio hoisted to the shared/domain leaf
// (pure finding-vocabulary predicates). `hasStructuredFix` was exported from
// here (validate-inline-grounding rode it), so it is re-exported to keep that
// importer unchanged; the other two are module-private render helpers.
export { hasStructuredFix }
export type {
  StackOrigin,
  ReviewFindingScope,
  FindingTrustTier,
  FindingTrust,
  EvidenceRecord,
  PrReviewFinding,
  ScanFactDismissal,
  ClearedLogicCandidate,
  PrReviewVerdict,
  CoverageRoles,
}

/**
 * SIG-308: build the telemetry events for the logic specialist's cleared
 * candidates. Pure — the ensemble console.logs each record. Each event
 * carries `index`/`total` so the cleared-rate (the counter) is auditable
 * from a single candidate's log line. Mirrors the `pr-review-scan-fact-
 * dismissed` shape; `headSha` is truncated to 7 chars like that emit.
 */
export function buildClearedLogicCandidateTelemetry(
  candidates: readonly ClearedLogicCandidate[],
  ctx: { owner: string; repo: string; prNumber: number; headSha: string },
): Array<Record<string, unknown>> {
  const head = ctx.headSha.slice(0, 7)
  return candidates.map((c, i) => ({
    event: "pr-review-logic-candidate-cleared",
    owner: ctx.owner,
    repo: ctx.repo,
    prNumber: ctx.prNumber,
    headSha: head,
    path: c.path,
    line: c.line,
    hypothesis: c.hypothesis,
    mitigation: c.mitigation,
    index: i + 1,
    total: candidates.length,
  }))
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
    const replIsNonEmpty =
      replIsString &&
      replRaw.trim().length > 0 &&
      countReplacementLines(replRaw) <= MAX_SUGGESTED_REPLACEMENT_LINES

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

  // SIG-308: parse the logic specialist's cleared candidates — correctness
  // concerns it refuted against a concrete in-code mitigation instead of
  // emitting. Each needs path + line(>0) + hypothesis + mitigation; malformed
  // entries are dropped. Telemetered downstream by the ensemble for cleared-
  // rate observability.
  const clearedLogicCandidates: ClearedLogicCandidate[] = []
  if (Array.isArray(obj.clearedLogicCandidates)) {
    for (const c of obj.clearedLogicCandidates as unknown[]) {
      if (!c || typeof c !== "object") continue
      const rec = c as Record<string, unknown>
      const path = typeof rec.path === "string" ? rec.path.trim() : ""
      const line =
        typeof rec.line === "number" && Number.isFinite(rec.line) ? Math.trunc(rec.line) : 0
      const hypothesis = typeof rec.hypothesis === "string" ? rec.hypothesis.trim() : ""
      const mitigation = typeof rec.mitigation === "string" ? rec.mitigation.trim() : ""
      if (path && line > 0 && hypothesis && mitigation) {
        clearedLogicCandidates.push({ path, line, hypothesis, mitigation })
      }
      if (clearedLogicCandidates.length >= 16) break
    }
  }

  return {
    summary,
    confidence,
    confidenceReason,
    findings,
    ...(dismissedScanFacts.length > 0 ? { dismissedScanFacts } : {}),
    ...(clearedLogicCandidates.length > 0 ? { clearedLogicCandidates } : {}),
  }
}

// SIG-361 (PR 9): the verdict-event/gate/severity cluster lives in the pure
// ensemble/domain/verdict leaf. Re-exported (value/type split) so existing
// importers (approval-readiness, the ensemble, the tests) are unchanged.
import {
  chooseReviewEvent,
  chooseReviewEventForRenderedFindings,
  isTrivialFinding,
  chooseRenderedEventWithOverride,
  chooseReviewEventWithGate,
  hasRequiredEvidence,
  computeGateScore,
  computeShadowGateDivergence,
  filterToSigilixAuthored,
  severityLabelForScore,
} from "./ensemble/domain/verdict"
import type {
  ChooseReviewEventForRenderedFindingsArgs,
  MissingScorePolicy,
  ChooseReviewEventWithGateArgs,
  GateScoreProvenance,
  ShadowDivergenceInputs,
  ShadowDivergenceResult,
  AuthoredItem,
} from "./ensemble/domain/verdict"
export {
  chooseReviewEvent,
  chooseReviewEventForRenderedFindings,
  isTrivialFinding,
  chooseRenderedEventWithOverride,
  chooseReviewEventWithGate,
  hasRequiredEvidence,
  computeGateScore,
  computeShadowGateDivergence,
  filterToSigilixAuthored,
  severityLabelForScore,
}
export type {
  ChooseReviewEventForRenderedFindingsArgs,
  MissingScorePolicy,
  ChooseReviewEventWithGateArgs,
  GateScoreProvenance,
  ShadowDivergenceInputs,
  ShadowDivergenceResult,
  AuthoredItem,
}

// SIG-360 / SIG-127: `isSubstantiveAnchorLine` moved to a shared/util leaf
// (@/shared/util/anchor-lines) so domain/feature code can reference it without
// importing this god-file (which would invert the dependency rule). Re-exported
// here so the existing importers of this module are unchanged.
import { isSubstantiveAnchorLine } from "@/shared/util/anchor-lines"
export { isSubstantiveAnchorLine }

// SIG-365 (PR 13): the RENDER layer lives in `ensemble/render/`. Every render
// name the god-file used to export is re-exported here (value/type split) so the
// public surface of `./triage-pr-review` is unchanged for every existing importer
// (merge-guard, pr-finding-markers, trust-ledger-render, the tests, …).
export {
  wrapInlineHtmlTags,
  severityBadgeForScore,
  resolveFindingConfidence,
  extensionToFenceLang,
  fenceForContent,
  getProposedChangeScopeMismatch,
  formatProposedChangeBlock,
  collectCitedLineText,
  isCommentAnchorable,
} from "./ensemble/render/finding-format"
export type {
  ProposedChangeScopeMismatch,
  BodyFindingLinkContext,
} from "./ensemble/render/finding-format"
export {
  formatAiAgentPromptBlock,
  formatFindingComment,
  buildBodyOnlyCheckAnnotations,
  CHECK_ANNOTATION_TEXT_LIMIT,
  CHECK_ANNOTATION_TITLE_LIMIT,
} from "./ensemble/render/finding-comment"
export type {
  ReviewSuggestionEmission,
} from "./ensemble/render/finding-comment"
export {
  renderDeltaBadge,
  renderCoverageLine,
  renderStackParenthetical,
  renderApproveBody,
  renderCommentBody,
  renderRequestChangesBody,
  capForGitHubPrioritized,
  renderFixPlan,
  renderFixPlanTable,
} from "./ensemble/render/review-body"
export type {
  DeltaBadgeCounts,
  ProvenanceCtx,
  RenderBodyArgs,
} from "./ensemble/render/review-body"
export {
  buildReviewSubmission,
  buildReviewSubmissionWithMetadata,
  previewReviewSubmissionEvent,
  previewFallbackSubmissionEvent,
  pickAnchorLineForward,
  pickSubstantiveAnchorLineForward,
  MAX_SUBSTANTIVE_ANCHOR_WALK,
} from "./ensemble/render/submission"
export type {
  ReviewSubmissionBuildResult,
  PreviewReviewSubmissionEventArgs,
  PreviewFallbackSubmissionEventArgs,
} from "./ensemble/render/submission"
export {
  buildFallbackSubmission,
  buildFallbackBody,
} from "./ensemble/render/fallback"
