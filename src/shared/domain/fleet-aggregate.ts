// SIG-507 — the cross-tenant fleet aggregate for ONE pattern signature. Holds only aggregate stats
// + a distinct-tenant counter (no identity). `updateAggregate` folds in a contribution;
// `isEligible` gates surfacing on k-anonymity (K=5); `renderFleetInsight` produces the count-only
// attribution shown to the agent. Pure leaf: imports the distinct-counter + fleet-pattern leaves.

import { type DistinctCounter, createCounter, addToCounter, estimateCount } from "./distinct-counter"
import { type FleetPattern } from "./fleet-pattern"

/** k-anonymity threshold (founder-approved 2026-06-23): surface only once ≥ K distinct tenants. */
export const FLEET_K = 5

export interface FleetAggregate {
  signature: string
  /** Distinct contributing tenants — a bitmap, never the tenant list. */
  tenants: DistinctCounter
  /** Total contributions of this pattern (occurrences across the fleet). */
  occurrences: number
  /** Contributions proven by sealed execution (REPRODUCED tier). */
  reproduced: number
  /** Contributions whose fix was verified. */
  verified: number
  /** Highest severity seen (1–5). */
  maxSeverity: number
}

export function emptyAggregate(signature: string): FleetAggregate {
  return { signature, tenants: createCounter(), occurrences: 0, reproduced: 0, verified: 0, maxSeverity: 0 }
}

/**
 * Fold one tenant's contribution of `pattern` into the aggregate. The tenant id is only hashed into
 * the distinct counter, never stored. Returns a NEW aggregate. Callers must drop opted-out / enterprise
 * tenants BEFORE calling this (contribution policy lives at the wiring layer, not here).
 */
export function updateAggregate(
  agg: FleetAggregate,
  pattern: FleetPattern,
  tenantId: string,
  salt: string,
): FleetAggregate {
  return {
    signature: agg.signature,
    tenants: addToCounter(agg.tenants, tenantId, salt),
    occurrences: agg.occurrences + 1,
    reproduced: agg.reproduced + (pattern.reproduced ? 1 : 0),
    verified: agg.verified + (pattern.verified ? 1 : 0),
    maxSeverity: Math.max(agg.maxSeverity, pattern.severity),
  }
}

/** Estimated number of distinct codebases this pattern has appeared in. */
export const tenantCount = (agg: FleetAggregate): number => estimateCount(agg.tenants)

/** k-anonymity gate: surface only once ≥ K distinct tenants have contributed. */
export const isEligible = (agg: FleetAggregate): boolean => tenantCount(agg) >= FLEET_K

/**
 * The attribution surfaced to the agent, or null if not yet k-anonymous. COUNT ONLY — never which
 * tenants (the count is ≥ K by construction, so it identifies no single codebase).
 */
export function renderFleetInsight(agg: FleetAggregate): string | null {
  if (!isEligible(agg)) return null
  const n = tenantCount(agg)
  const proof =
    agg.reproduced > 0
      ? ` ${agg.reproduced} were reproduced by execution${agg.verified > 0 ? `, and a verified fix exists in ${agg.verified}` : ""}.`
      : agg.verified > 0
        ? ` A verified fix exists in ${agg.verified} of them.`
        : ""
  return `Fleet signal: the \`${agg.signature}\` pattern has appeared in ~${n} codebases across the Sigilix fleet.${proof} Treat it as a known anti-pattern and prefer the verified idiomatic fix.`
}
