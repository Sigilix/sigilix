// POST /v1/fleet — surfacing the fleet moat. Given the current review/agent findings (finding
// CATEGORY + free-text HEADLINE only — never code), return anonymized FLEET insights ("this pattern
// has appeared in ~N codebases; a verified fix exists") for the findings whose pattern signature has
// crossed the K=5 k-anonymity gate. Read-ONLY: contributions are written server-side by the review
// pipeline, never through this endpoint. Auth is the shared static bearer ($OPENCLAW_SIGILIX_API_KEY,
// the same agent key /v1/verify + /v1/blast-radius use), checked BEFORE the body read.
//
// Privacy: the headline is mapped to a CLOSED-vocabulary signature by `extractFleetPattern` (which
// emits no identifiers); only the signature touches the store, and the response carries only a count
// + the signature, never a tenant. SOFT-FAIL: any unexpected failure resolves to {insights:[]} at
// 200 — the route never returns a 500. 503 until keyed; 401 bad bearer; 400 bad JSON / no findings;
// 413 oversized body.

import type { Env } from "@/src/shared/types/env"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { extractFleetPattern } from "@/src/shared/domain/fleet-pattern"
import { isEligible, renderFleetInsight } from "@/src/shared/domain/fleet-aggregate"
import { readAggregate } from "@/src/lib/fleet/fleet-store"

// Findings carry short category + headline strings, never source. The actual KV-read fan-out is
// bounded by the `seen`-set dedup below (distinct signatures are capped by the closed vocabulary,
// ~150), not by MAX_FINDINGS — this cap just rejects an absurd body. Envelope byte-cap is enforced
// as the stream is read.
const MAX_BODY_BYTES = 256 * 1024
const MAX_FINDINGS = 100

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface FleetApiFinding {
  category?: string
  headline?: string
  score?: number
}

export interface FleetInsight {
  signature: string
  insight: string
}

/** Parse + validate the body into a bounded findings array, or a tagged failure. */
function parseBody(raw: unknown): { findings: FleetApiFinding[] } | { status: 400 | 413; detail: string } {
  if (typeof raw !== "object" || raw === null) return { status: 400, detail: "body must be an object" }
  const findings = (raw as { findings?: unknown }).findings
  if (!Array.isArray(findings) || findings.length === 0)
    return { status: 400, detail: "findings must be a non-empty array" }
  if (findings.length > MAX_FINDINGS) return { status: 413, detail: `findings exceeds ${MAX_FINDINGS}` }
  return { findings: findings as FleetApiFinding[] }
}

/**
 * POST /v1/fleet — see file header. Returns { insights: FleetInsight[] } at 200 (empty when no
 * finding's pattern has crossed K=5 — a graceful result, not an error).
 */
export async function handleFleetApiRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further — this route is deliberately tenant-free
  // (see file header: the response never carries a tenant, by privacy design).
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "fleet_endpoint_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env)
  if ("response" in auth) return auth.response

  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null)
      return json({ error: "payload_too_large", detail: `body exceeds ${MAX_BODY_BYTES} bytes` }, 413)
    raw = JSON.parse(capped)
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseBody(raw)
  if ("status" in parsed) {
    const error = parsed.status === 413 ? "payload_too_large" : "invalid_request"
    return json({ error, detail: parsed.detail }, parsed.status)
  }

  // Map each finding to its closed-vocabulary signature, dedupe, and surface only the k-anonymous
  // ones. Any unexpected failure soft-fails to an empty result at 200.
  try {
    const insights: FleetInsight[] = []
    const seen = new Set<string>()
    for (const f of parsed.findings) {
      const pattern = extractFleetPattern({ category: f?.category ?? "", headline: f?.headline, score: f?.score })
      if (!pattern || seen.has(pattern.signature)) continue
      seen.add(pattern.signature)
      const agg = await readAggregate(env, pattern.signature)
      if (!agg || !isEligible(agg)) continue
      const insight = renderFleetInsight(agg)
      if (insight) insights.push({ signature: pattern.signature, insight })
    }
    return json({ insights }, 200)
  } catch {
    return json({ insights: [] }, 200)
  }
}
