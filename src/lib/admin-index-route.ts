// SIG-156: POST /admin/index-repo — authenticated manual trigger to (re)index a
// single repo. Enqueues a normal `index-repo` job (reason: "manual"), so the
// existing consumer bootstraps it (idempotent: a fresh manifest freshness-skips).
//
// Why this exists: bootstrap only fires on install / repos-added webhooks, and
// `OPENCLAW_INDEXER_ENABLED` was enabled after the app was already installed —
// so existing installs (incl. the self-repo) never indexed and `push` won't
// bootstrap them (`no-prior-index`). This is the operator escape hatch + the
// validation tool + the building block for the full installation backfill.

import type { Env } from "@/src/shared/types/env"
import { requireBearerToken } from "./auth-bearer"
import { resolveRepoInstallationId } from "@/src/shared/adapters/github/github-app"
import { runIndexBackfill } from "./index-backfill"
import { runIndexReconciliation } from "./index-reconciliation"
import { runStaleIndexPurge } from "./index-purge"
import { migrateInstallToRepoId } from "./index-migrate-to-repo-id"
import { migrateInstallReviewMemoryToRepoId } from "./review-memory/migrate"

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

export async function handleAdminIndexRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const url = new URL(request.url)
  const owner = url.searchParams.get("owner")?.trim()
  const repo = url.searchParams.get("repo")?.trim()
  if (!owner || !repo) {
    return json({ error: "missing_owner_or_repo", detail: "pass ?owner=<o>&repo=<r>" }, 400)
  }
  // Fail fast on anything that isn't a plausible GitHub owner/repo slug — keeps
  // junk out of the queue + logs (a bad value would otherwise 404 at the API).
  const slug = /^[A-Za-z0-9._-]+$/
  if (!slug.test(owner) || !slug.test(repo)) {
    return json({ error: "invalid_owner_or_repo" }, 400)
  }

  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "github_app_not_configured" }, 503)
  }

  const installationId = await resolveRepoInstallationId(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY, owner, repo)
  if (installationId === null) {
    return json({ error: "installation_not_found", detail: `app not installed on ${owner}/${repo}` }, 404)
  }

  await env.OPENCLAW_JOBS.send({
    type: "index-repo",
    owner,
    repo,
    installationId,
    reason: "manual",
  })

  return json({ enqueued: true, owner, repo, installationId }, 202)
}

/**
 * SIG-156: POST /admin/index-backfill — bearer-auth fan-out that indexes every
 * repo of every GitHub App installation. `?dryRun=true` reports counts without
 * enqueuing. The escape hatch for installs that predate the indexer being
 * enabled (which never bootstrapped and can't bootstrap via push).
 */
export async function handleAdminBackfillRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "github_app_not_configured" }, 503)
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true"
  const summary = await runIndexBackfill(env, { dryRun })
  return json(summary, 200)
}

/**
 * SIG-243 Phase 3: POST /admin/migrate-to-repo-id?installationId=N —
 * bearer-auth one-shot migration that walks every repo of one
 * installation, reads its legacy manifest, fetches the GitHub repo
 * ID via the API, and re-writes the manifest with `githubRepoId`
 * populated. The re-write fires Phase 2's dual-write, populating the
 * new `repo-tenant:{id}` and `repo-vectors:{id}` keys (the latter
 * lands when the next push triggers a fresh vectors write — manifest
 * migration alone doesn't touch the vectors record).
 *
 * Idempotent: re-running on already-migrated repos is a no-op + cheap
 * GitHub API check that returns `already-migrated`.
 *
 * Per-repo errors don't abort the batch. The response carries a
 * structured summary so the operator can re-run on the specific
 * `failed` repos.
 */
export async function handleAdminMigrateToRepoIdRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "github_app_not_configured" }, 503)
  }

  const installationIdRaw = new URL(request.url).searchParams.get("installationId")?.trim()
  const installationId =
    installationIdRaw === undefined || installationIdRaw === null || installationIdRaw === ""
      ? NaN
      : Number(installationIdRaw)
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "missing_or_invalid_installation_id", detail: "pass ?installationId=N" }, 400)
  }

  try {
    const summary = await migrateInstallToRepoId(env, installationId)
    return json(summary, 200)
  } catch (err) {
    return json(
      {
        error: "migration_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }
}

/**
 * SIG-247 Phase 1 PR B: POST /admin/migrate-review-memory-to-repo-id
 * ?installationId=N[&dryRun=true] — bearer-auth one-shot migration
 * for the review-memory keyspace. Parallel pattern to
 * `handleAdminMigrateToRepoIdRoute` above but isolated blast radius
 * (per Codex consult Option B — separate endpoint, not combined with
 * the manifest migration).
 *
 * Walks every repo of one installation, lists existing legacy
 * `review-memory:<owner>/<repo>:*` keys, fetches the immutable
 * `repo.id` via GitHub, and writes UNIONED records to the new
 * `review-memory:repo:<id>:*` keys with a `migratedAt` sentinel.
 * Read-union-write, NOT overwrite — a naive copy would clobber
 * dual-write captures that landed at the new key during the
 * transition window (per DeepSeek consult).
 *
 * `?dryRun=true` runs the read-phase + union math without writing.
 *
 * Idempotent re-runs: records already carrying the `migratedAt`
 * sentinel are classified `already-migrated` and not rewritten.
 *
 * Phase 5 cleanup (separate ticket) deletes legacy reads + writes
 * after a 7-day safety window — this PR explicitly does NOT touch
 * legacy keys.
 */
export async function handleAdminMigrateReviewMemoryToRepoIdRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "github_app_not_configured" }, 503)
  }

  const url = new URL(request.url)
  const installationIdRaw = url.searchParams.get("installationId")?.trim()
  const installationId =
    installationIdRaw === undefined || installationIdRaw === null || installationIdRaw === ""
      ? NaN
      : Number(installationIdRaw)
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "missing_or_invalid_installation_id", detail: "pass ?installationId=N" }, 400)
  }
  const dryRun = url.searchParams.get("dryRun") === "true"

  try {
    const summary = await migrateInstallReviewMemoryToRepoId(env, installationId, { dryRun })
    return json(summary, 200)
  } catch (err) {
    return json(
      {
        error: "migration_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    )
  }
}

/**
 * SIG-156 PR3: POST /admin/index-reconcile — bearer-auth manual trigger for
 * the same reconciliation routine the scheduled `crons` handler runs. Unlike
 * the backfill (which fans out ALL repos and relies on consumer freshness),
 * the reconciler reads each repo's manifest first and only enqueues repos
 * whose manifest, citation metadata, active-index snapshot, or graph version
 * is incomplete. Its fail-closed `ready` field is the rollout gate for strict
 * active-index consumers. Cheap to re-run; safe to call any time.
 */
export async function handleAdminReconcileRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) {
    return json({ error: "github_app_not_configured" }, 503)
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true"
  const summary = await runIndexReconciliation(env, { dryRun })
  return json(summary, 200)
}

/**
 * SIG-419: POST /admin/purge-stale-indexes?dryRun=true[&deadOrgs=a,b][&max=N] —
 * bearer-auth bulk purge of stale index records: branch overlays
 * (the `/__branch__/` keyspace, redundant after SIG-413) and every record under
 * a caller-named dead org (e.g. the pre-rename `arc-and-anchor`). Reuses the
 * vetted `deleteRepoIndex` per tuple (Vectorize-before-KV, cross-tenant guard,
 * graph cleanup; branch overlays preserve the default-branch index).
 *
 * `?dryRun=true` reports the full grouped scope without deleting (start here;
 * eyeball `byBaseRepo`). Dead-org deletion is OPT-IN via `?deadOrgs=` — empty
 * means branch overlays only. Each call deletes a bounded batch (subrequest cap)
 * and returns `remaining`; re-POST and loop until a fresh `dryRun` scan reports
 * `totalCandidateTuples: 0` (the re-scan is authoritative — `remaining` is a
 * single-call estimate). `enumerationIncomplete: true` means a `list` page
 * errored, so that call saw only a PARTIAL keyspace and deleted a subset (always
 * safe — never the wrong record); treat its counts as partial and re-run. No
 * GitHub App dependency — this is pure KV/Vectorize/graph cleanup.
 */
export async function handleAdminPurgeStaleIndexesRoute(request: Request, env: Env): Promise<Response> {
  const token = env.OPENCLAW_ADMIN_TOKEN
  if (!token) {
    return json({ error: "admin_endpoint_not_configured" }, 503)
  }
  if (!(await requireBearerToken(request, token))) {
    return json({ error: "unauthorized" }, 401)
  }

  const url = new URL(request.url)
  const dryRun = url.searchParams.get("dryRun") === "true"
  const deadOrgs = (url.searchParams.get("deadOrgs") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
  const maxRaw = url.searchParams.get("max")?.trim()
  const maxParsed = maxRaw === undefined || maxRaw === "" ? NaN : Number(maxRaw)
  // Clamp an override to [1, 100] so a typo can't blow the subrequest budget;
  // omitted/invalid falls through to the module default.
  const maxDeletesPerCall = Number.isInteger(maxParsed) && maxParsed > 0 ? Math.min(maxParsed, 100) : undefined

  const summary = await runStaleIndexPurge(env, {
    dryRun,
    deadOrgs,
    ...(maxDeletesPerCall !== undefined ? { maxDeletesPerCall } : {}),
  })
  return json(summary, 200)
}
