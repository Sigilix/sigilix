// SIG-347 (AC #4 of epic SIG-166): GET /metrics/test-suppressions.
//
// A focused, authenticated projection of the tests gate's per-reason
// suppression counters out of the shared ValidationMetricsDO (SIG-119).
// `/metrics/validation` already records gate × reason × {wouldDrop, kept}
// for every validator; this endpoint slices out the tests gate and surfaces
// a per-drop-reason suppression rate so the epic's precision tuning is
// measurable post-deploy without scraping Worker logs.
//
// Drop reasons reported (see `TestDropReason` in validate-test-finding.ts):
//   glue-covered-by-helper, glue-covered-by-structure,
//   cross-referenced-in-sibling-test (SIG-347), vague-insufficient-test,
//   unresolved-sibling-mapping, uncited-missing-coverage, missing-path.
//
// No new storage — reuses the global ValidationMetricsDO and the same
// bearer token as the other /metrics/* reads.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryValidationMetrics } from "./validation-metrics-client"
import { parseTestsValidatorMode } from "./validate-test-finding"

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
 * Returns null on a malformed/out-of-range value (caller → 400). Mirrors
 * `/metrics/validation` so the window semantics match across endpoints.
 */
function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

/** Suppression rate = wouldDrop / (wouldDrop + kept); 0 when nothing seen. */
function suppressionRate(wouldDrop: number, kept: number): number {
  const total = wouldDrop + kept
  return total === 0 ? 0 : Number((wouldDrop / total).toFixed(4))
}

interface SuppressionCount {
  wouldDrop: number
  kept: number
  suppressionRate: number
}

function project(
  counts: Record<string, { wouldDrop: number; kept: number }>,
): { entries: Record<string, SuppressionCount>; totalWouldDrop: number; totalKept: number } {
  const entries: Record<string, SuppressionCount> = {}
  let totalWouldDrop = 0
  let totalKept = 0
  for (const [key, c] of Object.entries(counts)) {
    entries[key] = { wouldDrop: c.wouldDrop, kept: c.kept, suppressionRate: suppressionRate(c.wouldDrop, c.kept) }
    totalWouldDrop += c.wouldDrop
    totalKept += c.kept
  }
  return { entries, totalWouldDrop, totalKept }
}

export async function handleTestSuppressionsMetricsRoute(
  request: Request,
  env: Env,
): Promise<Response> {
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
  const byReason = project(metrics.counts.tests ?? {})
  const byCategory = project(metrics.byCategory.tests ?? {})

  return json(
    {
      window: metrics.window,
      mode: parseTestsValidatorMode(env.OPENCLAW_TESTS_VALIDATOR_MODE),
      reasons: byReason.entries,
      byCategory: byCategory.entries,
      totals: {
        wouldDrop: byReason.totalWouldDrop,
        kept: byReason.totalKept,
        suppressionRate: suppressionRate(byReason.totalWouldDrop, byReason.totalKept),
      },
    },
    200,
  )
}
