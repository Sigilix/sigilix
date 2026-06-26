// SIG-304 Phase 2 — POST /v1/review (hosted thin-client endpoint). Authenticates a
// static bearer ($OPENCLAW_SIGILIX_API_KEY), runs the review engine SERVER-SIDE
// (dryRun → nothing posted; OpenRouter key stays on the Worker), and returns the
// DryRunReview JSON verbatim — the same shape the CLI renderers already consume, so
// the hosted client is render-identical to local. Two request modes:
//
//   Mode A (`mode:"diff"`, the default) — diff-only / UNGROUNDED. The client POSTs a
//     unified diff; the server injects a synthetic GitHubClient built from it and
//     stubs the code index + graph inert (ungroundedEnv). The bearer is a single
//     shared secret and the caller asserts owner/repo, so no index-backed retrieval
//     happens — a key holder can NOT read another repo's indexed private code, and
//     "ungrounded" is literally true (review is diff-only). Phase 2.1.
//
//   Mode B (`mode:"grounded"`) — GROUNDED via the GitHub App. The server resolves the
//     repo's installation (resolveInstallation), builds the real client (buildClient →
//     real GitHub fetches), and passes the REAL env so live code-index / graph
//     retrieval runs. `headSha` is OPTIONAL here: a hosted CLI caller (`--repo/--pr`)
//     has no token, so when it's omitted the server reads it from the PR via the App
//     and injects the client it already built (the CLIENT is reused, though the
//     orchestrator still re-issues its own PR-meta GETs for the stale-head guards).
//     Still dryRun (a CLI
//     review must return JSON, never post a comment to the PR). Phase 2.4 (server
//     capability); the CLI wiring (`--repo/--pr` + $SIGILIX_API_KEY → grounded).
//
//     NO USER-FACING WRITES under dryRun: the orchestrator returns the built review
//     BEFORE publishReviewSubmission, so nothing is posted to the PR. Review-memory /
//     learnings are also disabled (groundedReviewEnv turns OPENCLAW_REVIEW_MEMORY_ENABLED
//     off + no repoId): they are per-customer-flywheel features keyed by repoId, and
//     leaving them on would (a) read stale legacy owner/repo records and (b) fire the
//     SIG-280 shadow KV write in verification-prep — so disabling them keeps the
//     grounded review a pure read. (Best-effort cost/SLO telemetry KV writes on a
//     skip/bail path are intentional and unaffected — they are not posted output.)
//
// RECALL-SAFETY: an engine FAILURE (errored, or ANY no-verdict bail — total model
// outage, synth parse/provenance failure, cost-governor trim-to-empty) → HTTP 500,
// NEVER a 200/empty body — a failed review must never read as a clean pass (see
// isDryRunEngineFailure). Only a genuinely-empty review returns 200 null.

import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { EnsembleHandlerArgs } from "@/src/lib/ensemble/app/orchestrator-types"
import { requireBearerToken } from "./auth-bearer"
import { admitTenant, releaseTenant, resolveFairnessConfig } from "@/src/features/tenancy"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { isDryRunEngineFailure } from "@/src/lib/ensemble/app/session"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import { attachCodeContextToReview } from "@/src/shared/util/diff-code-context"
import { readBodyCapped } from "@/src/shared/util/read-body-capped"
import { diffReviewClient } from "./api-review-diff-client"
import { getProviderCooldownRemainingMs } from "@/src/shared/adapters/model/provider-cooldown-client"
import { resolveCooldownMode } from "@/src/lib/ensemble/domain/backpressure"

const MAX_DIFF_BYTES = 1_500_000 // reject oversized diffs (cost/abuse guard) → 413
// Whole-envelope cap, enforced as the stream is read (BEFORE JSON.parse) so an
// oversized body is aborted, not buffered. 2× MAX_DIFF_BYTES leaves headroom for
// JSON-escaping a max-size diff + the small meta fields; the diff-specific 413
// (diff_too_large) still gives the precise reason for a legitimately-shaped body.
const MAX_BODY_BYTES = 3_000_000
const DEFAULT_DAILY_LIMIT = 200 // coarse endpoint-wide daily request ceiling (cost guard)
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60 // expire yesterday's counter (2-day window)

/**
 * Coarse endpoint-wide daily ceiling (SIG-304 Phase 2.4 cost guard). A single global
 * KV counter per day — NOT per-key metering. Returns false (→ 429) once the day's
 * count reaches the limit, otherwise increments and returns true. Best-effort: a KV
 * hiccup never blocks a review (the per-review cost governor is the real cap). The
 * check+increment is non-atomic (KV has no atomic incr) — acceptable for a COARSE
 * ceiling: a burst may slip a few past, but runaway spend is still bounded.
 */
async function admitUnderDailyCeiling(env: Env): Promise<boolean> {
  const parsed = Number(env.OPENCLAW_SIGILIX_API_DAILY_LIMIT)
  const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_LIMIT
  try {
    const day = new Date().toISOString().slice(0, 10)
    const key = `v1review:count:${day}`
    const current = Number(await env.OPENCLAW_STATE?.get(key)) || 0
    if (current >= limit) return false
    await env.OPENCLAW_STATE?.put(key, String(current + 1), { expirationTtl: DAY_COUNTER_TTL_SECONDS })
    return true
  } catch {
    return true // never block a review on a counter failure
  }
}

/** Inert read bindings so Mode A can't touch any tenant's indexed code (retrieval +
 *  graph return nothing → genuinely diff-only). Mirrors the CLI's createLocalEnv stub. */
function ungroundedEnv(env: Env): Env {
  const emptyIndex = {
    query: async () => ({ matches: [] }),
    insert: async () => undefined,
    upsert: async () => undefined,
  } as unknown as Env["OPENCLAW_CODE_INDEX"]
  const noopDo = {
    idFromName: (n: string) => ({ toString: () => n, equals: () => false }),
    idFromString: (s: string) => ({ toString: () => s, equals: () => false }),
    newUniqueId: () => ({ toString: () => "local", equals: () => false }),
    get: () =>
      new Proxy(
        {},
        {
          get: (_t, p) => (p === "fetch" ? async () => new Response(null, { status: 200 }) : async () => undefined),
        },
      ),
  } as unknown as Env["REPO_GRAPH_DO"]
  return { ...env, OPENCLAW_CODE_INDEX: emptyIndex, REPO_GRAPH_DO: noopDo }
}

/** Mode B env: the REAL bindings (code-index + graph retrieval are LIVE → grounded),
 *  but review-memory is forced OFF. Review-memory is a repoId-keyed per-customer
 *  feature and Mode B passes no repoId; left on, its lookup would read stale legacy
 *  owner/repo records and trigger the SIG-280 shadow KV write (verification-prep) —
 *  the only compute-path write. Off → the grounded review reads context but writes
 *  nothing (matches Mode A's no-write property, robustly rather than incidentally). */
function groundedReviewEnv(env: Env): Env {
  return { ...env, OPENCLAW_REVIEW_MEMORY_ENABLED: "off" }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface ReviewApiCommon {
  owner: string
  repo: string
  prNumber: number
  baseSha?: string
}
/** Mode A: the client posts the diff; the server reviews it ungrounded. headSha required. */
type DiffModeBody = ReviewApiCommon & { mode: "diff"; headSha: string; diff: string }
/** Mode B: the server fetches the PR via the GitHub App and reviews it grounded. headSha
 *  is OPTIONAL — a hosted CLI caller has no token, so the server reads it from the PR. */
type GroundedModeBody = ReviewApiCommon & { mode: "grounded"; headSha?: string }
type ReviewApiBody = DiffModeBody | GroundedModeBody

/** Validate the request body shape; return the typed body or an error string. */
function parseBody(raw: unknown): ReviewApiBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return "owner (string) is required"
  if (typeof b.repo !== "string" || b.repo === "") return "repo (string) is required"
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber)) return "prNumber (integer) is required"
  if (b.baseSha !== undefined && typeof b.baseSha !== "string") return "baseSha must be a string"
  if (b.headSha !== undefined && typeof b.headSha !== "string") return "headSha must be a string"
  if (b.mode !== undefined && b.mode !== "diff" && b.mode !== "grounded") return 'mode must be "diff" or "grounded"'
  const common: ReviewApiCommon = {
    owner: b.owner,
    repo: b.repo,
    prNumber: b.prNumber,
    ...(typeof b.baseSha === "string" ? { baseSha: b.baseSha } : {}),
  }
  if (b.mode === "grounded") {
    // headSha optional: the server resolves it from the PR when absent.
    return {
      ...common,
      mode: "grounded",
      ...(typeof b.headSha === "string" && b.headSha !== "" ? { headSha: b.headSha } : {}),
    }
  }
  // Default (and explicit "diff"): Mode A requires headSha + the diff.
  if (typeof b.headSha !== "string" || b.headSha === "") return "headSha (string) is required for Mode A"
  if (typeof b.diff !== "string" || b.diff === "") return "diff (non-empty string) is required for Mode A"
  return { ...common, mode: "diff", headSha: b.headSha, diff: b.diff }
}

/**
 * POST /v1/review (Mode A diff-only, or Mode B grounded — see file header). Auth is
 * checked from the header BEFORE the body is read so an unauthenticated caller can't
 * force a large body buffer.
 */
export async function handleReviewApiRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_SIGILIX_API_KEY
  if (!token) return json({ error: "review_endpoint_not_configured" }, 503)
  if (!(await requireBearerToken(request, token))) return json({ error: "unauthorized" }, 401)

  // Body read is CAPPED as the stream is consumed (post-auth) so an oversized
  // payload is aborted, never fully buffered; `null` = over the cap → 413.
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
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  // SIG-455: per-tenant fairness gate — Mode B ONLY. Mode A uses a shared API key and the
  // caller asserts owner/repo, so keying the semaphore on owner/repo is spoofable; the
  // daily ceiling (admitUnderDailyCeiling) is Mode A's sole guard. Mode B resolves a real
  // installationId via resolveInstallation (not spoofable), so the fairness gate is safe.
  // "off" disables admission entirely; "shadow" measures but never blocks; "enforce" returns
  // 429 on denial. Complementary to admitUnderDailyCeiling (global cost ceiling, kept as-is).
  const { mode: fairnessMode, cap: fairnessCap } = resolveFairnessConfig(env)
  // Holds the granted lease so releaseTenant can be called in finally after the ensemble.
  let lease: { tenantId: string; leaseId: string } | undefined

  // Per-mode: cheap validation → daily ceiling → (Mode B only) fairness gate → build the
  // engine args. Both modes are dryRun (a CLI review returns JSON, never posts) +
  // forceFullCoverage (single-shot: avoid the SIG-459 empty-delta skip). Cheap validation
  // (400/413/422/503) happens BEFORE the ceiling so it doesn't consume budget; the ceiling
  // runs BEFORE any model spend OR GitHub-touching work (the grounded buildClient +
  // getPullRequest) so a probe that mints an installation token + hits GitHub still counts
  // against the ceiling. The Mode B fairness gate runs AFTER the ceiling (independent).
  let args: EnsembleHandlerArgs | undefined
  // Mode B: captures a buildClient/getPullRequest failure without returning early so the
  // unified try/finally below always fires releaseTenant (SIG-455 Task 6 lease-leak fix).
  let prBuildError: unknown
  // The diff we already have on each path → the per-finding code-context slice for the
  // `--rich` panel (display evidence; attached to the result below, never gates anything).
  let contextDiff: string | undefined
  if (parsed.mode === "diff") {
    if (parsed.diff.length > MAX_DIFF_BYTES) {
      return json({ error: "diff_too_large", detail: `diff exceeds ${MAX_DIFF_BYTES} bytes` }, 413)
    }
    if (!(await admitUnderDailyCeiling(env))) return json({ error: "daily_limit_exceeded" }, 429)
    contextDiff = parsed.diff
    args = {
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
      installationId: 0, // unused: the injected client bypasses buildClient
      env: ungroundedEnv(env), // Mode A: no index/graph retrieval (tenant-safe + ungrounded)
      githubClient: diffReviewClient(parsed) as unknown as GitHubClient,
      dryRun: true,
      forceFullCoverage: true,
    }
  } else {
    // Mode B (grounded): resolve the installation, build the real client, and review
    // the live PR. The GitHub App must be configured and installed on the repo.
    if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
      return json({ error: "grounded_not_configured" }, 503)
    }
    const lookup = resolveInstallation(parsed.owner, parsed.repo, env.OPENCLAW_GITHUB_INSTALLATION_MAP)
    if (!lookup.ok) {
      return json(
        {
          error: "app_not_installed",
          detail: `the Sigilix GitHub App is not installed on ${parsed.owner}/${parsed.repo}`,
        },
        422,
      )
    }
    // Ceiling BEFORE buildClient/getPullRequest — a probe that mints a token + hits
    // GitHub counts against the budget (no free installation enumeration).
    if (!(await admitUnderDailyCeiling(env))) return json({ error: "daily_limit_exceeded" }, 429)
    // SIG-455 Task 6 (PR B): provider-cooldown read-before-fire for Mode B.
    // Synchronous path: 429 + Retry-After. The CLI caller MUST honor Retry-After — we do
    // not re-enqueue a sync request (GLM sign-off #3). Fail-open: 0 on fault → proceed.
    // shadow/off → skip entirely.
    const cooldownMode = resolveCooldownMode(env)
    if (cooldownMode === "enforce") {
      const remaining = await getProviderCooldownRemainingMs(env)
      if (remaining > 0) {
        console.log(JSON.stringify({ event: "provider-cooldown-honored", surface: "v1review", remainingMs: remaining }))
        return new Response(JSON.stringify({ error: "provider_busy" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": String(Math.ceil(remaining / 1000)) },
        })
      }
    }
    // Fairness gate for Mode B: tenantId is the resolved installationId. Gate AFTER
    // resolveInstallation + ceiling, BEFORE buildClient (avoids spending the GitHub
    // App token budget on an over-cap request).
    if (fairnessMode !== "off") {
      const tenantId = String(lookup.installationId)
      const leaseId = crypto.randomUUID()
      const admit = await admitTenant({ env, tenantId, leaseId, cap: fairnessCap })
      console.log(
        JSON.stringify({
          event: "fairness-decision",
          surface: "v1review",
          tenantId,
          desired: admit.granted ? "GRANT" : "DENY",
          mode: fairnessMode,
        }),
      )
      if (!admit.granted && fairnessMode === "enforce") {
        return new Response(JSON.stringify({ error: "tenant_busy" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(Math.ceil(admit.retryAfterMs / 1000)),
          },
        })
      }
      if (admit.granted) lease = { tenantId, leaseId }
    }
    const groundedEnv = groundedReviewEnv(env) // REAL bindings (retrieval live), review-memory off, no repoId.
    let client: GitHubClient | undefined
    let headSha: string | undefined
    try {
      client = await buildClient(groundedEnv, lookup.installationId)
      // headSha is optional from a hosted CLI (no token) — read it from the PR when absent.
      headSha = parsed.headSha ?? (await client.getPullRequest(parsed.owner, parsed.repo, parsed.prNumber)).head.sha
    } catch (err) {
      // Couldn't auth as the installation or read the PR — capture without returning so the
      // unified try/finally below always runs releaseTenant (SIG-455 Task 6 lease-leak fix).
      prBuildError = err
    }
    if (!prBuildError) {
      // Best-effort code-context source for the rich panel (display-only; never 502 on it).
      try {
        contextDiff = await client!.getPullRequestDiff(parsed.owner, parsed.repo, parsed.prNumber)
      } catch {
        /* code context is best-effort — leave undefined */
      }
      args = {
        owner: parsed.owner,
        repo: parsed.repo,
        prNumber: parsed.prNumber,
        headSha: headSha!,
        installationId: lookup.installationId,
        env: groundedEnv,
        githubClient: client!, // built here to resolve headSha → inject so the orchestrator doesn't rebuild the CLIENT
        dryRun: true,
        forceFullCoverage: true,
      }
    }
  }

  let result
  try {
    // Mode B: if buildClient/getPullRequest failed, return 502 from inside this try block
    // so the finally always fires and releaseTenant is called. A return inside a try block
    // always triggers finally — unlike a return that exits the function before the try is
    // entered, which was the pre-fix behavior that leaked the lease (SIG-455 Task 6).
    if (prBuildError !== undefined) {
      return json(
        {
          error: "pr_unavailable",
          detail: prBuildError instanceof Error ? prBuildError.message : String(prBuildError),
        },
        502,
      )
    }
    result = await handlePrReviewEnsemble(args!)
  } catch (err) {
    // The orchestrator normally catches internally and returns status "errored";
    // a thrown error is still an engine failure → 500, never a clean pass.
    return json({ error: "review_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  } finally {
    // Release the per-tenant slot on both success and throw so the semaphore is
    // never leaked by an ensemble error. releaseTenant swallows all errors internally.
    if (lease) await releaseTenant(env, lease.tenantId, lease.leaseId)
  }

  // RECALL-SAFETY: an engine failure (errored OR a no-verdict bail like a total model
  // outage) → 500, never a 200/empty clean pass.
  if (isDryRunEngineFailure(result)) {
    const tel = result.telemetry as { internalError?: string; fellBackReason?: string }
    return json({ error: "review_failed", detail: tel.internalError ?? tel.fellBackReason ?? "engine error" }, 500)
  }
  // 200 with the DryRunReview; `null` body = nothing to review (skipped). Enrich the
  // findings with the code-context slice (display evidence) from the diff we already had.
  const review = result.dryRunReview
  if (!review) return json(null, 200)
  return json(contextDiff ? attachCodeContextToReview(review, contextDiff) : review, 200)
}
