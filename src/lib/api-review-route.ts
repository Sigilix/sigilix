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
//     repo's installation (resolveInstallation), lets the orchestrator build the real
//     client (buildClient → real GitHub fetches), and passes the REAL env so live
//     code-index / graph retrieval runs. Still dryRun (a CLI review must return JSON,
//     never post a comment to the PR). Phase 2.4.
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
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"
import { isDryRunEngineFailure } from "@/src/lib/ensemble/app/session"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { diffReviewClient } from "./api-review-diff-client"

const MAX_DIFF_BYTES = 1_500_000 // reject oversized diffs (cost/abuse guard) → 413
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
  headSha: string
  baseSha?: string
}
/** Mode A: the client posts the diff; the server reviews it ungrounded. */
type DiffModeBody = ReviewApiCommon & { mode: "diff"; diff: string }
/** Mode B: the server fetches the PR via the GitHub App and reviews it grounded. */
type GroundedModeBody = ReviewApiCommon & { mode: "grounded" }
type ReviewApiBody = DiffModeBody | GroundedModeBody

/** Validate the request body shape; return the typed body or an error string. */
function parseBody(raw: unknown): ReviewApiBody | string {
  if (typeof raw !== "object" || raw === null) return "body must be a JSON object"
  const b = raw as Record<string, unknown>
  if (typeof b.owner !== "string" || b.owner === "") return "owner (string) is required"
  if (typeof b.repo !== "string" || b.repo === "") return "repo (string) is required"
  if (typeof b.prNumber !== "number" || !Number.isInteger(b.prNumber)) return "prNumber (integer) is required"
  if (typeof b.headSha !== "string" || b.headSha === "") return "headSha (string) is required"
  if (b.baseSha !== undefined && typeof b.baseSha !== "string") return "baseSha must be a string"
  if (b.mode !== undefined && b.mode !== "diff" && b.mode !== "grounded") return 'mode must be "diff" or "grounded"'
  const common: ReviewApiCommon = {
    owner: b.owner,
    repo: b.repo,
    prNumber: b.prNumber,
    headSha: b.headSha,
    ...(typeof b.baseSha === "string" ? { baseSha: b.baseSha } : {}),
  }
  if (b.mode === "grounded") return { ...common, mode: "grounded" }
  // Default (and explicit "diff"): Mode A requires the diff.
  if (typeof b.diff !== "string" || b.diff === "") return "diff (non-empty string) is required for Mode A"
  return { ...common, mode: "diff", diff: b.diff }
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

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json({ error: "invalid_json" }, 400)
  }
  const parsed = parseBody(raw)
  if (typeof parsed === "string") return json({ error: "invalid_request", detail: parsed }, 400)

  // Per-mode validation, then build the engine args. Both modes are dryRun (a CLI
  // review returns JSON and never posts) + forceFullCoverage (single-shot: avoid the
  // SIG-459 empty-delta skip). Validation rejections happen BEFORE the daily ceiling
  // so a 400/413/422/503 doesn't consume the day's budget.
  let args: EnsembleHandlerArgs
  if (parsed.mode === "diff") {
    if (parsed.diff.length > MAX_DIFF_BYTES) {
      return json({ error: "diff_too_large", detail: `diff exceeds ${MAX_DIFF_BYTES} bytes` }, 413)
    }
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
    // Mode B (grounded): the orchestrator builds the real client from the resolved
    // installation, so the GitHub App must be configured and installed on the repo.
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
    args = {
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      headSha: parsed.headSha,
      installationId: lookup.installationId, // orchestrator → buildClient(env, id) → real grounded client
      env: groundedReviewEnv(env), // REAL bindings (grounded retrieval live), review-memory off, no repoId/client.
      dryRun: true,
      forceFullCoverage: true,
    }
  }

  // Coarse endpoint-wide daily ceiling (cost guard) — placed after all validation so a
  // 400/413/422/503 doesn't burn budget, but BEFORE the engine: a run that reaches the
  // engine counts even if it later errors (it can still incur real model spend).
  if (!(await admitUnderDailyCeiling(env))) {
    return json({ error: "daily_limit_exceeded" }, 429)
  }

  let result
  try {
    result = await handlePrReviewEnsemble(args)
  } catch (err) {
    // The orchestrator normally catches internally and returns status "errored";
    // a thrown error is still an engine failure → 500, never a clean pass.
    return json({ error: "review_failed", detail: err instanceof Error ? err.message : String(err) }, 500)
  }

  // RECALL-SAFETY: an engine failure (errored OR a no-verdict bail like a total model
  // outage) → 500, never a 200/empty clean pass.
  if (isDryRunEngineFailure(result)) {
    const tel = result.telemetry as { internalError?: string; fellBackReason?: string }
    return json({ error: "review_failed", detail: tel.internalError ?? tel.fellBackReason ?? "engine error" }, 500)
  }
  // 200 with the DryRunReview verbatim; `null` body = nothing to review (skipped).
  return json(result.dryRunReview ?? null, 200)
}
