// SIG-110: performance-finding evidence gate.
//
// The perf analogue of SIG-108's `evaluateSecurityFinding`, SIG-111's
// `evaluateTestFinding`, and SIG-109's `evaluateLogicFinding`. A sev>=4
// `performance`-sourced finding is KEPT when it is concretely anchored to
// the diff; only a vague, unanchored sev>=4 perf claim is rejected.
//
// FALSE-NEGATIVE SAFETY (biases toward KEEP, like the logic gate): many
// real perf findings are LLM-found (a quadratic loop, a blocking call on a
// hot path) with no deterministic backing. So the bar is broad:
//   KEEP a sev>=4 perf finding when it has a concrete `path` that is a
//   CHANGED file AND ANY ONE of:
//     (a) a co-located deterministic AST perf hit (an `ast/...` finding
//         with roleHint performance at the same path, within a few lines),
//     (b) an anchor token that appears in the ADDED/REMOVED-line TEXT of
//         `finding.path`. Anchor tokens are drawn from backticked spans in
//         the headline/body AND from the structured `complexityEstimate`
//         field, PLUS identifier-ish tokens parsed from `hotPathIdentifier`.
//         This is the key FP-safety fix from the Codex + deepseek-v4-pro
//         review: a `complexityEstimate` / `hotPathIdentifier` is only
//         credited when it NAMES real changed code — free-text boilerplate
//         ("O(n^2) somewhere") anchors nothing and does not pass.
//   REJECT only when sev>=4 perf AND (no changed-path anchor) AND (no
//   anchoring token on a changed line) AND (no co-located AST perf hit).
//
// SHADOW-FIRST: the actual drop is gated behind
//   `OPENCLAW_PERF_VALIDATOR_MODE` (shadow | enforce, default shadow) at
//   the call site. In shadow the verdict is only counted/telemetered —
//   NEVER dropped. This module is pure and mode-agnostic.

import type { PrReviewFinding } from "./triage-pr-review"
import type { AstFinding } from "./ast-rules/types"
import { buildChangedLineTextByPath } from "./validate-logic-finding"

export { buildChangedLineTextByPath }

/**
 * Validator mode. `shadow` (default): telemeter what WOULD be dropped but
 * keep every finding. `enforce`: actually drop rejected findings.
 */
export type PerfValidatorMode = "shadow" | "enforce"

/**
 * Parse `OPENCLAW_PERF_VALIDATOR_MODE`. Anything other than the literal
 * "enforce" (case-insensitive, trimmed) resolves to "shadow" — the
 * cautious default. Mirrors the other specialists' mode parsers.
 */
export function parsePerfValidatorMode(raw: string | undefined): PerfValidatorMode {
  return (raw ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "shadow"
}

/** Co-location tolerance for an AST perf hit relative to the finding line. */
export const AST_COLOCATION_TOLERANCE = 5

export type PerfFindingDecision =
  | { keep: true }
  | { keep: false; reason: PerfDropReason }

export type PerfDropReason =
  | "missing-path" // sev>=4 perf finding with no concrete path to anchor
  | "path-not-changed" // sev>=4 perf on a path the PR didn't touch
  | "unanchored-perf-claim" // sev>=4 perf on a CHANGED path but naming no concrete changed token + no co-located AST perf hit

export interface PerfEvidence {
  /** Per-file CHANGED-line text from the unified diff (added + removed,
   *  leading sign stripped). A path present here is the changed-path anchor. */
  changedLineTextByPath: ReadonlyMap<string, readonly string[]>
  /** Deterministic AST findings filtered to `roleHint === "performance"`. */
  astPerfFindings: readonly AstFinding[]
}

/** Backticked spans from headline + body + complexityEstimate. */
function backtickedTokens(finding: PrReviewFinding): string[] {
  const text = `${finding.headline ?? ""} ${finding.body ?? ""} ${finding.complexityEstimate ?? ""}`
  const out: string[] = []
  const re = /`([^`]+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = m[1]!.trim()
    if (tok.length > 0) out.push(tok)
  }
  return out
}

/** Identifier-ish tokens parsed out of a free-form hotPathIdentifier such
 *  as "GET /api/orders" or "handleCheckout" — split on non-identifier
 *  chars, keep tokens >=3 chars containing a letter. HTTP-verb words are
 *  dropped (too generic to anchor on). */
const HOT_PATH_STOPWORDS: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "api", "the", "and",
])
function hotPathTokens(finding: PrReviewFinding): string[] {
  const raw = finding.hotPathIdentifier
  if (typeof raw !== "string" || raw.trim().length === 0) return []
  return raw
    .split(/[^A-Za-z0-9_$]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && /[A-Za-z_$]/.test(t) && !HOT_PATH_STOPWORDS.has(t.toLowerCase()))
}

function isChangedPath(path: string, evidence: PerfEvidence): boolean {
  return evidence.changedLineTextByPath.has(path)
}

/** Does ANY anchor token (backticks + complexityEstimate + hotPathIdentifier)
 *  appear in the changed-line text of the finding's path? */
function hasConcreteChangedToken(finding: PrReviewFinding, evidence: PerfEvidence): boolean {
  const lines = evidence.changedLineTextByPath.get(finding.path)
  if (!lines || lines.length === 0) return false
  const tokens = [
    // >=3 chars (Codex/code-reviewer): a 2-char backtick token (`db`, `id`,
    // `fs`) appears on almost any changed line and would let a vague claim
    // anchor trivially. Match the >=3 floor `hotPathTokens` already uses.
    ...backtickedTokens(finding).filter((t) => t.length >= 3 && /[A-Za-z_$]/.test(t)),
    ...hotPathTokens(finding),
  ]
  if (tokens.length === 0) return false
  for (const tok of tokens) {
    for (const line of lines) {
      if (line.includes(tok)) return true
    }
  }
  return false
}

/** Co-located AST perf hit within +/-AST_COLOCATION_TOLERANCE lines. */
function hasColocatedAstHit(finding: PrReviewFinding, evidence: PerfEvidence): boolean {
  for (const ast of evidence.astPerfFindings) {
    if (ast.path !== finding.path) continue
    const spanEnd = ast.endLine && ast.endLine >= ast.line ? ast.endLine : ast.line
    const start = ast.line - AST_COLOCATION_TOLERANCE
    const end = spanEnd + AST_COLOCATION_TOLERANCE
    if (finding.line >= start && finding.line <= end) return true
  }
  return false
}

/**
 * Pure decision for ONE perf-applicable finding. The caller has already
 * decided this finding's derived role set includes `performance` (via the
 * `performance-` sourceFindingId prefix) AND that `score >= 4`. Mode-agnostic.
 *
 * Contract (FP-safe; bias toward KEEP):
 *   - score < 4 → keep (the evidence bar is sev>=4 only).
 *   - missing/empty `path` → `missing-path`.
 *   - no evidence wired at all → keep (back-compat / staged rollout).
 *   - co-located AST perf hit → keep (independent evidence channel).
 *   - path not changed → `path-not-changed`.
 *   - changed path AND an anchor token on a changed line → keep.
 *   - changed path but neither → `unanchored-perf-claim`.
 */
export function evaluatePerfFinding(
  finding: PrReviewFinding,
  evidence: PerfEvidence,
): PerfFindingDecision {
  if (finding.score < 4) return { keep: true }

  const path = typeof finding.path === "string" ? finding.path.trim() : ""
  if (path.length === 0) return { keep: false, reason: "missing-path" }

  if (evidence.changedLineTextByPath.size === 0 && evidence.astPerfFindings.length === 0) {
    return { keep: true }
  }

  if (hasColocatedAstHit(finding, evidence)) return { keep: true }

  if (!isChangedPath(path, evidence)) {
    return { keep: false, reason: "path-not-changed" }
  }

  if (hasConcreteChangedToken(finding, evidence)) return { keep: true }

  return { keep: false, reason: "unanchored-perf-claim" }
}
