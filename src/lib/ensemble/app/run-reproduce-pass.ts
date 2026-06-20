// SIG-477 PR-3/PR-4 — the reproduce SHADOW pass, extracted from verify-and-build.ts
// (which had reached the file-size budget). Lives in the ensemble/app layer beside its
// only caller so it keeps the SAME dependency direction verify-and-build had
// (app → {ensemble/domain, reproduce, verification}); the `reproduce/` modules stay
// leaf harnesses. Behavior is unchanged from the inline block; PR-4 adds the
// pure-function-logic harness alongside ReDoS.
//
// For each submitted finding: run the PURE `isReproducibleEligible` gate and record
// eligible/ineligible to the `reproduce_eligibility` corpus; then, for an ELIGIBLE
// finding, dispatch the per-class execution harness (ReDoS / pure-function-logic) and
// record its verdict to the `reproduce_result` corpus. In SHADOW this stays
// MEASURE-ONLY (no tier mutation, no customer pill); the `reproduced-by-execution`
// annotate is gated to mode `on` (the customer flip is PR-5). NEVER throws into the
// review: the harnesses are bounded + best-effort, and the gate fails open.
//
// RECALL-SAFETY (unchanged): (a) only ELIGIBLE findings run the sandbox; (b) ONE
// per-PR aggregate sandbox-time budget for the whole review (exhausted ⇒ later
// findings record `skipped`); (c) SKIP the harness when the review is low on
// wall-clock; (d) a thrown harness becomes `skipped`, never affecting the review.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import { findingKey } from "@/src/lib/verification/verify-finding"
import { isReproducibleEligible, type ReproduceMode } from "@/src/lib/verification/reproduce-eligibility"
import { runBoundedRedosHarness } from "@/src/lib/reproduce/harness-redos-runner"
import { runBoundedPureLogicHarness } from "@/src/lib/reproduce/harness-purelogic-runner"
import { HARNESS_MAX_TOTAL_MS } from "@/src/lib/reproduce/harness-redos"
import { PURELOGIC_HARNESS_MAX_TOTAL_MS } from "@/src/lib/reproduce/harness-purelogic"
import { createSandboxBudget } from "@/src/lib/reproduce/sandbox-budget"
import { ORCHESTRATOR_TIMEOUT_MS } from "@/src/lib/ensemble/domain/budget"
import { annotateFindingTrust } from "@/src/lib/ensemble/domain/gates/trust-ledger-thread"
import {
  REPRODUCE_ELIGIBILITY_CATEGORY,
  REPRODUCE_RESULT_CATEGORY,
  type RecordVerificationArgs,
  type ReproduceResultVerdict,
} from "@/src/do/verification-metrics"

// Recall-safety bounds for the SHADOW reproduce block:
//   - REPRODUCE_HARNESS_EST_MS: per-run cost reserved against the budget BEFORE a run
//     — the HONEST worst-case (the larger of the per-harness wall-clock caps).
//   - REPRODUCE_PR_BUDGET_MS: per-PR aggregate sandbox-time ceiling (admits ~2 runs).
//   - REPRODUCE_MIN_REMAINING_MS: below this remaining wall-clock, SKIP the harness.
const REPRODUCE_HARNESS_EST_MS = Math.max(HARNESS_MAX_TOTAL_MS, PURELOGIC_HARNESS_MAX_TOTAL_MS)
const REPRODUCE_PR_BUDGET_MS = 2 * REPRODUCE_HARNESS_EST_MS
const REPRODUCE_MIN_REMAINING_MS = 30_000

/** The bounded harness outcome shape shared by every per-class runner. */
interface BoundedHarnessOutcome {
  verdict: ReproduceResultVerdict
  detail: string
  elapsedMs: number
}

/** Context the pass needs from the verify-and-build seam. `reproduceMode` is already
 *  `shadow`/`on` (the caller checks `!== "off"` before invoking). */
export interface ReproducePassContext {
  reproduceMode: Exclude<ReproduceMode, "off">
  astSecurityFindings: ReadonlyArray<{ path: string; line: number; astFindingId: string }>
  /** Orchestrator start time (epoch ms) for the under-load wall-clock check; absent ⇒
   *  never skip on load (the per-PR sandbox budget still bounds cost). */
  startMs: number | undefined
  owner: string
  repo: string
  prNumber: number
  headSha: string
  verificationOccurredAt: string
}

/**
 * Run the reproduce shadow pass over `findings`, pushing eligibility + result metric
 * items into `metricItems` (flushed by the caller in the batched DO write). Mutates a
 * finding's trust ONLY when `reproduceMode === "on"` and the harness reproduced.
 * NEVER throws.
 */
export async function runReproducePass(
  findings: PrReviewFinding[],
  ctx: ReproducePassContext,
  metricItems: RecordVerificationArgs[],
): Promise<void> {
  const { reproduceMode, astSecurityFindings, owner, repo, prNumber, headSha, verificationOccurredAt } = ctx
  const shortSha = headSha.slice(0, 7)
  const sandboxBudget = createSandboxBudget(REPRODUCE_PR_BUDGET_MS)
  const remainingMs =
    ctx.startMs !== undefined ? ORCHESTRATOR_TIMEOUT_MS - (Date.now() - ctx.startMs) : Number.POSITIVE_INFINITY
  const underLoad = remainingMs < REPRODUCE_MIN_REMAINING_MS

  for (const finding of findings) {
    const elig = isReproducibleEligible(finding, astSecurityFindings)
    console.log(
      JSON.stringify({
        event: "verification-reproduce-eligibility",
        mode: reproduceMode,
        owner,
        repo,
        prNumber,
        headSha: shortSha,
        findingKey: findingKey(finding),
        path: finding.path,
        line: finding.line,
        score: finding.score,
        eligible: elig.eligible,
        reason: elig.reason,
        ...(elig.klass !== undefined ? { klass: elig.klass } : {}),
      }),
    )
    metricItems.push({
      category: REPRODUCE_ELIGIBILITY_CATEGORY,
      verdict: elig.eligible ? "eligible" : "ineligible",
      occurredAt: verificationOccurredAt,
    })

    if (!elig.eligible) continue

    // Dispatch the per-class harness. ReDoS and pure-function-logic each have one;
    // hmac-byte-divergence is eligible-only (no harness yet) → no result recorded.
    let harness: BoundedHarnessOutcome | null = null
    if (elig.klass === "redos") {
      harness = await runBoundedRedosHarness({
        finding,
        budget: sandboxBudget,
        underLoad,
        estMs: HARNESS_MAX_TOTAL_MS,
      })
    } else if (elig.klass === "pure-function-logic") {
      harness = await runBoundedPureLogicHarness({
        finding,
        budget: sandboxBudget,
        underLoad,
        estMs: PURELOGIC_HARNESS_MAX_TOTAL_MS,
      })
    }
    if (harness === null) continue

    console.log(
      JSON.stringify({
        event: "verification-reproduce-result",
        mode: reproduceMode,
        owner,
        repo,
        prNumber,
        headSha: shortSha,
        findingKey: findingKey(finding),
        path: finding.path,
        line: finding.line,
        klass: elig.klass,
        status: harness.verdict,
        detail: harness.detail,
        elapsedMs: harness.elapsedMs,
      }),
    )
    metricItems.push({
      category: REPRODUCE_RESULT_CATEGORY,
      verdict: harness.verdict,
      occurredAt: verificationOccurredAt,
    })

    // ANNOTATE gated to `on` ONLY (NOT shadow): on a real reproduction, lift the
    // finding to the execution-reproduction tier. In SHADOW this NEVER runs — the
    // block stays measure-only. PR-5 is the customer flip.
    if (reproduceMode === "on" && harness.verdict === "reproduced") {
      annotateFindingTrust(finding, { signals: ["reproduced-by-execution"] })
    }
  }
}
