// SIG-325: generalized refutation-survival gate.
//
// Generalizes the SIG-308 logic-refutation backstop (validate-logic-refutation.ts)
// to any lens. The thesis is identical: a SELF-ORIGINATED finding — one with no
// deterministic tool fact behind it — at high severity must articulate why its
// mechanism survives refutation (recorded in `independentAssessment`), or it
// reads as a verdict reached BEFORE the reasoning and is dropped.
//
// WHY A SEPARATE GATE FROM SIG-308: the logic lens has no scanner at all, so
// `evaluateLogicRefutation` is scoped to logic-sourced findings as a whole. This
// gate covers the OTHER lenses where a finding can be EITHER tool-backed or
// self-originated — chiefly security, where a CWE claim with no resolving
// [SECURITY EVIDENCE MANIFEST] fact (`evidenceId` empty or "NONE") is something
// no scanner proposed, so the SIG-282 candidate-verification path never engaged.
// That self-originated case is the SSRF / path-traversal / prototype-pollution
// hallucination class: a CWE label with a confabulated mechanism.
//
// THE PROXY (deterministic, not NLP): a sev>=4 self-originated finding carrying
// NO `independentAssessment` (the source→sink→type the Phase-1 prompt asks the
// specialist to confirm PRESENT in the changed code) has not been shown to
// survive refutation. We flag it. We do NOT parse the body for refutation
// language — every gate in this codebase uses the same "missing required field
// => flag" shape.
//
// SELF-ORIGINATION IS THE CALLER'S CALL. This module is lens-agnostic and PURE.
// The orchestrator decides, per lens, whether a finding is self-originated
// (security: no resolving manifest `evidenceId`) before invoking the gate — a
// tool-backed finding is covered by its own evidence gate and must NOT be
// double-gated here. The orchestrator also owns the off|shadow|enforce decision
// and the demote/keep action, mirroring every other gate in the ensemble.
//
// SHADOW-FIRST: the actual demote is gated behind `OPENCLAW_REFUTATION_SURVIVAL_MODE`
// (off | shadow | enforce, default off in code / shadow in wrangler) at the call
// site. This module is mode-agnostic; the orchestrator acts on the verdict.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

/**
 * Validator mode. `off` (default in code): the gate doesn't run. `shadow`:
 * telemeter what WOULD be flagged but keep every finding inline. `enforce`:
 * demote flagged findings to the review body. Three-state with `off` as the
 * cautious default — matches `parseLogicRefutationMode` and the rest of the
 * off|shadow|enforce gates.
 */
export type RefutationSurvivalMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_REFUTATION_SURVIVAL_MODE`. Case-insensitive, whitespace-
 * tolerant; any unknown / missing value resolves to `off` (the cautious default;
 * wrangler sets `shadow` explicitly).
 */
export function parseRefutationSurvivalMode(raw: string | undefined): RefutationSurvivalMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/**
 * Severity floor. Mirrors the SIG-308 `LOGIC_REFUTATION_MIN_SEVERITY` bar — a
 * high-severity claim is the one whose un-refuted mechanism is most costly (a
 * P0/P1 blocker on safe code). Lower-severity findings are left alone; the
 * Phase-1 prompt is the primary control for the score-3 class.
 */
export const REFUTATION_SURVIVAL_MIN_SEVERITY = 4

/** Single failure shape — a high-sev self-originated finding with no survival rationale. */
export type RefutationSurvivalDropReason = "refutation-survival-missing"

export type RefutationSurvivalDecision = { keep: true } | { keep: false; reason: RefutationSurvivalDropReason }

/**
 * Evaluate one finding the caller has ALREADY determined is self-originated for
 * its lens. KEEP when severity is below the floor, OR the finding carries a
 * non-empty `independentAssessment` (it stated why its mechanism survives
 * refutation). FLAG otherwise — a sev>=4 self-originated finding that never
 * showed its mechanism is real.
 *
 * The caller MUST scope invocation to self-originated findings; a tool-backed
 * finding is covered by its own evidence gate and must not be double-gated.
 */
export function evaluateRefutationSurvival(finding: PrReviewFinding): RefutationSurvivalDecision {
  if (finding.score < REFUTATION_SURVIVAL_MIN_SEVERITY) return { keep: true }
  const rationale = typeof finding.independentAssessment === "string" ? finding.independentAssessment.trim() : ""
  if (rationale.length > 0) return { keep: true }
  return { keep: false, reason: "refutation-survival-missing" }
}
