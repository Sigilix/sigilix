// SIG-477 PR-2 — the per-PR aggregate sandbox CPU budget (DARK: capability only).
//
// The sandbox runner (sandbox-runner.ts) caps a SINGLE execution with a per-call
// deadline + memory/stack limits. This caps the CUMULATIVE sandbox time across a
// whole review: a PR with many reproduce-eligible findings could otherwise run the
// runner once per finding and, in aggregate, blow the orchestrator's CPU budget
// (the 895s orch budget vs the CF wall). The design's per-PR aggregate ceiling.
//
// The caller (PR-3+) creates ONE budget per review and asks `tryConsume(estMs)`
// before each sandbox run — a cheap admission gate that reserves the estimated
// cost up front (the runner's own deadline then bounds the ACTUAL cost). Reserving
// the estimate (not the measured elapsed) keeps the gate honest under bursts: a
// run that overshoots its estimate is still bounded by its own deadline, and the
// next admission still sees the reserved estimate.
//
// Pure, synchronous, no IO, never throws. NOTHING in the review path constructs a
// budget in this PR — it ships dark alongside the runner.

/** A per-PR aggregate sandbox-time budget. `tryConsume` admits a run only if its
 *  estimated cost fits under the remaining budget (reserving the estimate on
 *  success); `spent()` reports the cumulative reserved time so far. */
export interface SandboxBudget {
  /** Reserve `estMs` against the remaining budget. Returns `true` (and records the
   *  reservation) when it fits; `false` (and records nothing) when it would
   *  exceed the total. A non-finite or non-positive `estMs` is treated as 0 cost
   *  and always admitted (a no-cost probe never exhausts the budget). */
  tryConsume(estMs: number): boolean
  /** Cumulative reserved time so far (ms). */
  spent(): number
  /** Remaining budget (ms), never negative. */
  remaining(): number
}

/**
 * Create a per-PR aggregate sandbox budget with a `totalMs` ceiling. A non-finite
 * or non-positive `totalMs` yields a zero budget (admits only zero-cost probes) —
 * fail-closed, so a misconfigured ceiling can never grant unbounded sandbox time.
 */
export function createSandboxBudget(totalMs: number): SandboxBudget {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : 0
  let used = 0
  return {
    tryConsume(estMs: number): boolean {
      // Non-finite / non-positive estimate → zero-cost probe, always admitted.
      const cost = Number.isFinite(estMs) && estMs > 0 ? estMs : 0
      if (used + cost > total) return false
      used += cost
      return true
    },
    spent(): number {
      return used
    },
    remaining(): number {
      return Math.max(0, total - used)
    },
  }
}
