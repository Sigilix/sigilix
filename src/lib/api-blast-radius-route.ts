// POST /v1/blast-radius — graph-grounded impact preview for an edit the agent is about
// to make. Given the symbol NAMES it is about to change plus the file PATHS those symbols
// live in, return the files that CALL those symbols (`callerPaths`) and the files that
// IMPORT those files (`importDependents`) — so the agent knows what its edit may break
// BEFORE it writes. Auth is the shared static bearer ($OPENCLAW_SIGILIX_API_KEY — the
// same agent key /v1/verify uses), checked from the header BEFORE the body read so an
// unauthenticated caller can never force a large buffer.
//
// The query is the existing per-tenant graph read (`blastRadiusByNamesFor`) — resolved
// against the repo's ACTIVE graph version inside the RepoGraph DO. An UN-indexed repo (no
// active version) returns `{callerPaths:[], importDependents:[]}`: that is a graceful
// EMPTY result, NOT an error. A degraded/missing graph never breaks the caller.
//
// SOFT-FAIL BY DESIGN: any unexpected failure in the graph client resolves to the SAME
// empty result at HTTP 200 — the route never throws to the caller. 503 until keyed; 401
// on a bad bearer; 400 on bad JSON / missing|empty fields; 413 on an oversized body.

import type { Env } from "@/src/shared/types/env"
import { resolveApiKey } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { blastRadiusByNamesFor } from "@/src/lib/repo-graph-client"

// The request carries short identifier strings (symbol names + file paths), never source.
// Cap the whole envelope generously and bound each array's length so a pathological body
// can't blow up the DO query — enforced as the stream is read (BEFORE JSON.parse) for the
// byte cap, and post-parse for the array-length caps.
const MAX_BODY_BYTES = 64 * 1024
const MAX_ARRAY_LENGTH = 500

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface BlastRadiusApiBody {
  owner: string
  repo: string
  names: string[]
  paths: string[]
}

/** A parse failure carrying its own HTTP status, so the route maps it without sniffing the
 *  message prose: a shape error is a 400, an over-long array (well-formed body, one array
 *  past the element cap) is a 413. */
interface ParseError {
  status: 400 | 413
  detail: string
}

/** Validate that `value` is a non-empty array of non-empty strings. Returns the typed
 *  array, or a {@link ParseError} (400 on a shape error, 413 once it exceeds the element
 *  cap — distinct from a 400 so an over-large-but-well-formed body is told apart). */
function parseStringArray(value: unknown, field: string): string[] | ParseError {
  if (!Array.isArray(value) || value.length === 0)
    return { status: 400, detail: `${field} (non-empty array of strings) is required` }
  if (value.length > MAX_ARRAY_LENGTH) return { status: 413, detail: `${field} exceeds ${MAX_ARRAY_LENGTH} entries` }
  if (!value.every((v) => typeof v === "string" && v !== ""))
    return { status: 400, detail: `${field} must be an array of non-empty strings` }
  return value as string[]
}

/** Validate the request body shape; return the typed body or a {@link ParseError}. */
function parseBody(raw: unknown): BlastRadiusApiBody | ParseError {
  if (typeof raw !== "object" || raw === null) return { status: 400, detail: "body must be a JSON object" }
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return { status: 400, detail: "owner (string) is required" }
  if (typeof b.repo !== "string" || b.repo === "") return { status: 400, detail: "repo (string) is required" }
  const names = parseStringArray(b.names, "names")
  if ("status" in names) return names
  const paths = parseStringArray(b.paths, "paths")
  if ("status" in paths) return paths
  return { owner: b.owner, repo: b.repo, names, paths }
}

/**
 * POST /v1/blast-radius — see file header. Returns { callerPaths, importDependents } at
 * 200 (both empty when the repo isn't indexed — a graceful result, not an error). 503
 * until keyed; 401 on a bad bearer; 400 on bad JSON / missing|empty fields; 413 on an
 * oversized body or an over-long array. A graph-client failure soft-fails to the empty
 * result at 200 — the route never returns a 500.
 */
export async function handleBlastRadiusApiRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further — the graph read below is keyed by
  // owner/repo, not installationId.
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "blast_radius_endpoint_not_configured" }, 503)
  }
  if (!(await resolveApiKey(request, env))) return json({ error: "unauthorized" }, 401)

  // Body read is CAPPED as the stream is consumed (post-auth) so an oversized payload is
  // aborted, never fully buffered; `null` = over the cap → 413.
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
    // parseBody tags each failure with its own status: a shape error → 400, an over-long
    // array inside a well-formed body → 413 (no message-prose sniffing).
    const error = parsed.status === 413 ? "payload_too_large" : "invalid_request"
    return json({ error, detail: parsed.detail }, parsed.status)
  }

  // The graph read returns {callerPaths:[], importDependents:[]} for an un-indexed repo
  // (graceful empty, not an error); any unexpected client failure soft-fails to the SAME
  // empty result at 200 so the route never throws a 500 to the caller.
  try {
    const result = await blastRadiusByNamesFor(env, parsed.owner, parsed.repo, {
      changedNames: parsed.names,
      changedPaths: parsed.paths,
    })
    return json({ callerPaths: result.callerPaths, importDependents: result.importDependents }, 200)
  } catch {
    return json({ callerPaths: [], importDependents: [] }, 200)
  }
}
