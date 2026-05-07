// ARC-190 Task 4: public status route handler.
//
// `GET /reviews/<owner>/<repo>/<prNumber>` returns JSON describing the
// per-PR DO state. Spec §4.7. v1 is unauth (read-only metadata only;
// no comment bodies, no diffs, no secrets).
//
// Validation per spec §4.7:
//   - segments must be non-empty after URL-decoding
//   - segments must NOT contain `/` (path-traversal guard)
//   - prNumber must be a positive integer
//   - feature-gate: returns 404 when mode === "off"
//
// On valid input, the route fetches the DO stub at
// `https://do.internal/status` (internal route — see §4.3), inspects
// the body, and either returns 200 with the JSON or 404 when DO
// reports `{ kind: "no-state" }`. On DO transport failure → 503.

import type { Env } from "../index"
import type { StatusResponse } from "./types"
import { resolveDoConfig } from "./config"

interface RouteFailure {
  status: 400 | 404 | 503
  reason: string
}

function rejectInvalidSegment(value: string, name: string): RouteFailure | null {
  if (typeof value !== "string" || value.length === 0) {
    return { status: 400, reason: `${name} segment empty` }
  }
  if (value.includes("/")) {
    return { status: 400, reason: `${name} segment must not contain "/"` }
  }
  return null
}

function rejectInvalidPrNumber(prNumber: number): RouteFailure | null {
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { status: 400, reason: "prNumber must be a positive integer" }
  }
  return null
}

function buildInstanceName(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`
}

/**
 * Status route handler. Public (unauth in v1). Returns 404 / 400 /
 * 503 for the documented failure shapes; 200 with `StatusResponse`
 * on the run path.
 */
export async function handleReviewStatusRoute(
  env: Env,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<Response> {
  // Feature-gate: return 404 when DO mode is "off". A 404 here is
  // semantically "no such resource"; from the caller's perspective
  // the feature simply doesn't exist on this deployment.
  const config = resolveDoConfig(env)
  if (config.mode === "off") {
    return new Response(
      JSON.stringify({ error: "review status disabled (mode=off)" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  }

  // Input validation.
  const validations = [
    rejectInvalidSegment(owner, "owner"),
    rejectInvalidSegment(repo, "repo"),
    rejectInvalidPrNumber(prNumber),
  ]
  for (const v of validations) {
    if (v) {
      return new Response(
        JSON.stringify({ error: v.reason }),
        { status: v.status, headers: { "content-type": "application/json" } },
      )
    }
  }

  // Fetch the DO.
  const id = env.PR_REVIEW_RUN.idFromName(buildInstanceName(owner, repo, prNumber))
  const stub = env.PR_REVIEW_RUN.get(id)
  let doRes: Response
  try {
    doRes = await stub.fetch("https://do.internal/status")
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "do transport failed",
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    )
  }
  if (!doRes.ok) {
    return new Response(
      JSON.stringify({ error: `do returned ${doRes.status}` }),
      { status: 503, headers: { "content-type": "application/json" } },
    )
  }

  let body: StatusResponse
  try {
    body = (await doRes.json()) as StatusResponse
  } catch {
    return new Response(
      JSON.stringify({ error: "do response was not valid JSON" }),
      { status: 503, headers: { "content-type": "application/json" } },
    )
  }

  if (body.kind === "no-state") {
    return new Response(
      JSON.stringify({ error: "no review state for this PR" }),
      { status: 404, headers: { "content-type": "application/json" } },
    )
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
