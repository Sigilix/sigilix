// SIG-543 (PR D, Task 1) — pure quota knobs (domain layer).
//
// Two pure, side-effect-free utilities the tenant quota layer needs:
//   1. resolveQuotaMode — env-flag → "off" | "shadow" | "enforce".
//   2. computeWouldExceed — pure predicate for budget-ceiling checks.
//
// Domain-layer contract: NO env reads, NO I/O, NO clock calls, NO network.
// All non-deterministic inputs (env) are injected by the caller.
// The only import is the `Env` type (type-only; zero runtime cost).

import type { Env } from "@/src/shared/types/env"

// ─── QuotaMode ───────────────────────────────────────────────────────────────

export type QuotaMode = "off" | "shadow" | "enforce"

// ─── resolveQuotaMode ────────────────────────────────────────────────────────

/**
 * Resolve the tenant quota feature-flag from the Worker env.
 *
 * Three-state rollout:
 *   - `"enforce"` — reviews are rejected when a tenant exceeds their daily budget.
 *   - `"off"`     — quota logic fully bypassed.
 *   - `"shadow"`  — (default) quota state is tracked and telemetered; no blocking.
 *
 * Absent, unknown, or mis-cased values all resolve to `"shadow"` (the safe,
 * observable default — mirrors the same if/if/return structure as
 * `resolveCooldownMode` in `@/src/lib/ensemble/domain/backpressure.ts` but
 * with `"shadow"` as the fallthrough instead of `"off"`).
 */
export function resolveQuotaMode(env: Pick<Env, "SIGILIX_TENANT_QUOTA_MODE">): QuotaMode {
  const v = env.SIGILIX_TENANT_QUOTA_MODE?.trim().toLowerCase()
  if (v === "enforce") return "enforce"
  if (v === "off") return "off"
  return "shadow"
}

// ─── computeWouldExceed ──────────────────────────────────────────────────────

/**
 * Return `true` when the tenant has exceeded their daily budget.
 *
 * Budget unit: **model_calls per rolling 24 h** (the shadow log also carries
 * `tokens` and `reviews` so the unit can change later without a schema break).
 *
 * Rules:
 *   - Returns `false` when `budget` is `null`, `undefined`, `≤ 0`, or non-finite
 *     (treat "no budget set" or "unlimited" as never exceeded).
 *   - Returns `false` when `used` is non-finite (e.g. `NaN`).
 *   - Returns `true` only when `budget` is a finite number `> 0` AND `used > budget`.
 */
export function computeWouldExceed(used: number, budget: number | null | undefined): boolean {
  if (budget == null || !Number.isFinite(budget) || budget <= 0) return false
  if (!Number.isFinite(used)) return false
  return used > budget
}
