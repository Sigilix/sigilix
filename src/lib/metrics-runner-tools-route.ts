// SIG-107: GET /metrics/runner-tools — authenticated read of accepted runner
// scan-manifest telemetry, aggregated by deterministic tool and output status.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryRunnerToolMetrics } from "./runner-tool-metrics-client"

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

export async function handleRunnerToolsMetricsRoute(request: Request, env: Env): Promise<Response> {
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

  return json(await queryRunnerToolMetrics(env, windowDays), 200)
}
