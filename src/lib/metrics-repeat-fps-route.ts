// SIG-217: GET /metrics/repeat-fps — authenticated read of the rolling
// repeat-false-positive rollup. Mirrors `/metrics/dismissals`' auth + window
// contract so the dogwatch curls all metrics endpoints with the same token.
//
// Response shape:
//   {
//     window: { days: number, startDay: string, endDay: string },
//     byReason: {
//       "repeat-fp-detected": N,
//       "severity-escalation-attempt": N,
//       "dismiss-decay-window-expired": N
//     },
//     bySpecialist: { "logic": N, "security": N, ... }
//   }
//
// Every `RepeatFpEventKind` is always present in `byReason` (defaults to 0 in
// the DO query layer); `bySpecialist` lists only specialists seen in-window.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryRepeatFpMetrics } from "./validation-metrics-client"

// Mirrors /metrics/dismissals: default 7-day window, 30-day cap.
const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Parse `?window=Nd` (or bare `N`) → days in [1, MAX_WINDOW_DAYS].
 * Returns null on a malformed/out-of-range value (caller → 400).
 */
function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

export async function handleRepeatFpsMetricsRoute(request: Request, env: Env): Promise<Response> {
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

  const metrics = await queryRepeatFpMetrics(env, windowDays)

  return json(
    {
      window: metrics.window,
      byReason: metrics.byReason,
      bySpecialist: metrics.bySpecialist,
    },
    200,
  )
}
