// POST /v1/verify — the sealed pure-logic VERIFICATION ORACLE (trust-moat foundation v1).
//
// Given a function's source BEFORE and AFTER an edit, run them side-by-side in the sealed
// QuickJS sandbox (no host bindings — no fetch/fs/net/timers) over a type-aware input
// battery and report whether the edit CHANGED behavior, PRESERVED it, or was SKIPPED. This
// is the keystone the agent's later `verify` tool will call. Auth is a static bearer
// ($OPENCLAW_SIGILIX_API_KEY — the shared agent key), checked from the header BEFORE the
// body read so an unauthenticated caller can never force a large buffer.
//
// ── WHAT `changed` MEANS (and does NOT) ─────────────────────────────────────
// `changed` = "the sandbox OBSERVED behavioral divergence on ≥1 type-aware battery input,
// confirmed by a deterministic re-run." `preserved` = "every battery input agreed
// (deterministically) — no divergence observable on the battery." This proves behavioral
// CHANGE / PRESERVATION over a bounded input battery — it is NOT a correctness verdict:
// `changed` does NOT mean the AFTER snippet is a correct fix, and `preserved` does NOT
// prove equality on every possible input. v1 returns ONLY the oracle result; it does not
// touch trust tiers.
//
// SOFT-FAIL BY DESIGN: anything we couldn't run soundly (non-liftable / non-pure code, a
// guest throw/timeout/oom on either side, a flaky tally, an arity mismatch, an over-large
// battery) → `{verdict:"skipped"}` with a machine-readable `detail` tag, ALWAYS HTTP 200 —
// the route NEVER throws to the caller (the oracle's `comparePairInSandbox` never throws).
// 503 until keyed; 401 on a bad bearer; 400 on bad JSON / missing before|after; 413 on an
// oversized body; 429 once the daily CPU ceiling is hit.

import type { Env } from "@/src/shared/types/env"
import { requireApiTenant } from "@/src/lib/api-key-resolver"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { comparePairInSandbox } from "@/src/lib/reproduce/purelogic-pair"
import { retainTrainingRecord } from "@/src/lib/training-retention/retain-training"

// Snippets are small (one function each). Cap each snippet at 16KB, and the whole
// envelope generously above 2× that + the small owner/repo meta — enforced as the stream
// is read (BEFORE JSON.parse) so an oversized body is aborted, not buffered.
const MAX_SNIPPET_BYTES = 16 * 1024
const MAX_BODY_BYTES = 48 * 1024
const DEFAULT_DAILY_LIMIT = 500 // coarse endpoint-wide daily request ceiling (CPU guard)
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60 // expire yesterday's counter (2-day window)

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface VerifyApiBody {
  owner: string
  repo: string
  before: string
  after: string
}

/** A parse failure carrying its own HTTP status, so the route maps it without sniffing the
 *  message prose: a shape error is a 400, an oversized snippet (well-formed body, one snippet
 *  over the per-snippet cap) is a 413. */
interface ParseError {
  status: 400 | 413
  detail: string
}

/** Validate the request body shape; return the typed body or a {@link ParseError}. The byte
 *  cap on each snippet bounds the QuickJS lift/parse cost (the body cap bounds the buffer;
 *  this bounds a single oversized snippet inside a legitimately-shaped body → 413, distinct
 *  from a 400 shape error). */
function parseBody(raw: unknown): VerifyApiBody | ParseError {
  if (typeof raw !== "object" || raw === null) return { status: 400, detail: "body must be a JSON object" }
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return { status: 400, detail: "owner (string) is required" }
  if (typeof b.repo !== "string" || b.repo === "") return { status: 400, detail: "repo (string) is required" }
  if (typeof b.before !== "string" || b.before === "")
    return { status: 400, detail: "before (non-empty string) is required" }
  if (typeof b.after !== "string" || b.after === "")
    return { status: 400, detail: "after (non-empty string) is required" }
  if (byteLength(b.before) > MAX_SNIPPET_BYTES)
    return { status: 413, detail: `before exceeds ${MAX_SNIPPET_BYTES} bytes` }
  if (byteLength(b.after) > MAX_SNIPPET_BYTES)
    return { status: 413, detail: `after exceeds ${MAX_SNIPPET_BYTES} bytes` }
  return { owner: b.owner, repo: b.repo, before: b.before, after: b.after }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).byteLength
}

/**
 * Coarse endpoint-wide daily ceiling (CPU guard — each call burns QuickJS sandbox time).
 * A single global KV counter per day — NOT per-key metering. Returns false (→ 429) once
 * the day's count reaches the limit, otherwise increments and returns true. Best-effort: a
 * KV hiccup never blocks a verify (the per-call sandbox deadlines are the real CPU cap).
 * The check+increment is non-atomic (KV has no atomic incr) — acceptable for a COARSE
 * ceiling: a burst may slip a few past, but runaway CPU is still bounded.
 */
async function admitUnderDailyCeiling(env: Env): Promise<boolean> {
  const parsed = Number(env.OPENCLAW_SIGILIX_VERIFY_DAILY_LIMIT)
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `v1verify:count:${day}`
    const current = Number(await env.OPENCLAW_STATE?.get(key)) || 0
    if (current >= limit) return false
    await env.OPENCLAW_STATE?.put(key, String(current + 1), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
    return true
  } catch {
    return true // never block a verify on a counter failure
  }
}

/**
 * POST /v1/verify — see file header. Returns { verdict, detail, elapsedMs, sample? };
 * `verdict` is "changed" | "preserved" | "skipped" (a soft-fail is `skipped` at 200, never
 * a throw). 503 until keyed; 401 on a bad bearer; 400/413 on a bad/oversized body; 429 once
 * the daily ceiling is hit.
 */
export async function handleVerifyApiRoute(request: Request, env: Env): Promise<Response> {
  // #155 slice 2: resolve the bearer through the per-tenant API-key resolver (a D1
  // api_key lookup), falling back to the legacy shared secret
  // (env.OPENCLAW_SIGILIX_API_KEY -> LEGACY_TENANT_INSTALLATION_ID) so an existing
  // global-key caller is unaffected. FAIL-CLOSED: a missing/bad bearer, a revoked
  // key, OR a genuine D1 fault during the lookup all resolve to null here -> 401,
  // never a bypass (see api-key-resolver.ts — this inverts the repo's usual
  // fail-open D1 default on purpose, because this gates authentication). No
  // installationId is threaded further — this route has no per-tenant concept
  // downstream (the sandbox compare is tenant-agnostic).
  if (!env.OPENCLAW_SIGILIX_API_KEY && !env.SIGILIX_PLATFORM_DB) {
    return json({ error: "verify_endpoint_not_configured" }, 503)
  }
  const auth = await requireApiTenant(request, env)
  if ("response" in auth) return auth.response

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
    // parseBody tags each failure with its own status: a shape error → 400, an oversized
    // snippet inside a well-formed body → 413 (no message-prose sniffing).
    const error = parsed.status === 413 ? "payload_too_large" : "invalid_request"
    return json({ error, detail: parsed.detail }, parsed.status)
  }

  // Cheap validation (400/413/503) happened above so it doesn't consume budget; the ceiling
  // runs BEFORE the QuickJS work (the CPU it guards).
  if (!(await admitUnderDailyCeiling(env))) return json({ error: "daily_limit_exceeded" }, 429)

  // The oracle NEVER throws — any unexpected failure resolves to a `skipped` verdict, so a
  // soft-fail is always a 200, never a 500.
  const result = await comparePairInSandbox(parsed.before, parsed.after)

  // sig-training-retention-wiring (flagged-off). A before/after pair the oracle
  // actually RAN (verdict changed | preserved — never a soft-fail `skipped`) is a
  // high-signal fix-diff: how a flagged issue got edited, plus the behavioral
  // verdict. Offer it to the consent-gated training store for the caller's own
  // installation. INERT by default: retainTrainingRecord returns immediately (no
  // record build, no I/O) while SIGILIX_TRAINING_RETENTION_MODE is off, and even
  // flipped on writes only for a consenting org into the SEPARATE R2 partition,
  // redacted first. The LEGACY global-key sentinel (installationId -1) fails the
  // consent gate closed. Best-effort; never affects the 200 response.
  if (result.verdict !== "skipped") {
    await retainTrainingRecord(env, auth.caller.installationId, () => ({
      kind: "fix-diff",
      id: `${parsed.owner}/${parsed.repo}:verify`,
      payload: JSON.stringify({
        before: parsed.before,
        after: parsed.after,
        verdict: result.verdict,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      }),
      meta: { owner: parsed.owner, repo: parsed.repo, verdict: result.verdict },
    }))
  }

  return json(result, 200)
}
