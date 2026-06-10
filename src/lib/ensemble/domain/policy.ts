// SIG-318 (PR 7) — the ensemble fan-out POLICY domain (domain layer).
//
// PURE policy decisions for the specialist fan-out: the min-specialists
// early-exit mode + gate action, and the degraded-coverage split. No env /
// network / storage. Per the dependency rule the only outward import is
// `../../ensemble-router` for the specialist-role vocabulary (SpecialistRole /
// ALL_SPECIALISTS) — never the orchestrator god-file.
//
// Moved verbatim from triage-pr-review-ensemble.ts and re-exported there, so
// existing importers (tests) are unaffected.

import { ALL_SPECIALISTS, type SpecialistRole } from "@/shared/domain/specialist-role"
import type { CollectedVerdict } from "./validation"

/**
 * SIG-235 quorum check. Decides whether the synth may run given the specialist
 * verdicts that succeeded. PURE — moved verbatim from the orchestrator god-file
 * (SIG-318 PR 12h); the policy domain is its natural home alongside the other
 * fan-out decisions. Re-exported through the `triage-pr-review-ensemble` shim so
 * existing importers (the orchestrator + tests) are unaffected.
 */
export function checkQuorum(
  succeeded: CollectedVerdict[],
  mode: "shadow" | "post",
  dispatchedSpecialists?: SpecialistRole[],
): boolean {
  // Arc PR #35 catch: when the router dispatches fewer than 4
  // specialists (e.g., CSS-only → ["performance"]), the original
  // `succeeded.length < 2` rule always failed because there were
  // never 2 to begin with. Make quorum proportional to what the
  // router actually requested.
  //
  // Rule:
  //   - Need min(2, dispatched.length) successes (so single-dispatch
  //     PRs need just that 1 to succeed; multi-dispatch needs ≥2).
  //   - In post mode, ALSO require ≥1 of {logic, security} to have
  //     succeeded — but only if the router actually dispatched them.
  //     If the router intentionally excluded both (rare; would only
  //     happen for CSS-only → ["performance"] type cases), the post-
  //     mode check is effectively just the count requirement.
  const dispatched = dispatchedSpecialists ?? [...ALL_SPECIALISTS]
  const dispatchedSet = new Set(dispatched)
  const minSuccesses = Math.min(2, dispatched.length)
  if (succeeded.length < minSuccesses) return false
  if (mode === "shadow") return true
  // post mode: enforce logic/security only if router dispatched them
  const dispatchedLogicOrSec = dispatchedSet.has("logic") || dispatchedSet.has("security")
  if (!dispatchedLogicOrSec) return true
  return succeeded.some((v) => v.role === "logic" || v.role === "security")
}

/**
 * SIG-235 — min-specialists early exit mode parser. Returns one of:
 *   - "off"    (default): fan-out waits for ALL specialists to settle
 *   - "shadow"           : fan-out waits for all, BUT logs would-fire
 *   - "on"               : fires synth as soon as N-1 of N succeed,
 *                          cancels the laggard's outstanding ladder
 *
 * Case-insensitive, whitespace-tolerant. Unknown / unset values default
 * to "off" so a misconfigured env never silently changes fan-out semantics.
 *
 * Extracted as a pure helper so unit tests can pin the parser without
 * spinning up the orchestrator.
 */
export type MinSpecialistsEarlyExitMode = "off" | "shadow" | "on"

export function parseMinSpecialistsEarlyExitMode(
  raw: string | undefined,
): MinSpecialistsEarlyExitMode {
  const v = (raw ?? "").trim().toLowerCase()
  if (v === "shadow") return "shadow"
  if (v === "on") return "on"
  return "off"
}

/** What the fan-out loop should do at a given settle point (SIG-235 + SIG-236). */
export type EarlyExitAction = "none" | "suppress-protected" | "cancel" | "shadow-mark"

/**
 * Pure decision for the min-specialists early-exit gate. Extracted so the
 * SIG-236 protected-role guard is unit-testable without the orchestrator.
 *   none               — quorum not met (or nothing pending) → keep awaiting
 *   cancel             — "on" + no protected role pending → cancel the laggards
 *   suppress-protected — "on" + logic still pending → do NOT cancel (SIG-236):
 *                        logic is the intentional long-pole; its 110s per-attempt
 *                        cap bounds it, not early-exit. Without this, flipping
 *                        early-exit to "on" would silently re-drop logic.
 *   shadow-mark        — "shadow" → record the would-fire, keep awaiting
 */
export function decideEarlyExitAction(args: {
  mode: MinSpecialistsEarlyExitMode
  succeededCount: number
  quorumThreshold: number
  pendingCount: number
  logicProtectedPending: boolean
}): EarlyExitAction {
  if (args.succeededCount < args.quorumThreshold || args.pendingCount === 0) return "none"
  if (args.mode === "on") return args.logicProtectedPending ? "suppress-protected" : "cancel"
  if (args.mode === "shadow") return "shadow-mark"
  return "none" // "off"
}

/**
 * ARC-277: pure helper. Given the roles the router DISPATCHED and the
 * roles that actually RETURNED a verdict, compute the symmetric pair
 * the synth prompt block needs. Stable ordering follows
 * `ALL_SPECIALISTS` (logic, security, performance, tests) so two PRs
 * with the same coverage gap produce identical prompt text — easier
 * to grep telemetry by exact prompt-shape hash.
 */
export function computeDegradedCoverage(
  dispatched: readonly SpecialistRole[],
  returned: readonly SpecialistRole[],
): { rolesReturned: SpecialistRole[]; rolesMissing: SpecialistRole[] } {
  const returnedSet = new Set(returned)
  const stable = ALL_SPECIALISTS.filter((r) => dispatched.includes(r))
  return {
    rolesReturned: stable.filter((r) => returnedSet.has(r)),
    rolesMissing: stable.filter((r) => !returnedSet.has(r)),
  }
}
