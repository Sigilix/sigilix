// SIG-286 PR3: GET /metrics/graph-expansion-ab — the per-arm read of the
// targeted-inject A/B (PR2). For each review in `OPENCLAW_GRAPH_EXPANSION=post`
// that WOULD inject, PR2 tags `telemetry.graphExpansionAb.arm` (treatment =
// got the cross-file inject, control = didn't) on the ensemble-review-telemetry
// record alongside `synthesizer.verdict`. This groups those records by arm and
// compares the finding rate, answering the load-bearing SIG-286 question: does
// the targeted inject make the model surface MORE findings? Shares the
// OPENCLAW_VALIDATION_METRICS_TOKEN bearer (same as the other /metrics/*).
//
// HONEST CAVEAT (surfaced in the response): this compares finding COUNT, the
// recall proxy. "More findings" is only good if they're REAL — a future pass
// can cross-join the dismissal corpus to net out FPs per arm.

import type { Env } from "../index"
import { requireBearerToken } from "./auth-bearer"
import { listKeys, mapWithConcurrency, FETCH_CONCURRENCY } from "./kv-scan"
import { createdMsFromKey } from "./fp-rate/ingest"
import { graphExpansionMode } from "./graph-expansion-mode"

const TELEMETRY_PREFIX = "ensemble-review-telemetry:"
// Mirror the fp-rate ruler: list deep (cheap) so a single repo isn't sampled
// out of the multi-repo keyspace; fetch a bounded set of matched keys.
const TELEMETRY_LIST_SCAN = 10_000
const MAX_TELEMETRY_FETCH = 700
const HIGH_SEV_GATE = 4

const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 90
const DAY_MS = 86_400_000
/** Per-arm review count below which the verdict stays "accruing" (no power). */
const MIN_PER_ARM = 30

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function parseWindowDays(raw: string | null): number | null {
  if (raw === null) return DEFAULT_WINDOW_DAYS
  const m = /^(\d+)d?$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 1 || n > MAX_WINDOW_DAYS) return null
  return n
}

interface ArmAgg {
  reviews: number
  totalFindings: number
  highSevFindings: number
}

function emptyArm(): ArmAgg {
  return { reviews: 0, totalFindings: 0, highSevFindings: 0 }
}

/** Extract the A/B arm + synth finding counts from a raw telemetry record. */
function readArmSample(raw: unknown): { arm: "treatment" | "control"; total: number; highSev: number } | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, any>
  const arm = r.graphExpansionAb?.arm
  if (arm !== "treatment" && arm !== "control") return null
  const findings = r.synthesizer?.verdict?.findings
  if (!Array.isArray(findings)) return { arm, total: 0, highSev: 0 }
  let highSev = 0
  for (const f of findings) {
    if (Number(f?.score) >= HIGH_SEV_GATE) highSev += 1
  }
  return { arm, total: findings.length, highSev }
}

function withRates(a: ArmAgg) {
  return {
    ...a,
    meanFindings: a.reviews > 0 ? a.totalFindings / a.reviews : null,
    meanHighSev: a.reviews > 0 ? a.highSevFindings / a.reviews : null,
  }
}

export async function handleGraphExpansionAbMetricsRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_VALIDATION_METRICS_TOKEN
  if (!token) return json({ error: "metrics_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  const params = new URL(request.url).searchParams
  // Accept one or several owner/repo slugs (rename aliases of the SAME repo),
  // same contract as /metrics/fp-rate.
  const repos = [
    ...new Set(
      params
        .getAll("repo")
        .flatMap((r) => r.split(","))
        .map((r) => r.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  if (repos.length === 0 || repos.some((r) => !/^[^/\s]+\/[^/\s]+$/.test(r))) {
    return json({ error: "invalid_repo", detail: "?repo=owner/repo is required (repeatable / comma-separated for rename aliases)" }, 400)
  }
  const windowDays = parseWindowDays(params.get("window"))
  if (windowDays === null) return json({ error: "invalid_window", detail: `window must be 1-${MAX_WINDOW_DAYS} days` }, 400)

  const listed = await listKeys(env, TELEMETRY_PREFIX, TELEMETRY_LIST_SCAN)
  const matched = listed.filter((k) => {
    const lk = k.toLowerCase()
    return repos.some((r) => lk.includes(`:${r}#`))
  })
  const scanCapped = listed.length >= TELEMETRY_LIST_SCAN || matched.length > MAX_TELEMETRY_FETCH
  const keys = matched.slice(0, MAX_TELEMETRY_FETCH)

  const nowMs = Date.now()
  const windowStartMs = nowMs - windowDays * DAY_MS
  let failedFetches = 0

  const samples = (
    await mapWithConcurrency(keys, FETCH_CONCURRENCY, async (key) => {
      const createdMs = createdMsFromKey(key, TELEMETRY_PREFIX)
      if (createdMs === null || createdMs < windowStartMs) return null
      const raw = await env.OPENCLAW_STATE.get(key, "json").catch(() => {
        failedFetches += 1
        return null
      })
      return readArmSample(raw)
    })
  ).filter((s): s is NonNullable<typeof s> => s !== null)

  const treatment = emptyArm()
  const control = emptyArm()
  for (const s of samples) {
    const arm = s.arm === "treatment" ? treatment : control
    arm.reviews += 1
    arm.totalFindings += s.total
    arm.highSevFindings += s.highSev
  }

  if (failedFetches > 0) {
    console.error(JSON.stringify({ event: "graph-expansion-ab-lossy-read", repos, failedFetches }))
  }

  const t = withRates(treatment)
  const c = withRates(control)
  const haveData = treatment.reviews >= MIN_PER_ARM && control.reviews >= MIN_PER_ARM
  const deltaMeanHighSev =
    t.meanHighSev !== null && c.meanHighSev !== null ? t.meanHighSev - c.meanHighSev : null

  return json(
    {
      mode: graphExpansionMode(env),
      window: { days: windowDays },
      repos,
      // Per-arm finding rates (treatment got the cross-file inject; control did not).
      treatment: t,
      control: c,
      // High-sev (score>=4) mean delta: >0 means the inject surfaces MORE
      // findings. Recall proxy only — NOT yet FP-adjusted (see header caveat).
      deltaMeanHighSev,
      minPerArm: MIN_PER_ARM,
      // Deliberately NOT a go/ship signal — a positive delta could be extra FPs.
      // The value names the observation, not a recommendation (code-reviewer #281).
      verdict: !haveData
        ? "accruing"
        : deltaMeanHighSev !== null && deltaMeanHighSev > 0
          ? "treatment-more-findings-unverified"
          : "no-lift",
      note: "finding-COUNT comparison (recall proxy); a positive delta needs an FP cross-check before defaulting the inject on",
      scanCapped,
      failedFetches,
    },
    200,
  )
}
