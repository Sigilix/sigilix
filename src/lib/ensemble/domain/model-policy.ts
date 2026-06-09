// SIG-362 (PR 10) — the pure model retry/lineup-policy knobs (domain layer).
//
// The retry/fallback shape (`ModelConfig`), the backoff schedule, and the
// worst-case-attempt arithmetic the model adapter consults. No env / network /
// provider knowledge: the actual lineups (SPECIALIST_CONFIGS et al.) and the
// HTTP error taxonomy live in the model-provider adapter. The only outward
// import would be the specialist-role leaf (consumed by the adapter's lineups,
// not by these pure knobs — so this module needs no imports at all).

export interface ModelConfig {
  primary: string
  /** Number of retry attempts on the primary BEFORE falling back. 0 = no retry. */
  retries: number
  /** Cross-provider fallback model. null = fail without fallback. */
  fallback: string | null
  /**
   * SIG-236: per-role override for the per-attempt timeout. Omitted → the
   * runner defaults to the global PER_ATTEMPT_TIMEOUT_MS (no behavior change).
   * Logic and tests set this higher when their role-specific prompt/evidence
   * shape needs >60s, so the global cap does not abort the primary mid-review.
   */
  perAttemptTimeoutMs?: number
}

/** Backoff schedule (ms) for retry attempts. 800ms, 2.5s — short
 *  enough to fit within specialist timeout budget (90s), long enough
 *  to ride through most transient 503s. */
export const RETRY_BACKOFF_MS = [800, 2500]

/**
 * Max model invocations one ensemble run can possibly consume.
 * Derived from SPECIALIST_CONFIGS + SYNTHESIZER_CONFIG (CR PR #37
 * catch: hard-coded 5 was wrong because retries + fallbacks can push
 * a single run to ~16 calls).
 *
 * Per role: (1 primary attempt) + (config.retries) + (1 fallback if set)
 * Sum across all 4 specialists + synth.
 *
 * Used at admission time to reserve worst-case budget so we don't
 * admit a PR we might overflow. Actual spend at finalize() comes
 * from each role's `attemptsUsed`, not from this constant.
 */
export function maxAttempts(config: ModelConfig): number {
  return 1 + config.retries + (config.fallback ? 1 : 0)
}
