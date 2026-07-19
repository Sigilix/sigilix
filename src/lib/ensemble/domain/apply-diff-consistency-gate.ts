// SIG-602: applies the diff-consistency gate to ONE finding during the demote
// walk. Extracted from `validation-walk.ts` (file-size budget) so the walk's
// per-finding block stays a single call. Mirrors the sibling grounding-gate
// idiom: `off` skips; `shadow` counts + telemeters and keeps the finding inline;
// only `enforce` trust-demotes. Returns `true` when the finding was DEMOTED
// (enforce) and the caller should short-circuit the remaining gates. No score
// floor — a provably-false P0/P1 is a false positive, not a real one.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { ResolvedValidationArgs, ValidationContext, ValidationState } from "./validation-args"
import { annotateFindingTrust } from "./gates/trust-ledger-thread"
import { evaluateDiffConsistency } from "./gates/validate-diff-consistency"

export function applyDiffConsistencyGate(
  finding: PrReviewFinding,
  args: ResolvedValidationArgs,
  ctx: ValidationContext,
  state: ValidationState,
): boolean {
  if (args.diffConsistencyValidatorMode === "off") return false
  const decision = evaluateDiffConsistency(finding, {
    reviewablePaths: ctx.reviewablePaths,
    addedLineTextByLine: args.addedLineTextByLine,
  })
  if (decision.keep) return false
  state.droppedForFailedDiffConsistencyValidation++
  args.onDiffConsistencyFindingDropped?.(finding, { reason: decision.reason, dropped: false })
  if (args.diffConsistencyValidatorMode !== "enforce") return false // shadow: count/telemeter, keep inline
  if (args.trustLedgerEnabled) annotateFindingTrust(finding, { demoteReason: "diff-consistency" })
  return true
}
