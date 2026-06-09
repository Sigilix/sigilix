// SIG-173: GET /metrics/dismissals — authenticated read of the rolling
// per-reason dismissal rollup. Mirrors `/metrics/validation`'s auth + window
// contract so the dogwatch curls both endpoints with the same token.
//
// Response shape:
//   {
//     window: { days: number, startDay: string, endDay: string },
//     reasonCounts: {
//       "not-a-bug": N, "bad-anchor": N, "already-covered": N,
//       "too-minor": N, "wrong-context": N, "unlabeled": N
//     }
//   }
//
// Each canonical `DismissReason` is always present (defaults to 0 in the DO
// query layer) so the consumer can iterate the full set without null
// handling.

import type { Env } from "../shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryDismissalMetrics } from "./validation-metrics-client"

// Cap mirrors SIG-173 spec; default mirrors /metrics/validation (7 days).
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

export async function handleDismissalMetricsRoute(request: Request, env: Env): Promise<Response> {
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

  const metrics = await queryDismissalMetrics(env, windowDays)

  return json(
    {
      window: metrics.window,
      reasonCounts: metrics.reasonCounts,
    },
    200,
  )
}
