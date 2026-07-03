// sig-training-data-consent — resolve an installation's plan for the DEFAULT
// consent resolver. Reads `tenant.tier` (D1, migration 0001) — the per-org plan
// signal, upserted by the PR webhook. THROWS on a D1 error (fail-closed: the
// gate maps a throw to "denied"); returns null when the tenant row is simply
// absent (→ the plan-default resolver denies an unknown plan anyway).

import type { Env } from "@/src/shared/types/env"

/**
 * The org's plan/tier string, or null when there is no tenant row yet. THROWS on
 * a missing binding or a genuine D1 fault so resolveConsent() fails closed.
 */
export async function readPlanForInstallation(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<string | null> {
  if (!env.SIGILIX_PLATFORM_DB) {
    throw new Error("plan lookup: SIGILIX_PLATFORM_DB binding absent")
  }
  if (!Number.isInteger(installationId) || installationId <= 0) return null
  const row = await env.SIGILIX_PLATFORM_DB.prepare("SELECT tier FROM tenant WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tier: unknown }>()
  if (row == null) return null
  return typeof row.tier === "string" ? row.tier : null
}
