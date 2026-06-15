// SIG-418 Phase 2 (Design B′) — in-invocation multi-batch review: pure budget +
// flag (domain layer).
//
// Design B′ stays in ONE Cloudflare invocation and reviews the PR in multiple
// batches (the diff packer already produces them — `packFilesIntoBatches`,
// `diff-packing.ts`). Between batches the orchestrator must decide, against a
// REAL wall-clock, whether another specialist batch still fits before the synth
// tail has to run. This module is the PURE decision for that — no env, no clock,
// no IO: `now` and the timeout constants are injected so it is unit-testable.
//
// The synth-budgeted deadline (mandatory correction #1 from the spec's DECISION
// block). Naively gating on `elapsed + one_worst_case_wave ≤ ORCHESTRATOR` is
// UNSAFE — it forgets that synth + finalize still have to run after the last
// batch. So we reserve the whole synth tail FIRST and only ever launch a batch
// inside the *pre-synth* window:
//
//   tailReserveMs     = SYNTHESIZER_TIMEOUT_MS + RESERVED_HEADROOM_MS
//   preSynthDeadline  = startMs + ORCHESTRATOR_TIMEOUT_MS − tailReserveMs
//   remainingForBatch = preSynthDeadline − now
//   launch only if      remainingForBatch ≥ minUsefulBatchMs
//   batchTimeoutMs    = min(SPECIALIST_TIMEOUT_MS, remainingForBatch)   // ≥ 0
//
// RESERVED_HEADROOM_MS already absorbs the synth retry + pre-flight + finalize
// (see `budget.ts`); reserving the full synth budget PLUS the full headroom is
// the conservative choice — the tail can never be starved by a batch we let
// start. This is deliberately the same envelope `assertEnsembleBudgetInvariants`
// proves fits under the orchestrator wall, read here as a runtime deadline
// instead of a load-time assertion.
//
// PR 1 is DARK: this is pure infra only. Nothing calls it on the prod path yet
// (the batch loop is PR 2), so default behavior is byte-identical.

import { ORCHESTRATOR_TIMEOUT_MS, RESERVED_HEADROOM_MS, SPECIALIST_TIMEOUT_MS, SYNTHESIZER_TIMEOUT_MS } from "./budget"

/** In-invocation multi-batch review rollout mode (default `off`). Mirrors the
 *  `off | shadow | on` flag idiom used across the ensemble (e.g. `resweep.ts`). */
export type MultiBatchMode = "off" | "shadow" | "on"

/** Normalize `OPENCLAW_REVIEW_MULTIBATCH_MODE` (default "off", trim + lowercase). */
export function parseMultiBatchMode(raw: string | undefined): MultiBatchMode {
  const v = (raw ?? "").trim().toLowerCase()
  return v === "shadow" || v === "on" ? v : "off"
}

/** The timeout budget the next-batch decision reads. Injected (not imported as
 *  constants directly) so the pure decision is exercisable with any permutation
 *  in a unit test; the real constants flow in via `decideNextBatchLaunchWithBudget`. */
export interface MultiBatchBudgetTimeouts {
  specialistMs: number
  synthesizerMs: number
  reservedHeadroomMs: number
  orchestratorMs: number
}

/** Inputs to the next-batch launch decision. */
export interface NextBatchLaunchInput extends MultiBatchBudgetTimeouts {
  /** The orchestrator timer ORIGIN (epoch ms) — i.e. when the whole orchestrator
   *  wall started, NOT when the batch loop began. Anchoring to the orchestrator
   *  origin is what makes pre-flight + packing time count against the budget; an
   *  origin set later (e.g. at first batch) would silently ignore that elapsed
   *  time and overshoot the wall. */
  startMs: number
  /** The current wall-clock (epoch ms). Injected so the decision is pure. */
  now: number
  /** The smallest remaining pre-synth window that is worth starting another
   *  batch in. A batch that can't get at least this much time would burn budget
   *  without a realistic chance of a useful verdict, so we stop instead. */
  minUsefulBatchMs: number
}

/** The next-batch launch decision. */
export interface NextBatchLaunchDecision {
  /** Launch another specialist batch only when the pre-synth window still holds
   *  at least `minUsefulBatchMs`. */
  canLaunchNextBatch: boolean
  /** The timeout to give the next batch's specialists — `SPECIALIST_TIMEOUT_MS`
   *  clamped down to whatever pre-synth time is actually left (never negative).
   *  Meaningful only when `canLaunchNextBatch` is true. */
  batchTimeoutMs: number
  /** The absolute epoch-ms deadline after which only the synth tail may run.
   *  Returned for telemetry / callers that want to log the reserved window. */
  preSynthDeadline: number
}

/**
 * Decide whether another specialist batch fits before the reserved synth tail,
 * and with what timeout. PURE — `now` and the timeout constants are inputs.
 *
 * Reserves `synthesizerMs + reservedHeadroomMs` for the synth tail, then offers
 * the next batch only the time left before that reserve, capped at one
 * `specialistMs` wave and floored at 0.
 */
export function decideNextBatchLaunch(input: NextBatchLaunchInput): NextBatchLaunchDecision {
  const tailReserveMs = input.synthesizerMs + input.reservedHeadroomMs
  const preSynthDeadline = input.startMs + input.orchestratorMs - tailReserveMs
  const remainingForBatch = preSynthDeadline - input.now
  // Launch only with a positive pre-synth window AND at least `minUsefulBatchMs`
  // of it. The `> 0` guard keeps a non-positive remaining window un-launchable
  // even if a caller passes a non-positive `minUsefulBatchMs` — "launchable with
  // a 0 ms timeout" is never a useful decision.
  const canLaunchNextBatch = remainingForBatch > 0 && remainingForBatch >= input.minUsefulBatchMs
  // Clamp to one specialist wave, and never hand out a negative timeout.
  const batchTimeoutMs = Math.max(0, Math.min(input.specialistMs, remainingForBatch))
  return { canLaunchNextBatch, batchTimeoutMs, preSynthDeadline }
}

/**
 * Convenience wrapper over `decideNextBatchLaunch` that supplies the real
 * `budget.ts` timeout constants, so call sites pass only the live wall-clock
 * inputs. Kept thin and pure (the constants are module-level values, not env).
 */
export function decideNextBatchLaunchWithBudget(args: {
  startMs: number
  now: number
  minUsefulBatchMs: number
}): NextBatchLaunchDecision {
  return decideNextBatchLaunch({
    startMs: args.startMs,
    now: args.now,
    minUsefulBatchMs: args.minUsefulBatchMs,
    specialistMs: SPECIALIST_TIMEOUT_MS,
    synthesizerMs: SYNTHESIZER_TIMEOUT_MS,
    reservedHeadroomMs: RESERVED_HEADROOM_MS,
    orchestratorMs: ORCHESTRATOR_TIMEOUT_MS,
  })
}
