// SIG-119: GET /metrics/validation — authenticated read of the rolling
// validator shadow-telemetry counters. Lets the rollout dogwatch curl the
// would-drop rates per gate × reason without Cloudflare Worker log access.

import type { Env } from "../index"
import { requireBearerToken } from "./auth-bearer"
import { queryValidationMetrics } from "./validation-metrics-client"
import { parseSecurityValidatorMode } from "./validate-security-finding"
import { parseTestsValidatorMode } from "./validate-test-finding"
import { parseLogicValidatorMode } from "./validate-logic-finding"
import { parsePerfValidatorMode } from "./validate-perf-finding"

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

export async function handleValidationMetricsRoute(request: Request, env: Env): Promise<Response> {
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

  const metrics = await queryValidationMetrics(env, windowDays)

  return json(
    {
      window: metrics.window,
      modes: {
        security: parseSecurityValidatorMode(env.OPENCLAW_SECURITY_VALIDATOR_MODE),
        tests: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
        logic: parseLogicValidatorMode(env.OPENCLAW_LOGIC_VALIDATOR_MODE),
        perf: parsePerfValidatorMode(env.OPENCLAW_PERF_VALIDATOR_MODE),
      },
      counts: metrics.counts,
      lastSeenPrHeads: metrics.lastSeenPrHeads,
    },
    200,
  )
}
