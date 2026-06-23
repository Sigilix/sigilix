// SIG-477 PR-4 — the SECOND execution harness: pure-function logic divergence.
//
// The reproduce wedge for the pure/IO-free slice (off-by-one / fence-post / boundary
// / coercion bugs) whose failure is a WRONG RETURN VALUE — re-runnable as a
// deterministic two-sided test. It lifts BOTH the finding's BUGGY function and the
// model's SUGGESTED FIX, runs them side-by-side over a battery of boundary inputs in
// the QuickJS sandbox (PR-2's `runInSandbox`), and observes whether they DIVERGE — so
// a `reproduced` verdict means "we ran both and the buggy code returns a different
// value at a boundary input", never a model judgment.
//
// ── A THIN ADAPTER OVER THE SHARED CORE ─────────────────────────────────────
// The reusable mechanics — lifting a snippet into a callable, the type-aware battery,
// the comparison-source builder, the agree/diverge tally, and the determinism re-run —
// now live in `purelogic-pair.ts` (the shared core), so the /v1/verify oracle
// (`comparePairInSandbox`) and this finding path share ONE implementation. THIS file is
// the finding-path adapter: it reads the cited buggy + fix code off a finding, delegates
// the comparison to `compareLiftedPair`, and maps the result to the reproduced /
// inconclusive / skipped verdict vocabulary the review path expects. Behavior is
// UNCHANGED by the extraction — e2e/reproduce-fp-eval.test.ts pins it (100% recall, 0%
// over-fire on the corpus) and harness-purelogic.test.ts pins every verdict + detail tag.
//
// ── WHY THIS WEDGE, NOT ReDoS ───────────────────────────────────────────────
// The ReDoS harness (the design's "cleanest" wedge) does NOT reproduce in QuickJS:
// its regex engine (libregexp) ≠ V8's, so a V8-catastrophic regex isn't necessarily
// catastrophic in QuickJS, and a regex match is a single C call the cycle-interrupt
// can't subdivide (live probes returned `inconclusive` on textbook catastrophic
// regexes, twice). Pure-function logic is strictly more robust: the output of a pure
// function is ENGINE-INDEPENDENT (identical in QuickJS and V8), the signal is a
// DETERMINISTIC OUTPUT COMPARISON (no timeout/flakiness), and a runaway buggy loop is
// BYTECODE — exactly what the opcode-cycle interrupt CAN bound.
//
// ── THE HONEST DECISION ─────────────────────────────────────────────────────
// A finding is "reproduced" iff the buggy and fixed functions DIVERGE on ≥1 battery
// input AND the tally REPRODUCES on a re-run (determinism — pure code is deterministic
// since the eligibility gate refused Date/random, but a re-run catches anything that
// slipped). all-AGREE (diverge=0) → INCONCLUSIVE: the fix is a no-op on the battery, so
// the bug can't be demonstrated — this is the FP-SAFETY FLOOR (a behavior-PRESERVING
// change never reproduces). all-DIVERGE is NOT special-cased: under source-reconstruction
// `fixed` = `buggy` + the suggested hunk, so the two are never unrelated functions, and
// an all-diverge result is a constant-offset / wrong-seed bug (a real, always-wrong
// defect). The harness NEVER refutes and NEVER throws.
//
// ── THE BATTERY (type-aware) ────────────────────────────────────────────────
// Each parameter is swept over an IN-TYPE pool derived from its TS annotation (a `number`
// param gets only numbers, etc.), augmented with the function's own numeric literals ±1
// so boundary comparisons (`age > 18` vs `>= 18`) are hit. This is what keeps a
// type-correct equivalent rewrite (`x*2` vs `x+x`, identical for numbers but not for
// strings) from FALSELY diverging via coercion. An untyped (`any`) param gets the full
// mixed pool, so a genuine coercion bug is still exercised. Measured by the FP eval
// (e2e/reproduce-fp-eval.test.ts): 100% recall, 0% over-fire on the corpus.

import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"
import type { SandboxCaps } from "./sandbox-runner"
import { compareLiftedPair, liftFunction, PURELOGIC_PAIR_CAPS } from "./purelogic-pair"

/** The cited-code fields the harness reads. All optional — a finding may carry any
 *  subset (the eligibility gate ensured at least one holds liftable code). Buggy code
 *  is lifted from the BUGGY-biased fields (failureExample / astEvidence / body
 *  fences); the corrected function is lifted from the FIX fields (suggestedReplacement
 *  / fixExample) — the harness needs BOTH to form the two-sided test. */
export interface PureLogicHarnessInput {
  failureExample?: PrReviewFinding["failureExample"]
  astEvidence?: PrReviewFinding["astEvidence"]
  suggestedReplacement?: PrReviewFinding["suggestedReplacement"]
  fixExample?: PrReviewFinding["fixExample"]
  body?: PrReviewFinding["body"]
}

/** The harness outcome. `reproduced` = the two-sided test fired (agree + diverge,
 *  deterministically); `inconclusive` = we could NOT demonstrate a targeted
 *  divergence (no-divergence / wholesale / flaky / guest-error — NEVER a refutation);
 *  `skipped` = nothing to run (no liftable buggy+fixed pair, arity mismatch) or a
 *  fail-safe on any unexpected error. `detail` is a stable machine-readable tag. */
export interface PureLogicHarnessResult {
  status: "reproduced" | "inconclusive" | "skipped"
  detail: string
  elapsedMs: number
}

/** Per-run sandbox caps (the shared-core caps — a pure-function battery is BYTECODE, so
 *  the opcode-cycle interrupt is the real bound; see purelogic-pair.ts). */
const HARNESS_CAPS: SandboxCaps = PURELOGIC_PAIR_CAPS

/** HARD wall-clock cap on a SINGLE harness invocation (two full-battery sandbox runs,
 *  each bounded by the caps above). The per-run figure the caller's per-PR budget
 *  reserves, so the aggregate ceiling is HONEST. */
export const PURELOGIC_HARNESS_MAX_TOTAL_MS = 2_000

/** BUGGY-code candidates (the failing function), in preference order: the structured
 *  buggy fields, then the body's code fences, then the raw body. Excludes the FIX
 *  fields (those are the corrected function). */
function buggyCandidates(finding: PureLogicHarnessInput): string[] {
  const parts: string[] = []
  for (const v of [finding.failureExample, finding.astEvidence]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  const body = typeof finding.body === "string" ? finding.body : ""
  const fence = /```[a-z]*\n([\s\S]*?)```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(body)) !== null) {
    if (m[1] && m[1].trim().length > 0) parts.push(m[1])
  }
  if (body.trim().length > 0) parts.push(body)
  return parts
}

/** FIXED-code candidates (the corrected function): the structured fix fields only.
 *  The committable `suggestedReplacement` is the canonical corrected variant. */
function fixedCandidates(finding: PureLogicHarnessInput): string[] {
  const parts: string[] = []
  for (const v of [finding.suggestedReplacement, finding.fixExample]) {
    if (typeof v === "string" && v.trim().length > 0) parts.push(v)
  }
  return parts
}

/** Detail tags from the shared kernel's `skipped` branch that the FINDING path treats as
 *  INCONCLUSIVE (a measurement that didn't demonstrate a divergence — never a refutation),
 *  not `skipped` (nothing runnable). The remaining kernel-skipped tags (arity / battery)
 *  stay `skipped` — there was no runnable two-sided test at all. */
const INCONCLUSIVE_SKIP_DETAILS = new Set(["array-ctor-rewrite", "guest-no-tally", "flaky-divergence"])

/**
 * Run the pure-function-logic harness on ONE finding. NEVER throws; returns a
 * structured {@link PureLogicHarnessResult}. See the module header for the two-sided
 * decision and the never-reproduced-without-agreement guard. A thin adapter: it lifts
 * the cited buggy + fix code, delegates to the shared `compareLiftedPair` kernel, and
 * maps the kernel result back to the finding-path verdict vocabulary.
 *
 * @param finding the submitted finding (its buggy + fix code is lifted).
 * @param caps optional sandbox-cap override (defaults to the harness caps).
 */
export async function runPureLogicHarness(
  finding: PureLogicHarnessInput,
  caps: SandboxCaps = HARNESS_CAPS,
): Promise<PureLogicHarnessResult> {
  const start = Date.now()
  const elapsed = (): number => Date.now() - start
  try {
    const buggy = liftFunction(buggyCandidates(finding))
    const fixed = liftFunction(fixedCandidates(finding))
    if (buggy === null || fixed === null) {
      return { status: "skipped", detail: buggy === null ? "no-buggy-fn" : "no-fixed-fn", elapsedMs: elapsed() }
    }
    const cmp = await compareLiftedPair({ buggy, fixed }, caps)
    if (cmp.kind === "diverged") {
      // DIVERGE on ≥1 input (deterministically) = the buggy code measurably behaves
      // differently from the fix → reproduced.
      return { status: "reproduced", detail: cmp.detail, elapsedMs: elapsed() }
    }
    if (cmp.kind === "agreed") {
      // all-AGREE → the fix is a no-op on the (type-correct) battery → can't demonstrate
      // the bug → inconclusive (the FP-safety floor: a behavior-PRESERVING change never
      // reproduces).
      return { status: "inconclusive", detail: cmp.detail, elapsedMs: elapsed() }
    }
    // kind === "skipped": split the kernel's machine-readable detail into the finding
    // path's two non-reproduced verdicts — a measurement that didn't fire (inconclusive)
    // vs nothing runnable at all (skipped).
    const status = INCONCLUSIVE_SKIP_DETAILS.has(cmp.detail) ? "inconclusive" : "skipped"
    return { status, detail: cmp.detail, elapsedMs: elapsed() }
  } catch (err) {
    return { status: "skipped", detail: `error:${err instanceof Error ? err.name : "unknown"}`, elapsedMs: elapsed() }
  }
}
