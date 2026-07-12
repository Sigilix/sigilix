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
//   cache (7d)    same owner/repo/pr/headSha           → 200 cached:true, $0, no quota consumed
//
// READ-ONLY, ALWAYS: the engine runs with `dryRun: true`, so the orchestrator returns
// the built review BEFORE `publishReviewSubmission` — nothing is posted, no check run
// is created, no comment is written. The injected GitHub client is `diffReviewClient`,
// whose every write method THROWS (`submitReview` / `createIssueComment` / …), so a
// write attempt is a loud failure, not a silent post to a stranger's PR.
//
// NO USAGE LEDGER: a demo run has no installation (installationId 0, exactly like Mode
// A), so `finalize`'s `appendUsage` guard skips the `usage_ledger` row. Its cost is
// still charged against the global daily budget here — the ledger is per-tenant billing,
// the budget is the abuse backstop, and a demo run belongs in the second, not the first.
//
// RECALL-SAFETY: a degraded or errored review must NEVER render as a clean pass. An
// engine failure (`isDryRunEngineFailure`) → 500, never a 200 with an empty findings
// array; a DEGRADED (specialist-unavailable) review returns 200 but carries
// `incomplete.rolesMissing` and says so in the summary.

import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PrReviewFinding, CodeContext } from "@/src/shared/domain/pr-review-finding"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { isDryRunEngineFailure } from "@/src/lib/ensemble/app/session"
import { computeReviewCost } from "@/src/lib/ensemble-slo-telemetry"
import { severityLabelForScore } from "@/src/lib/ensemble/domain/verdict"
import { trustWord } from "@/src/lib/trust-ledger-render"
import { diffReviewClient } from "@/src/lib/api-review-diff-client"
import { ungroundedEnv } from "@/src/lib/api-review-route"
import { attachCodeContextToReview } from "@/src/shared/util/diff-code-context"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import {
  consumeIpQuota,
  isDemoBudgetExhausted,
  parseDemoPrUrl,
  readDemoCache,
  readIpQuota,
  reserveDemoSpend,
  resolveDemoLimits,
  resolveDemoMode,
  secondsUntilNextUtcDay,
  settleDemoSpend,
  writeDemoCache,
  DEMO_ASSUMED_COST_USD,
  type DemoEnv,
  type DemoPrTarget,
} from "@/src/lib/demo-review-guards"
import { fetchPrDiff, fetchPrMeta, fetchPublicRepo, type DemoGithubFailure } from "@/src/lib/demo-review-github"

/** The request body is a single URL — cap the read tiny so an unauthenticated caller
 *  can never make us buffer anything meaningful. */
const MAX_BODY_BYTES = 4_096
/** Cap the evidence snippet we echo back per finding (display only). */
const MAX_EVIDENCE_LINES = 12
const MAX_EVIDENCE_CHARS = 800

const DEFAULT_DEMO_ORIGINS = "https://sigilix.ai,https://www.sigilix.ai,http://localhost:3000"

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
      "access-control-allow-methods": "POST, OPTIONS",
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

function ok(body: DemoReviewResponse): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
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

// ─── finding mapping ────────────────────────────────────────────────

/** The cited lines from the diff slice the renderer already computes — display
 *  evidence, exactly what the PR review would show. Never gates anything. */
function evidenceFrom(context: CodeContext | undefined): string | undefined {
  if (!context || context.lines.length === 0) return undefined
  const text = context.lines
    .slice(0, MAX_EVIDENCE_LINES)
    .map((l) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.text}`)
    .join("\n")
  return text.length > MAX_EVIDENCE_CHARS ? `${text.slice(0, MAX_EVIDENCE_CHARS)}…` : text
}

function toDemoFinding(finding: PrReviewFinding): DemoFinding {
  const evidence = evidenceFrom(finding.codeContext)
  return {
    severity: severityLabelForScore(finding.score),
    title: finding.headline,
    body: finding.body,
    file: finding.path,
    line: finding.line,
    confidence: trustWord(finding.trust).toLowerCase() as DemoFinding["confidence"],
    ...(evidence !== undefined ? { evidence } : {}),
  }
}

// ─── the route ──────────────────────────────────────────────────────

/**
 * POST /v1/demo/review — public, no auth. See the file header for the guard matrix.
 * The check order is deliberate: every rejection that can be decided for free (kill
 * switch → body → URL → IP quota → global budget) happens BEFORE the first GitHub
 * call, and every GitHub-decidable rejection (public? too large?) happens before the
 * first token of model spend.
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
  //    spend, no budget charge, no IP quota consumed. This is what survives HN.
  const cached = await readDemoCache<DemoReviewResponse>(env, target, meta.value.headSha)
  if (cached) return ok({ ...cached, cached: true })

  const diff = await fetchPrDiff(env, target)
  if (!diff.ok) return failureResponse(diff.failure)

  // 8. CONSUME the IP quota and RESERVE the spend BEFORE running the engine — a review
  //    that crashes mid-flight has still burned tokens, so it must still be paid for.
  await consumeIpQuota(env, ip, now)
  await reserveDemoSpend(env, now)

  const startedMs = Date.now()
  let result
  try {
    result = await handlePrReviewEnsemble({
      owner: target.owner,
      repo: target.repo,
      prNumber: target.prNumber,
      headSha: meta.value.headSha,
      installationId: 0, // no installation → no usage_ledger row (see header)
      env: ungroundedEnv(env), // no index/graph retrieval: a stranger's repo is not indexed
      githubClient: diffReviewClient({
        owner: target.owner,
        repo: target.repo,
        prNumber: target.prNumber,
        headSha: meta.value.headSha,
        baseSha: meta.value.baseSha,
        diff: diff.value,
      }) as unknown as GitHubClient,
      dryRun: true, // READ-ONLY: nothing is posted to the PR
      forceFullCoverage: true,
    })
  } catch (error) {
    // The engine threw before reporting telemetry — it may still have spent. Charge the
    // assumed cost (the reservation already stands) and surface the failure, never a pass.
    await settleDemoSpend(env, now, DEMO_ASSUMED_COST_USD)
    console.error(
      JSON.stringify({
        event: "demo-review-failed",
        repo: `${target.owner}/${target.repo}`,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return fail("review_failed", "The review could not be completed. Please try again.", 500)
  }

  // Charge the REAL cost the ensemble reports, reconciling the reservation.
  const costUsd = computeReviewCost(result.telemetry.tokenUsageByModel).totalUsd
  await settleDemoSpend(env, now, costUsd)

  // RECALL-SAFETY: an engine failure is a 500, NEVER a 200 with an empty findings list.
  if (isDryRunEngineFailure(result)) {
    const telemetry = result.telemetry as { internalError?: string; fellBackReason?: string }
    console.error(
      JSON.stringify({
        event: "demo-review-engine-failure",
        repo: `${target.owner}/${target.repo}`,
        reason: telemetry.internalError ?? telemetry.fellBackReason ?? "engine error",
      }),
    )
    return fail("review_failed", "The review could not be completed. Please try again.", 500)
  }

  const body = buildResponse(target, meta.value, result.dryRunReview, diff.value, Date.now() - startedMs)
  await writeDemoCache(env, target, meta.value.headSha, body)
  console.log(
    JSON.stringify({
      event: "demo-review-completed",
      repo: `${target.owner}/${target.repo}`,
      prNumber: target.prNumber,
      findings: body.stats.findingsCount,
      costUsd: Number(costUsd.toFixed(4)),
      durationMs: body.stats.durationMs,
    }),
  )
  return ok(body)
}

/** Shape the engine's dry-run review into the public demo contract. */
function buildResponse(
  target: DemoPrTarget,
  meta: { title: string; changedFiles: number },
  review:
    | {
        verdict: { summary: string; findings: readonly PrReviewFinding[] }
        incomplete?: { rolesMissing: readonly string[] }
      }
    | undefined,
  diff: string,
  durationMs: number,
): DemoReviewResponse {
  const base = {
    repo: `${target.owner}/${target.repo}`,
    prNumber: target.prNumber,
    title: meta.title,
    cached: false,
  }
  // A genuinely-empty review (nothing to review / no findings) is a legitimate clean
  // pass — distinct from an engine failure, which returned 500 above.
  if (!review) {
    return {
      ...base,
      summary: "Sigilix found no reviewable changes in this pull request.",
      stats: { filesReviewed: meta.changedFiles, findingsCount: 0, durationMs },
      findings: [],
    }
  }
  const enriched = attachCodeContextToReview({ verdict: review.verdict, unanchoredFindings: [] }, diff)
  const findings = enriched.verdict.findings.map(toDemoFinding)
  const rolesMissing = review.incomplete?.rolesMissing ?? []
  // RECALL-SAFETY: a degraded review says so in the human-facing summary too — a
  // partial review must never read as a confident clean pass.
  const summary =
    rolesMissing.length > 0
      ? `${review.verdict.summary}\n\n⚠️ Partial coverage: ${rolesMissing.join(", ")} did not complete, so this review ran on incomplete input.`
      : review.verdict.summary
  return {
    ...base,
    summary,
    stats: { filesReviewed: meta.changedFiles, findingsCount: findings.length, durationMs },
    findings,
    ...(rolesMissing.length > 0 ? { incomplete: { rolesMissing: [...rolesMissing] } } : {}),
  }
}
