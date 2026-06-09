// SIG-286 PR2.5: GET /metrics/graph-expansion — authenticated read of the
// rolling `graph-expansion-shadow` measurement (the CONTROL-vs-TREATMENT
// cross-file context numbers). Answers the load-bearing PR3 (inject) question —
// is the median netNewTokens high enough to be worth injecting — WITHOUT
// Cloudflare log access. Reuses the shared OPENCLAW_VALIDATION_METRICS_TOKEN
// bearer (same as the other /metrics/* endpoints).

import type { Env } from "../shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryGraphExpansionMetrics } from "./graph-expansion-metrics-client"
import { graphExpansionMode } from "./graph-expansion-mode"

const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

export async function handleGraphExpansionMetricsRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) {
    return json({ error: "metrics_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const windowDays = parseWindowDays(new URL(request.url).searchParams.get("window"))
  if (windowDays === null) {
    return json({ error: "invalid_window", detail: `window must be 1-${MAX_WINDOW_DAYS} days` }, 400)
  }

  const metrics = await queryGraphExpansionMetrics(env, windowDays)
  // Surface the current expansion mode so the reader knows whether the numbers
  // are accruing (shadow|post) or stale (off).
  return json({ mode: graphExpansionMode(env), ...metrics }, 200)
}
