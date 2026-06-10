// SIG-184 PR 5b: GET /metrics/runner-evidence — authenticated read of the
// rolling runner-evidence presence counters (state × evidence-pending reason,
// + the per-repo latest-state roll). Lets the rollout dogwatch curl adoption +
// the why-pending breakdown without Cloudflare Worker log access. Guarded by
// the shared OPENCLAW_VALIDATION_METRICS_TOKEN (same as /metrics/validation,
// /metrics/graph), and reports the current OPENCLAW_RUNNER_EVIDENCE_MODE so the
// reader knows whether the numbers reflect shadow or post.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { queryRunnerEvidenceMetrics } from "./runner-evidence-metrics-client"
import { readRunnerEvidenceMode } from "./runner-evidence/lookup"

const DEFAULT_WINDOW_DAYS = 7
const MAX_WINDOW_DAYS = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Parse `?window=Nd` (or bare `N`) → days in [1, MAX_WINDOW_DAYS]. null = bad. */
function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

export async function handleRunnerEvidenceMetricsRoute(request: Request, env: Env): Promise<Response> {
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

  const metrics = await queryRunnerEvidenceMetrics(env, windowDays)

  return json(
    {
      window: metrics.window,
      mode: readRunnerEvidenceMode(env),
      counts: metrics.counts,
      repoPresence: metrics.repoPresence,
    },
    200,
  )
}
