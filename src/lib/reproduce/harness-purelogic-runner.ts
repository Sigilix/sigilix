// SIG-477 PR-4 — the BOUNDED pure-function-logic harness runner: the recall-safety
// wrapper the review path calls so the inline sandbox can NEVER delay or break a
// review. Sibling of `harness-redos-runner.ts`; same admission-gate contract.
//
// `runPureLogicHarness` (harness-purelogic.ts) is the engine; this is the admission
// gate around it. The review-path wiring (run-reproduce-pass.ts) owns the per-PR
// sandbox budget + the under-load decision; this helper enforces them per finding and
// turns any failure into a `skipped` result — so the caller's loop stays a few lines.

import { runPureLogicHarness, type PureLogicHarnessInput } from "./harness-purelogic"
import type { SandboxBudget } from "./sandbox-budget"
import type { ReproduceResultVerdict } from "@/src/do/verification-metrics"

/** The bounded harness outcome: a closed `reproduce_result` verdict + a stable
 *  machine-readable detail + the measured elapsed ms (0 when it never ran). */
export interface BoundedPureLogicResult {
  verdict: ReproduceResultVerdict
  detail: string
  elapsedMs: number
}

/** Inputs to the per-finding admission gate. */
export interface BoundedPureLogicArgs {
  finding: PureLogicHarnessInput
  /** The review's shared per-PR aggregate sandbox-time budget. Reserved up front. */
  budget: SandboxBudget
  /** True when the review is already low on wall-clock → skip without running. */
  underLoad: boolean
  /** The per-run cost reserved against `budget` before a run (the harness's own
   *  deadlines then bound the ACTUAL cost). */
  estMs: number
}

/**
 * Run the pure-logic harness for ONE finding under the review's recall-safety bounds.
 * NEVER throws. Returns `skipped` (without running the sandbox) when the review is
 * under wall-clock load OR the per-PR sandbox budget is exhausted; otherwise runs the
 * harness and maps its status straight through. A thrown harness (documented
 * never-throws, but be defensive) is also turned into `skipped` — a harness failure
 * must NEVER affect the review or the findings.
 */
export async function runBoundedPureLogicHarness(args: BoundedPureLogicArgs): Promise<BoundedPureLogicResult> {
  if (args.underLoad) return { verdict: "skipped", detail: "under-load", elapsedMs: 0 }
  if (!args.budget.tryConsume(args.estMs)) return { verdict: "skipped", detail: "over-budget", elapsedMs: 0 }
  try {
    const res = await runPureLogicHarness(args.finding)
    return { verdict: res.status, detail: res.detail, elapsedMs: res.elapsedMs }
  } catch (err) {
    return { verdict: "skipped", detail: `error:${err instanceof Error ? err.name : "unknown"}`, elapsedMs: 0 }
  }
}
