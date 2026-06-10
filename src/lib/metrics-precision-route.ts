// SIG-147: GET /metrics/precision?repo=owner/repo — authenticated read of a
// repo's PrecisionProfile, surfacing the FP-reduction signal (how many
// repeatedly-dismissed patterns are now being suppressed) for the health
// dashboard. Ties to SIG-114 (systemic FP-rate). Mirrors /metrics/dismissals'
// auth contract so the dogwatch curls all metrics endpoints with one token.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import {
  loadPrecisionProfile,
  BOOST_THRESHOLD,
  SUPPRESS_THRESHOLD,
  isCategoryBoosted,
  isPatternSuppressed,
} from "@/src/features/precision-profile"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export async function handlePrecisionMetricsRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) {
    return json({ error: "metrics_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const repo = new URL(request.url).searchParams.get("repo")
  if (!repo) {
    return json({ error: "missing_repo", detail: "?repo=owner/repo is required" }, 400)
  }

  const profile = await loadPrecisionProfile(env, repo)
  if (!profile) {
    return json(
      {
        repo,
        patterns: 0,
        thresholds: { suppress: SUPPRESS_THRESHOLD, boost: BOOST_THRESHOLD },
        fpReduction: { suppressingPatterns: 0 },
        boostedCategories: [],
      },
      200,
    )
  }

  const patternStats = Object.values(profile.patterns)
  // FP-reduction (SIG-114): patterns at/over the suppress threshold are
  // repeatedly-dismissed false positives now being filtered before posting.
  const suppressingPatterns = patternStats.filter((p) => isPatternSuppressed(p)).length
  const boostedCategories = Object.entries(profile.categories)
    .filter(([, stat]) => isCategoryBoosted(stat))
    .map(([category]) => category)

  return json(
    {
      repo,
      updatedTs: profile.updatedTs,
      thresholds: { suppress: SUPPRESS_THRESHOLD, boost: BOOST_THRESHOLD },
      patterns: patternStats.length,
      fpReduction: { suppressingPatterns },
      boostedCategories,
    },
    200,
  )
}
