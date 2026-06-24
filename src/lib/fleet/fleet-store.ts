// SIG-507 — fleet aggregate KV store. Reuses the existing `OPENCLAW_STATE` namespace (no new
// binding); key `fleet:agg:<signature>` → FleetAggregate JSON.
//
// Read-modify-write per contribution. KV is NOT transactional, so a concurrent contribution can be
// lost — dropping a tenant from the distinct count AND any occurrences/reproduced/verified/maxSeverity
// it carried. This is monotone-safe in the surfacing direction: every fold is strictly additive
// (bit-OR / +1 / Math.max), so a lost update can only UNDER-report (delay a pattern reaching K, or
// briefly under-state proof counts) — never inflate a below-K pattern into surfacing. A future D1
// migration owns atomicity + retention (mirrors the agent-memory KV→D1 plan).
//
// Soft contract (mirrors agent-memory/storage.ts): reads validate-after-parse and return null on a
// KV throw / corrupt JSON / shape mismatch; writes report success via a boolean and never throw.

import type { Env } from "@/src/shared/types/env"
import { type FleetAggregate, emptyAggregate, updateAggregate } from "@/src/shared/domain/fleet-aggregate"
import { type FleetPattern } from "@/src/shared/domain/fleet-pattern"
import { isValidCounter } from "@/src/shared/domain/distinct-counter"

// Overridden by env.OPENCLAW_FLEET_SALT. The bitmap stores no identity regardless, so this is
// defense-in-depth (makes tenant→bit non-trivial to reconstruct across deployments), not the
// primary privacy mechanism.
const DEFAULT_SALT = "sigilix-fleet-v1"

const keyFor = (signature: string): string => `fleet:agg:${signature}`

function isAggregate(v: unknown): v is FleetAggregate {
  if (typeof v !== "object" || v === null) return false
  const a = v as Record<string, unknown>
  return (
    typeof a.signature === "string" &&
    isValidCounter(a.tenants) && // full geometry check — the trust boundary against corrupt KV JSON
    typeof a.occurrences === "number" &&
    typeof a.reproduced === "number" &&
    typeof a.verified === "number" &&
    typeof a.maxSeverity === "number"
  )
}

/** Read the aggregate for a signature, or null (absent / corrupt / KV failure — never throws). */
export async function readAggregate(env: Env, signature: string): Promise<FleetAggregate | null> {
  try {
    const raw = await env.OPENCLAW_STATE.get(keyFor(signature))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isAggregate(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Fold one tenant's contribution of `pattern` into its signature's aggregate (read-modify-write).
 * The tenant id is only hashed into the distinct counter, never stored. Returns true on a durable
 * write, false on any KV failure (the contribution is simply dropped — recall-safe). The caller is
 * responsible for the contribution POLICY (skip enterprise / opted-out tenants) before calling.
 */
export async function recordContribution(env: Env, pattern: FleetPattern, tenantId: string): Promise<boolean> {
  try {
    const salt = env.OPENCLAW_FLEET_SALT || DEFAULT_SALT
    const current = (await readAggregate(env, pattern.signature)) ?? emptyAggregate(pattern.signature)
    const next = updateAggregate(current, pattern, tenantId, salt)
    await env.OPENCLAW_STATE.put(keyFor(pattern.signature), JSON.stringify(next))
    return true
  } catch {
    return false
  }
}
