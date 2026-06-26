// SIG-543 PR D Task 5 — GET /metrics/tenant-usage: token-authenticated
// per-tenant usage rollup from D1 (shadow quotas + metrics).
//
// Auth mirrors /metrics/fp-rate (same OPENCLAW_VALIDATION_METRICS_TOKEN bearer
// contract). Reading is done via readUsageRollupSince — fail-open by design;
// if the D1 binding is absent the response is 200 + empty tenants array (dark =
// legitimately empty). A D1 fault (ok:false) returns 503 usage_read_unavailable,
// distinguishable from a genuine-empty response.
//
// Window parameter (`?window=<days>`) matches fp-rate's name and uses the same
// DEFAULT_WINDOW_DAYS / MAX_WINDOW_DAYS constants. Out-of-range values are
// clamped rather than rejected: >max → max, invalid/absent → default.
//
// Optional `?installationId=<n>` narrows the rollup to a single tenant.
// Present but non-positive-integer → 400.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { readUsageRollupSince } from "@/src/features/tenancy"

const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 90

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export async function handleTenantUsageMetricsRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) return json({ error: "metrics_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  const params = new URL(request.url).searchParams

  // Window: parse ?window= (same param name as fp-rate); clamp to [1, MAX],
  // fall back to DEFAULT on absent / invalid / out-of-range below 1.
  const windowRaw = params.get("window")
  let windowDays = DEFAULT_WINDOW_DAYS
  if (windowRaw !== null) {
    const m = /^(\d+)d?$/.exec(windowRaw.trim())
    const n = m ? Number(m[1]) : NaN
    if (Number.isInteger(n) && n >= 1) {
      windowDays = Math.min(n, MAX_WINDOW_DAYS)
    }
    // invalid, non-integer, or < 1 → keep DEFAULT_WINDOW_DAYS
  }

  // Optional installationId filter: must be a positive integer when present.
  let installationId: number | undefined
  const idRaw = params.get("installationId")
  if (idRaw !== null) {
    // Strict digits only (mirrors the window parse) — reject "0x10"/"1e3"/" 5 "
    // which Number() would otherwise coerce to a valid id.
    const n = /^\d+$/.test(idRaw) ? Number(idRaw) : NaN
    if (!Number.isInteger(n) || n <= 0) {
      return json({ error: "invalid_installation_id" }, 400)
    }
    installationId = n
  }

  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const r = await readUsageRollupSince(env, sinceIso, installationId)
  if (!r.ok) return json({ error: "usage_read_unavailable" }, 503)
  return json({ window_days: windowDays, tenants: r.tenants }, 200)
}
