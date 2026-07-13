// sig-public-demo — POST /v1/demo/review: the PUBLIC, no-signup "try it on any PR"
// endpoint. Paste a public GitHub PR URL, get a real Sigilix review. No GitHub OAuth,
// no App install, no account. This is the top-of-funnel conversion fix: every other
// CTA on the marketing site dead-ends at a login wall before a stranger has seen a
// single finding.
//
// It is a SIBLING of api-review-route.ts (POST /v1/review), not a fork of it. It reuses
// the same engine entry point (`handlePrReviewEnsemble`) in the same `dryRun` +
// ungrounded configuration Mode A already uses — the ONLY differences are (a) the
// server fetches the diff from the public GitHub API instead of the caller POSTing it,
// and (b) it is wrapped in the abuse controls below instead of an API key.
//
// ┌─ ASYNC: START-THEN-POLL (why this is not one synchronous request) ────────────────┐
// │ The full ensemble takes 70-120s+ (up to ~2 min on a big diff). Cloudflare kills a  │
// │ Worker request near ~100s, so a review slower than that NEVER returns and NEVER    │
// │ caches — the browser just sees "could not reach the review service." So the model  │
// │ runs OFF the request path:                                                         │
// │   POST /v1/demo/review {prUrl}                                                     │
// │     • runs every fast guard synchronously (kill switch → body → URL → IP quota →   │
// │       budget → public-repo → PR meta → size cap → PR@SHA cache), then              │
// │     • CACHE HIT  → 200 {status:"done", ...review}                                  │
// │     • CACHE MISS → consumeIpQuota + reserveDemoSpend, enqueue a `demo-review`      │
// │                    queue job, 202 {status:"pending", jobId}                        │
// │   GET  /v1/demo/review?jobId=<id>                                                  │
// │     • 200 {status:"pending"}                 while the async run is in flight      │
// │     • 200 {status:"done", ...review}         once the run wrote its result         │
// │     • 200 {status:"error", error, message}   on a failed/degraded-to-error run     │
// │ The queue consumer gets up to 15 min — far more than the review needs. The engine  │
// │ run + spend reconciliation + cache/job writes live in demo-review-job.ts.          │
// └─────────────────────────────────────────────────────────────────────────────────┘
//
// ┌─ WHY THE GUARDS ARE THE FEATURE ────────────────────────────────────────────────┐
// │ This endpoint HAS NO AUTH AND SPENDS REAL MONEY (~$0.25/review measured, ~$0.83  │
// │ on a big diff). An open loop against it drains a real card. Every layer below is │
// │ load-bearing; see demo-review-guards.ts for the counters themselves.             │
// └─────────────────────────────────────────────────────────────────────────────────┘
//
//   kill switch   SIGILIX_DEMO_MODE !== "on"           → 503 demo_disabled   (FAIL CLOSED)
//   per-IP cap    SIGILIX_DEMO_IP_LIMIT (3/UTC-day)    → 429 rate_limited    (+retryAfterSec)
//   global budget SIGILIX_DEMO_DAILY_BUDGET_USD ($20)  → 503 at_capacity     (hard spend backstop)
//   public only   GitHub says private/404              → 400 not_public      (never reviews private code)
//   size cap      >1500 lines / >40 files / >400KB     → 400 too_large       (the expensive tail)
//   cache (7d)    same owner/repo/pr/headSha           → 200 done, $0, no quota consumed
//
// READ-ONLY, ALWAYS: the engine runs with `dryRun: true`, so the orchestrator returns
// the built review BEFORE `publishReviewSubmission` — nothing is posted, no check run
// is created, no comment is written. The injected GitHub client is `diffReviewClient`,
// whose every write method THROWS — a write attempt is a loud failure, not a silent post.
//
// RECALL-SAFETY: a degraded or errored review must NEVER render as a clean pass. An
// engine failure resolves the job to `error` (never a `done` with empty findings) and
// is never cached; a DEGRADED (specialist-unavailable) review resolves `done` but
// carries `incomplete.rolesMissing` and says so in the summary. See demo-review-job.ts.

import { hasJsonContentType } from "@/src/lib/portal-cors"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import {
  consumeIpQuota,
  isDemoBudgetExhausted,
  parseDemoPrUrl,
  readDemoCache,
  readDemoJob,
  readIpQuota,
  reserveDemoSpend,
  resolveDemoLimits,
  resolveDemoMode,
  secondsUntilNextUtcDay,
  settleDemoSpend,
  writeDemoJob,
  DEMO_ASSUMED_COST_USD,
  type DemoEnv,
} from "@/src/lib/demo-review-guards"
import { fetchPrMeta, fetchPublicRepo, type DemoGithubFailure } from "@/src/lib/demo-review-github"

/** The request body is a single URL — cap the read tiny so an unauthenticated caller
 *  can never make us buffer anything meaningful. */
const MAX_BODY_BYTES = 4_096

// The marketing site only. NO localhost in the shipped default — a locally-served
// attacker page must not get a readable (CORS-granted) response in prod. Dev sets
// SIGILIX_DEMO_ORIGINS explicitly to add its localhost origin.
const DEFAULT_DEMO_ORIGINS = "https://sigilix.ai,https://www.sigilix.ai"

// ─── the public contract (the marketing site is built against this) ─────

export interface DemoFinding {
  severity: "P0" | "P1" | "P2" | "P3"
  title: string
  body: string
  file: string
  line: number
  confidence: "verified" | "reproduced" | "grounded" | "model"
  evidence?: string
}

export interface DemoReviewResponse {
  repo: string
  prNumber: number
  title: string
  cached: boolean
  summary: string
  stats: { filesReviewed: number; findingsCount: number; durationMs: number }
  findings: DemoFinding[]
  /** RECALL-SAFETY: present when a specialist was unavailable — the review ran on
   *  PARTIAL input and must not be read as a clean pass even with zero findings. */
  incomplete?: { rolesMissing: string[] }
}

/**
 * The poll-job record persisted by the async run and returned by GET. `done` carries
 * the full review inline (`status` + every `DemoReviewResponse` field) so the frontend
 * reads one flat object. `error` mirrors the sync path's `review_failed` — an explicit
 * failure, never a clean pass. Written by demo-review-job.ts; read here.
 */
export type DemoJobRecord =
  | { status: "pending" }
  | ({ status: "done" } & DemoReviewResponse)
  | { status: "error"; error: string; message: string }

// ─── CORS (public, NO credentials) ──────────────────────────────────

/**
 * The demo is origin-allowlisted for the marketing site but carries NO cookies and NO
 * credentials, so this is NOT an abuse control — CORS only constrains browsers, and
 * `curl` ignores it entirely. The abuse controls above are what actually bound spend.
 */
function allowedOrigin(request: Request, env: DemoEnv): string | null {
  const origin = request.headers.get("origin")
  if (!origin) return null
  const allowed = (env.SIGILIX_DEMO_ORIGINS ?? DEFAULT_DEMO_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return allowed.includes(origin) ? origin : null
}

export function withDemoCors(request: Request, response: Response, env: DemoEnv): Response {
  const origin = allowedOrigin(request, env)
  const headers = new Headers(response.headers)
  headers.append("vary", "Origin")
  if (origin) headers.set("access-control-allow-origin", origin)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export function handleDemoPreflight(request: Request, env: DemoEnv): Response {
  const origin = allowedOrigin(request, env)
  if (!origin) return new Response(null, { status: 403, headers: { vary: "Origin" } })
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    },
  })
}

// ─── responses ──────────────────────────────────────────────────────

function fail(error: string, message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** GitHub read failures → the contract's error codes. `not_found` is reported as
 *  `invalid_url` (the PR the caller named does not exist) rather than leaking whether
 *  a repo/PR is merely hidden from us. */
function failureResponse(failure: DemoGithubFailure): Response {
  switch (failure.kind) {
    case "not_public":
      return fail(
        "not_public",
        "That repository is private (or does not exist). The demo only reviews public PRs.",
        400,
      )
    case "not_found":
      return fail("invalid_url", "No open pull request was found at that URL.", 400)
    case "too_large":
      return fail("too_large", "That PR's diff is too large for the demo.", 400)
    case "unavailable":
      return fail("github_unavailable", "GitHub could not be reached right now. Try again shortly.", 502)
  }
}

// ─── POST: start (guards synchronously, then enqueue the async run) ──

/**
 * POST /v1/demo/review — public, no auth. See the file header for the guard matrix.
 * The check order is deliberate: every rejection that can be decided for free (kill
 * switch → body → URL → IP quota → global budget) happens BEFORE the first GitHub
 * call, and every GitHub-decidable rejection (public? too large?) happens before the
 * first token of model spend. On a cache miss the review is ENQUEUED (not run inline —
 * a ~2-min review can't fit in a Worker request) and a 202 + jobId is returned.
 */
export async function handleDemoReviewRoute(request: Request, env: DemoEnv): Promise<Response> {
  // 1. KILL SWITCH — fail closed. Nothing below runs when the demo is off.
  if (resolveDemoMode(env) !== "on") {
    return fail("demo_disabled", "The live demo is currently unavailable.", 503)
  }
  if (!env.OPENCLAW_STATE) {
    // The abuse counters live in KV. No KV → no rate limit, no budget cap, no cache.
    // Refuse rather than run an unbounded-spend endpoint with its guards missing.
    console.error(JSON.stringify({ event: "demo-review-kv-missing" }))
    return fail("demo_disabled", "The live demo is currently unavailable.", 503)
  }

  // 1b. CROSS-ORIGIN DRIVE-BY GUARD. `application/json` is NOT a CORS-safelisted
  //     content type, so requiring it forces a browser to PREFLIGHT — and the preflight
  //     (handleDemoPreflight) 403s any origin not on the allowlist, before the POST ever
  //     runs. Without this a malicious page could fire a no-preflight "simple" POST
  //     (text/plain body) that STILL spends money even though it can't read the reply.
  //     A same-origin/curl caller (no Origin header) is unaffected — the IP + budget
  //     caps are its bound. An Origin header that IS present but not allowlisted is
  //     rejected outright (belt-and-braces with the preflight).
  if (!hasJsonContentType(request)) {
    return fail("invalid_request", "Content-Type must be application/json.", 415)
  }
  const origin = request.headers.get("origin")
  if (origin !== null && allowedOrigin(request, env) === null) {
    return fail("forbidden", "This origin is not permitted to use the demo.", 403)
  }

  // 2. Body (tiny cap) + URL shape.
  let raw: unknown
  try {
    const capped = await readBodyCapped(request, MAX_BODY_BYTES)
    if (capped === null) return fail("invalid_url", "Request body is too large.", 400)
    raw = JSON.parse(capped)
  } catch {
    return fail("invalid_url", 'Send a JSON body: { "prUrl": "https://github.com/owner/repo/pull/1" }', 400)
  }
  const prUrl = (raw as { prUrl?: unknown } | null)?.prUrl
  if (typeof prUrl !== "string" || prUrl === "") {
    return fail("invalid_url", 'Send a JSON body: { "prUrl": "https://github.com/owner/repo/pull/1" }', 400)
  }
  const target = parseDemoPrUrl(prUrl)
  if (!target) {
    return fail("invalid_url", "That is not a GitHub pull request URL.", 400)
  }

  const now = new Date()
  const limits = resolveDemoLimits(env)

  // 3. PER-IP QUOTA — read (not consumed) before any GitHub/model work, so an
  //    exhausted IP is rejected for free. `CF-Connecting-IP` is set by the edge and
  //    cannot be spoofed by the client (an X-Forwarded-For header can be).
  const ip = request.headers.get("cf-connecting-ip")
  if (!ip) {
    // No client IP → the per-IP cap is unenforceable → refuse. Fail closed.
    return fail("rate_limited", "Could not identify the caller. Try again shortly.", 429, {
      retryAfterSec: 60,
    })
  }
  const quota = await readIpQuota(env, ip, now, limits)
  if (quota.exhausted) {
    const retryAfterSec = secondsUntilNextUtcDay(now)
    return new Response(
      JSON.stringify({
        error: "rate_limited",
        message: `The demo is limited to ${limits.ipLimit} reviews per day. Sign up to review your own repos without limits.`,
        retryAfterSec,
      }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": String(retryAfterSec) } },
    )
  }

  // 4. GLOBAL DAILY BUDGET — the backstop that bounds worst-case spend even if every
  //    other layer is defeated (rotating IPs, a cache-busting SHA, whatever).
  if (await isDemoBudgetExhausted(env, now, limits)) {
    return fail("at_capacity", "The demo has hit its daily capacity. Please try again tomorrow.", 503)
  }

  // 5. PUBLIC REPO ONLY — verified against GitHub BEFORE anything is reviewed.
  const publicRepo = await fetchPublicRepo(env, target)
  if (!publicRepo.ok) return failureResponse(publicRepo.failure)

  const meta = await fetchPrMeta(env, target)
  if (!meta.ok) return failureResponse(meta.failure)

  // 6. SIZE CAP — big diffs are the expensive tail (measured up to $0.83).
  if (meta.value.changedFiles > limits.maxFiles || meta.value.changedLines > limits.maxLines) {
    return fail(
      "too_large",
      `That PR changes ${meta.value.changedLines} lines across ${meta.value.changedFiles} files; the demo caps at ${limits.maxLines} lines / ${limits.maxFiles} files.`,
      400,
    )
  }

  // 7. CACHE — a repeat request for the same PR at the same SHA is free: no model
  //    spend, no budget charge, no IP quota consumed. This is what survives HN. A hit
  //    is returned inline as a resolved `done` record.
  const cached = await readDemoCache<DemoReviewResponse>(env, target, meta.value.headSha)
  if (cached) return json({ status: "done", ...cached, cached: true })

  // 8. CONSUME the IP quota and RESERVE the spend BEFORE enqueueing — a review that
  //    crashes mid-flight has still burned tokens, so it must still be paid for. The
  //    async run reconciles the reservation to the real cost (or keeps it on failure).
  await consumeIpQuota(env, ip, now)
  await reserveDemoSpend(env, now)

  // 9. ENQUEUE the async run and return 202 + jobId. The diff is fetched IN the consumer
  //    (a 400KB diff exceeds the 128KB queue-message cap); the PR@SHA meta validated
  //    above is pinned so the async run reviews exactly this head. If the enqueue itself
  //    fails, keep the reservation (cost-safe), resolve the job to error, and 500.
  const jobId = crypto.randomUUID()
  await writeDemoJob(env, jobId, { status: "pending" } satisfies DemoJobRecord)
  try {
    await env.OPENCLAW_JOBS.send({
      type: "demo-review",
      jobId,
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      headSha: meta.value.headSha,
      baseSha: meta.value.baseSha,
      title: meta.value.title,
      changedFiles: meta.value.changedFiles,
      reservedAtMs: now.getTime(),
    })
  } catch (error) {
    await settleDemoSpend(env, now, DEMO_ASSUMED_COST_USD)
    console.error(
      JSON.stringify({
        event: "demo-review-enqueue-failed",
        repo: `${target.owner}/${target.repo}`,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    await writeDemoJob(env, jobId, {
      status: "error",
      error: "review_failed",
      message: "The review could not be started. Please try again.",
    } satisfies DemoJobRecord)
    return fail("review_failed", "The review could not be started. Please try again.", 500)
  }
  console.log(
    JSON.stringify({
      event: "demo-review-enqueued",
      repo: `${target.owner}/${target.repo}`,
      prNumber: target.prNumber,
      jobId,
    }),
  )
  return json({ status: "pending", jobId }, 202)
}

// ─── GET: poll ──────────────────────────────────────────────────────

/**
 * GET /v1/demo/review?jobId=<id> — poll a started review. Returns the KV job record:
 * `{status:"pending"}` while the async run is in flight, `{status:"done", ...review}`
 * once it wrote its result, `{status:"error", error, message}` on a failed run. An
 * unknown/expired jobId → 404 (the 1h job TTL has passed, or the id was never issued).
 * NO content-type requirement (a GET carries no body) and NO IP/budget accounting (the
 * poll is a free read; the started review already consumed its quota + reservation).
 */
export async function handleDemoReviewPoll(request: Request, env: DemoEnv): Promise<Response> {
  if (!env.OPENCLAW_STATE) {
    console.error(JSON.stringify({ event: "demo-review-kv-missing" }))
    return fail("demo_disabled", "The live demo is currently unavailable.", 503)
  }
  const jobId = new URL(request.url).searchParams.get("jobId")
  if (!jobId) {
    return fail("invalid_request", "Provide a jobId query parameter.", 400)
  }
  const record = await readDemoJob<DemoJobRecord>(env, jobId)
  if (!record) {
    return fail("not_found", "No demo review was found for that job. It may have expired — start a new one.", 404)
  }
  return json(record)
}
