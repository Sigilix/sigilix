// SIG-156: POST /admin/index-repo — authenticated manual trigger to (re)index a
// single repo. Enqueues a normal `index-repo` job (reason: "manual"), so the
// existing consumer bootstraps it (idempotent: a fresh manifest freshness-skips).
//
// Why this exists: bootstrap only fires on install / repos-added webhooks, and
// `OPENCLAW_INDEXER_ENABLED` was enabled after the app was already installed —
// so existing installs (incl. the self-repo) never indexed and `push` won't
// bootstrap them (`no-prior-index`). This is the operator escape hatch + the
// validation tool + the building block for the full installation backfill.

import type { Env } from "../index"
import { requireBearerToken } from "./auth-bearer"
import { resolveRepoInstallationId } from "./github-app"
import { runIndexBackfill } from "./index-backfill"
import { runIndexReconciliation } from "./index-reconciliation"

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

  const installationId = await resolveRepoInstallationId(
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    owner,
    repo,
  )
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
 * SIG-156 PR3: POST /admin/index-reconcile — bearer-auth manual trigger for
 * the same reconciliation routine the scheduled `crons` handler runs. Unlike
 * the backfill (which fans out ALL repos and relies on consumer freshness),
 * the reconciler reads each repo's manifest first and only enqueues repos
 * whose manifest is missing or invalid. Cheap to re-run; safe to call any
 * time the operator wants a single tick of the cron on demand.
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
