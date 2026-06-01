// SIG-308: logic-refutation backstop gate.
//
// The deterministic safety net behind Phase 1's analyst-refutation framing.
// Phase 1 gives the logic specialist permission + a sink (`clearedLogicCandidates`)
// to refute a self-spotted concern against an in-code mitigation INSTEAD of
// emitting a finding. This gate catches the residual case: a high-severity
// logic finding the model emitted anyway WITHOUT articulating why it survives
// refutation — the self-refuting-finding shape (the PR #12 `sinceMs` class).
//
// THE PROXY (deterministic, not NLP): a sev>=4 logic finding that carries NO
// `independentAssessment` (the "why no existing guard prevents this" rationale
// the Phase 1 prompt asks for) has not been shown to survive refutation. We
// flag it. We do NOT try to parse the body for self-refutation language —
// that's fuzzy; the codebase's gates (SIG-108/109/111) all use the same
// "missing required field => flag" shape. Post-Phase-1, a disciplined model
// adds the rationale to genuine findings and clears the safe ones, so
// "sev>=4 logic + no rationale" increasingly correlates with "skipped the
// refute-first discipline."
//
// RECALL ASYMMETRY (why this ships dark): logic candidates are self-generated
// (no scanner manifest the orchestrator can re-check), so there is no way to
// re-surface a wrongly-cleared bug. The gate is therefore the ONLY recall
// guard, and a blunt one — initially it will flag many legit findings that
// simply lack a rationale. That is exactly why it ships `shadow` first: the
// `pr-review-finding-rejected-validation` (gate:"logic-refutation") telemetry
// measures the would-flag rate while Phase 1's prompt trains the model to fill
// the rationale; only once the rate settles does an operator flip to `enforce`.
//
// SHADOW-FIRST: the actual drop is gated behind `OPENCLAW_LOGIC_REFUTATION_MODE`
// (off | shadow | enforce, default off in code / shadow in wrangler) at the
// call site. This module is pure and mode-agnostic; the orchestrator decides
// what to do with the verdict.

import type { PrReviewFinding } from "./triage-pr-review"

/**
 * Validator mode. `off` (default in code): the gate doesn't run. `shadow`:
 * telemeter what WOULD be flagged but keep every finding. `enforce`: drop
 * flagged findings. Three-state with `off` as the cautious default — matches
 * the off|shadow|enforce idiom of `parseAbsenceClaimValidatorMode` /
 * `parseSecurityGroundingValidatorMode`.
 */
export type LogicRefutationMode = "off" | "shadow" | "enforce"

/**
 * Parse `OPENCLAW_LOGIC_REFUTATION_MODE`. Case-insensitive, whitespace-
 * tolerant; any unknown / missing value resolves to `off` — the cautious
 * default that disables the gate entirely (wrangler sets `shadow` explicitly).
 */
export function parseLogicRefutationMode(raw: string | undefined): LogicRefutationMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "enforce") return "enforce"
  return "off"
}

/**
 * Severity floor. Mirrors the SIG-109 logic evidence gate's sev>=4 bar — a
 * high-severity logic claim is the one whose self-refutation is most costly
 * (a P0/P1 blocker on safe code). Lower-severity logic findings are left
 * alone; the Phase 1 prompt is the primary control for the score-3 class
 * (the PR #12 case self-clears into `clearedLogicCandidates`).
 */
export const LOGIC_REFUTATION_MIN_SEVERITY = 4

/** Single failure shape — a high-sev logic finding with no survival rationale. */
export type LogicRefutationDropReason = "logic-finding-missing-refutation-survival"

export type LogicRefutationDecision =
  | { keep: true }
  | { keep: false; reason: LogicRefutationDropReason }

/**
 * Evaluate one logic-sourced finding. The call site scopes invocation to
 * logic-sourced findings (via `sourceRolesInclude(sourceIds, "logic")`,
 * mirroring the SIG-109 gate), so this helper does not re-check provenance —
 * it judges the survival rationale only.
 *
 * KEEP when: severity is below the floor, OR the finding carries a non-empty
 * `independentAssessment` (it stated why no existing guard prevents the bug).
 * FLAG otherwise — a sev>=4 logic finding that never showed it survives
 * refutation.
 */
export function evaluateLogicRefutation(finding: PrReviewFinding): LogicRefutationDecision {
  if (finding.score < LOGIC_REFUTATION_MIN_SEVERITY) return { keep: true }
  const rationale =
    typeof finding.independentAssessment === "string" ? finding.independentAssessment.trim() : ""
  if (rationale.length > 0) return { keep: true }
  return { keep: false, reason: "logic-finding-missing-refutation-survival" }
}
