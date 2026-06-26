import type { Env } from "@/src/shared/types/env"

export interface AdmitResult {
  granted: boolean
  retryAfterMs: number
}

export interface AdmitArgs {
  env: Env
  tenantId: string
  leaseId: string
  cap: number
}

function tenantStub(env: Env, tenantId: string): DurableObjectStub {
  return env.TENANT_CONCURRENCY.get(env.TENANT_CONCURRENCY.idFromName(`tenant:${tenantId}`))
}

/** Acquire a per-tenant slot. FAILS OPEN — any error grants, so fairness never blocks a review. */
export async function admitTenant(args: AdmitArgs): Promise<AdmitResult> {
  try {
    const res = await tenantStub(args.env, args.tenantId).fetch("https://do.internal/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: args.leaseId, cap: args.cap }),
    })
    if (!res.ok) return { granted: true, retryAfterMs: 0 }
    const body = (await res.json()) as { granted?: unknown; retryAfterMs?: unknown }
    return {
      granted: body.granted !== false, // default-grant on a malformed body
      retryAfterMs: typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0,
    }
  } catch {
    return { granted: true, retryAfterMs: 0 }
  }
}

/** Release a slot. Best-effort — the DO's TTL reaper reclaims a leak if this never lands. */
export async function releaseTenant(env: Env, tenantId: string, leaseId: string): Promise<void> {
  try {
    await tenantStub(env, tenantId).fetch("https://do.internal/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    })
  } catch {
    // swallow — TTL reaper is the safety net
  }
}
