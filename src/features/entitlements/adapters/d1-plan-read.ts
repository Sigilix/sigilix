// sig-free-tier-entitlements — resolve an installation's plan for the gate.
// Reads `tenant.tier` (D1, migration 0001) — the per-installation plan signal
// upserted by the PR webhook. This is the ONLY input that maps a worker surface
// (CI-triage, Slack, Linear) to its plan, keyed strictly by that surface's own
// installation id → tenant isolation is structural: a lookup can only ever read
// the row for the installation it was handed.
//
// FAIL-CLOSED: THROWS on a missing binding or a genuine D1 fault so the gate maps
// the throw to "unknown plan" → not entitled. Returns null when the tenant row is
// simply absent (a brand-new / unmetered install) — an unknown plan the gate also
// treats as not entitled. Either way the safe answer is "not entitled".

import type { Env } from "@/src/shared/types/env"

/**
 * The installation's plan/tier string, or null when there is no tenant row yet.
 * THROWS on a missing binding or a real D1 fault so the caller fails closed.
 * Returns null (never throws) for a non-positive / non-integer installation id —
 * that is a caller bug, and the gate denies an unknown plan anyway.
 */
export async function readInstallationPlan(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<string | null> {
  if (!env.SIGILIX_PLATFORM_DB) {
    throw new Error("entitlements plan lookup: SIGILIX_PLATFORM_DB binding absent")
  }
  if (!Number.isInteger(installationId) || installationId <= 0) return null
  const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT tier FROM tenant WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tier: unknown }>()
  if (row == null) return null
  return typeof row.tier === "string" ? row.tier : null
}
