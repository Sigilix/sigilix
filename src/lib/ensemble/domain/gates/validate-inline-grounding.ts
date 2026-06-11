// SIG-281 PR C (Rec 4): inline-grounding gate.
//
// The presentation-discipline companion to PR B's confidence-tier
// routing. Where the role gates (SIG-108/109/110/111) anchor *high*-
// severity claims (sev>=4, role-scoped), this gate works the OTHER
// direction: a LOW/medium-severity finding (score < 4, ALL categories)
// only earns an inline review comment when it is GROUNDED in something
// concrete. An ungrounded sub-4 nit is demoted to the review body — it
// keeps its content, it just doesn't get a diff-line comment thread.
//
// This targets the "over-firing on the first PR" problem (e.g. a vague
// style/complexity note with no fix and no reference to changed code
// posted inline). It is the GROUNDING axis; PR B's routing is the
// CONFIDENCE axis — intentionally complementary, both demote to body.
//
// FALSE-POSITIVE SAFETY (biases hard toward KEEP-INLINE):
//   - score >= 4 ALWAYS keeps — the believability floor (P0/P1) is
//     structurally untouchable by this gate.
//   - no diff wired (addedLineTextByLine undefined) ALWAYS keeps —
//     back-compat / not-yet-wired callers and tests no-op, mirroring
//     validate-logic-finding's "empty evidence => keep".
//   - a finding with ANY grounding signal keeps: a committable fix, a
//     repro (failureExample), evidence refs, a real evidenceId, OR a
//     backticked token that resolves to a changed line.
//   Only a sub-4 finding with NONE of those is demoted.
//
// SHADOW-FIRST: the actual demotion is gated behind
//   `OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE` (shadow | enforce,
//   default shadow) at the call site. In shadow the decision is only
//   counted/telemetered — never acted on. This module is pure and
//   mode-agnostic.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { hasStructuredFix } from "@/src/shared/domain/pr-review-finding"
import { backtickedTokens } from "./validate-logic-finding"

/**
 * Validator mode. `shadow` (default): telemeter what WOULD be demoted
 * but keep every finding inline. `enforce`: actually demote rejected
 * findings to the review body. Two-state with shadow as the cautious
 * default — matches parsePerfValidatorMode / parseTestsValidatorMode
 * (NOT the three-state gate-config readGateMode; "shadow" already means
 * zero behavior change, so no "off" state is needed).
 */
export type InlineGroundingValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_INLINE_GROUNDING_VALIDATOR_MODE`. Anything other than
 * the literal "enforce" (case-insensitive, trimmed) resolves to
 * "shadow" — the cautious default.
 */
export function parseInlineGroundingValidatorMode(raw: string | undefined): InlineGroundingValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/** Single failure shape — a sub-4 finding with no grounding signal. */
export type InlineGroundingDropReason = "ungrounded-inline-finding"

export type InlineGroundingDecision = { keep: true } | { keep: false; reason: InlineGroundingDropReason }

export interface InlineGroundingEvidence {
  /**
   * Per-file new-side added-line text — the same map the ensemble passes
   * to validateForSubmission (buildAddedLineTextByLine output): the inner
   * map is keyed by line number, values are the added line text with the
   * leading "+" stripped. Undefined when the diff isn't wired (back-compat).
   */
  addedLineTextByLine?: ReadonlyMap<string, ReadonlyMap<number, string>> | undefined
}

// Sentinel used by SIG-108 as the authz-bucket "deliberate non-citation"
// — it is NOT real grounding, so it must not satisfy the evidenceId path.
const EVIDENCE_ID_NONE = "NONE"

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * A non-empty evidenceId that is NOT the SIG-108 authz sentinel "NONE"
 * (a deliberate non-citation, not real grounding).
 */
function hasValidEvidenceId(id: unknown): boolean {
  if (typeof id !== "string") return false
  const trimmed = id.trim()
  return trimmed.length > 0 && trimmed !== EVIDENCE_ID_NONE
}

/**
 * Does ANY backticked token in the finding's headline/body resolve to a
 * changed line of the finding's path? Reuses validate-logic-finding's
 * `backtickedTokens` extractor + the same `length >= 2 && /[A-Za-z_$]/`
 * identifier filter, adapted to the per-line `Map<number, string>` shape
 * the ensemble supplies (iterate the inner map's values()), with two
 * deliberate refinements over the logic validator: (1) tokens are
 * de-duplicated, and (2) a PURE-IDENTIFIER token is matched on a word
 * boundary so it can't false-anchor on a longer identifier (e.g. `async`
 * inside `asyncHelper` — the Codex/CodeRabbit FP). An expression-fragment
 * token (`arr[i]`, `getUser(id)`) keeps substring containment — that was
 * the reason the logic validator used substring, and `\b` + unescaped
 * regex-special chars wouldn't behave.
 *
 * Exported for unit tests.
 */
export function hasResolvableBacktickedToken(
  finding: PrReviewFinding,
  addedLineTextByLine: ReadonlyMap<string, ReadonlyMap<number, string>>,
): boolean {
  const lineMap = addedLineTextByLine.get(finding.path)
  if (!lineMap || lineMap.size === 0) return false
  // Require a LETTER/_/$ and length >= 2 so a pure-punctuation or numeric
  // backtick (`==`, `()`, `10`) can't anchor on almost any line — a real
  // finding names a concrete identifier/member, not an operator/number.
  const tokens = [...new Set(backtickedTokens(finding))].filter((t) => t.length >= 2 && /[A-Za-z_$]/.test(t))
  if (tokens.length === 0) return false
  for (const tok of tokens) {
    // A pure identifier ([A-Za-z_$][\w$]*) is escape-free, so `\b<tok>\b`
    // is safe and prevents the substring false-anchor; everything else
    // (expression fragments) falls back to substring containment.
    const wordMatcher = /^[A-Za-z_$][\w$]*$/.test(tok) ? new RegExp(`\\b${tok}\\b`) : null
    for (const lineText of lineMap.values()) {
      if (wordMatcher ? wordMatcher.test(lineText) : lineText.includes(tok)) return true
    }
  }
  return false
}

/**
 * Pure decision for ONE finding. Mode-agnostic — the orchestrator gates
 * the demotion behind shadow/enforce. See the file header for the full
 * FP-safety contract. Order matters: the score>=4 floor and the
 * no-diff-wired back-compat checks short-circuit before any grounding
 * evaluation so a P0/P1 (or an un-wired caller) can never be demoted.
 */
export function evaluateInlineGrounding(
  finding: PrReviewFinding,
  evidence: InlineGroundingEvidence,
): InlineGroundingDecision {
  // This gate acts only on the 2-3 band:
  //   - score >= 4 is the believability floor — a P0/P1 is never touched
  //     (composes with the PR A floor, which escalates a body-only
  //     score>=4 finding to REQUEST_CHANGES regardless).
  //   - score <= 1 is handled DOWNSTREAM by the score-1 advisory demotion
  //     (ensemble: routes score<=1 to advisoryNits, suppressed under the
  //     chill profile). Demoting it to the body HERE would bypass that
  //     suppression and surface a score-1 nit — so keep it and let the
  //     advisory path own it (Codex catch).
  if (finding.score >= 4 || finding.score <= 1) return { keep: true }

  // No diff wired: nothing to evaluate the backticked-token rule against,
  // so don't gate at all (back-compat for tests / un-threaded callers).
  const { addedLineTextByLine } = evidence
  if (addedLineTextByLine === undefined) return { keep: true }

  const grounded =
    hasStructuredFix(finding) ||
    hasNonEmptyString(finding.failureExample) ||
    (Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.some((r) => hasNonEmptyString(r))) ||
    hasValidEvidenceId(finding.evidenceId) ||
    hasResolvableBacktickedToken(finding, addedLineTextByLine)

  return grounded ? { keep: true } : { keep: false, reason: "ungrounded-inline-finding" }
}
