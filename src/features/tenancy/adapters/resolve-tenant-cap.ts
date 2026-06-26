// SIG-343 PR C Task 6 — per-tenant cap resolver.
//
// Reads the operator-set concurrency cap from D1 first; falls back to the
// env-level cap from resolveFairnessConfig when the tenant row is absent,
// the binding is missing, or D1 is degraded.  Never throws (readTenantCap
// is fail-open; resolveFairnessConfig is pure).

import type { Env } from "@/src/shared/types/env"
import { readTenantCap } from "@/src/features/tenancy/adapters/d1-tenant-store"
import { resolveFairnessConfig } from "@/src/features/tenancy/domain/config"

/**
 * Resolve the effective per-tenant concurrency cap for admission.
 *
 * Priority:
 *   1. D1 `tenant.concurrency_cap` — operator-set per-tenant override.
 *   2. `resolveFairnessConfig(env).cap` — env/default fallback.
 *
 * FAILS OPEN — never throws; a D1 fault returns the env cap.
 */
export async function resolveTenantCap(env: Env, installationId: number): Promise<number> {
  const d1Cap = await readTenantCap(env, installationId)
  return d1Cap ?? resolveFairnessConfig(env).cap
}
