// SIG-488 (recall #5) — the vague-prefix + uncited-testing HARD-DROP gate
// resolvers, extracted from validation-walk.ts so that god-file stays under its
// line budget and the two gates read as one-line delegations (like the other
// `evaluate*` gates).
//
// Both gates currently DELETE a finding outright. For a sev>=4 (P0/P1) finding —
// which a real critical occasionally is, just phrased vaguely or (for testing)
// uncited — `mode: "on"` DEMOTES it to a P2 non-blocking note instead of losing it.
// Low-sev nits + off/shadow drop EXACTLY as before (byte-identical), so the existing
// golden behavior is preserved when the flag is off (the default).
//
// Recall-safe + precision-bounded: a demote can only ADD a finding to output (it was
// being dropped) and is capped at P2 (`Math.min(score, 3)`), so it can NEVER add a
// P0/P1 false positive (same safety profile as SIG-484).

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { annotateFindingTrust } from "./gates/trust-ledger-thread"
import type { HardDropResult, ResolvedValidationArgs, ValidationState } from "./validation-args"

/** The P0/P1 floor — at/above this score a finding is "high severity"; below it,
 *  it's a nit the hard-drop gates correctly delete. */
const HIGH_SEV_GATE_DEMOTE_FLOOR = 4

/**
 * A sev>=4 finding a HARD-DROP heuristic would DELETE is instead demoted to a P2
 * note. Returns the demoted CLONE (caller proceeds) in `on`; null (caller drops as
 * before) in off/shadow or for a low-sev nit. Emits `pr-review-highsev-gate-demote`
 * in shadow (would-save) AND on (save) so the shadow run grades the recall delta
 * before flip. Off returns BEFORE any log/clone → the drop path is byte-identical.
 * Clones before mutating: `f` aliases synthOutput.verdict.findings[i] (telemetry).
 */
function demoteHighSevInsteadOfDrop(
  f: PrReviewFinding,
  reason: "vague-prefix" | "uncited-testing",
  args: ResolvedValidationArgs,
): PrReviewFinding | null {
  if (f.score < HIGH_SEV_GATE_DEMOTE_FLOOR || args.highSevGateDemoteMode === "off") return null
  const willSave = args.highSevGateDemoteMode === "on"
  console.log(
    JSON.stringify({
      event: "pr-review-highsev-gate-demote",
      reason,
      path: f.path,
      score: f.score,
      mode: args.highSevGateDemoteMode,
      // on → demoted to P2 + kept; shadow → would-save but still dropped (no output change).
      saved: willSave,
    }),
  )
  if (!willSave) return null
  const demoted: PrReviewFinding = { ...f, score: Math.min(f.score, 3) }
  if (args.trustLedgerEnabled) annotateFindingTrust(demoted, { demoteReason: reason })
  return demoted
}

/** ARC-156 vague-prefix gate (SIG-488: sev>=4 demote-instead-of-drop). */
export function resolveVaguePrefixGate(
  f: PrReviewFinding,
  args: ResolvedValidationArgs,
  state: ValidationState,
): HardDropResult {
  const saved = demoteHighSevInsteadOfDrop(f, "vague-prefix", args)
  if (saved) return { kind: "proceed", finding: saved }
  state.droppedForVaguePrefix++
  return { kind: "continue" }
}

/** SIG-113 uncited-testing-evidence gate (SIG-488: sev>=4 demote-instead-of-drop).
 *  A demote-saved finding is posted, so it is NOT counted/reported as a drop. */
export function resolveUncitedTestingGate(
  f: PrReviewFinding,
  reason: "no-citation",
  args: ResolvedValidationArgs,
  state: ValidationState,
): HardDropResult {
  const saved = demoteHighSevInsteadOfDrop(f, "uncited-testing", args)
  if (saved) return { kind: "proceed", finding: saved }
  state.droppedForUncitedTestingEvidence++
  args.onTestingFindingDropped?.(f, reason)
  return { kind: "continue" }
}
