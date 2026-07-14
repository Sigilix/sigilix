// Portal Organization page HTTP routes, wired into src/index.ts through the
// single `handleOrgRoutes` dispatcher below. Kept here (not inlined in
// index.ts) for the file's COMPLIANCE.md §4 line budget — the same pattern as
// src/do/mcp/routes.ts's `tryHandleMcpRoute`.
//
//   GET  /v1/org/overview                              → org-overview-route.ts
//   POST /v1/org/:installationId/members               → org-members-route.ts
//   PATCH/DELETE /v1/org/:installationId/members/:id   → org-members-route.ts
//   POST /v1/org/:installationId/members/:login/seat   → org-seat-route.ts
//   GET  /v1/org/:installationId/data-consent          → data-consent-route.ts
//   POST /v1/org/:installationId/data-consent          → data-consent-route.ts
//   GET  /v1/org/:installationId/repository-context     → repository-context-route.ts
//   PUT  /v1/org/:installationId/repository-context     → repository-context-route.ts
//   GET/POST/DELETE /v1/org/:installationId/learnings[/:id] → org-learnings-route.ts
//
// Both are portal-facing (a DIFFERENT ORIGIN — app.sigilix.ai / localhost:3300
// drives them over `fetch(…, { credentials: "include" })`), so this surface
// owns its own portal-CORS handling: the OPTIONS preflight is answered via
// handlePortalPreflight and every matched response is wrapped with
// withPortalCors (never a `*` origin). The dispatcher returns `null` when
// nothing under /v1/org/ matches, so index.ts falls through to its own routing.

import { handleGetDataConsent, handleSetDataConsent } from "@/src/lib/data-consent-route"
import { handleAdminOrgAccessRecoveryRoute } from "@/src/lib/admin-org-access-route"
import { handleCreateAppMemory, handleDeleteAppMemory, handleListAppMemories } from "@/src/lib/app-memory-route"
import { handleCreateOrgLearning, handleDeleteOrgLearning, handleListOrgLearnings } from "@/src/lib/org-learnings-route"
import { handleOrgOverviewRoute } from "@/src/lib/org-overview-route"
import { handleAddOrgMember, handleDeleteOrgMember, handleUpdateOrgMemberRole } from "@/src/lib/org-members-route"
import { handleOrgSeatRoute } from "@/src/lib/org-seat-route"
import { handleGetRepositoryContext, handlePutRepositoryContext } from "@/src/lib/repository-context-route"
import { handleGetReviewConfig, handleSetReviewConfig } from "@/src/lib/review-config-route"
import { handleGetLinearConfig, handleSetLinearConfig } from "@/src/lib/linear-config-route"
import { handleGetSlackConfig, handleSetSlackConfig } from "@/src/lib/slack-config-route"
import { handleLinearTenantInstall } from "@/src/lib/linear-agent-oauth"
import { handlePortalPreflight, withPortalCors } from "@/src/lib/portal-cors"
import type { Env } from "@/src/shared/types/env"

// Non-global (no `g` flag) so it is safe to reuse for both `.test()` and
// `.exec()` — matches the two regex literals index.ts used inline.
const SEAT_PATH_RE = /^\/v1\/org\/([^/]+)\/members\/([^/]+)\/seat$/
const MEMBERS_PATH_RE = /^\/v1\/org\/([^/]+)\/members$/
const MEMBER_PATH_RE = /^\/v1\/org\/([^/]+)\/members\/([^/]+)$/
const DATA_CONSENT_PATH_RE = /^\/v1\/org\/([^/]+)\/data-consent$/
const REVIEW_CONFIG_PATH_RE = /^\/v1\/org\/([^/]+)\/review-config$/
const LINEAR_CONFIG_PATH_RE = /^\/v1\/org\/([^/]+)\/linear-config$/
const LINEAR_INSTALL_PATH_RE = /^\/v1\/org\/([^/]+)\/linear\/install$/
const SLACK_CONFIG_PATH_RE = /^\/v1\/org\/([^/]+)\/slack-config$/
const APP_MEMORY_PATH_RE = /^\/v1\/org\/([^/]+)\/apps\/([^/]+)\/memories(?:\/([^/]+))?$/
const LEARNINGS_PATH_RE = /^\/v1\/org\/([^/]+)\/learnings(?:\/([^/]+))?$/
const REPOSITORY_CONTEXT_PATH_RE = /^\/v1\/org\/([^/]+)\/repository-context$/

/** True for a path this surface serves — overview, seat, data-consent, or review-config. */
function isOrgPath(pathname: string): boolean {
  return (
    pathname === "/v1/org/overview" ||
    MEMBERS_PATH_RE.test(pathname) ||
    MEMBER_PATH_RE.test(pathname) ||
    SEAT_PATH_RE.test(pathname) ||
    DATA_CONSENT_PATH_RE.test(pathname) ||
    REVIEW_CONFIG_PATH_RE.test(pathname) ||
    LINEAR_CONFIG_PATH_RE.test(pathname) ||
    LINEAR_INSTALL_PATH_RE.test(pathname) ||
    SLACK_CONFIG_PATH_RE.test(pathname) ||
    APP_MEMORY_PATH_RE.test(pathname) ||
    LEARNINGS_PATH_RE.test(pathname) ||
    REPOSITORY_CONTEXT_PATH_RE.test(pathname)
  )
}

/**
 * Match + dispatch the portal Organization routes. Answers this surface's own
 * CORS preflight, routes GET /v1/org/overview and POST …/seat to their
 * handlers, and applies portal CORS on the way out. Returns `null` when the
 * request matches nothing here so the caller falls through to its own routing.
 */
export async function handleOrgRoutes(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url)

  // Operator-only, bearer-gated recovery intentionally bypasses portal CORS.
  if (request.method === "POST" && url.pathname === "/admin/org-access/recover") {
    return handleAdminOrgAccessRecoveryRoute(request, env)
  }
  if (request.method === "OPTIONS" && isOrgPath(url.pathname)) {
    return handlePortalPreflight(request, env)
  }
  // portal Organization page: overview (GET) + seat assign/unassign (POST) — org-*-route.ts
  if (request.method === "GET" && url.pathname === "/v1/org/overview") {
    return withPortalCors(request, await handleOrgOverviewRoute(request, env, ctx), env)
  }
  const membersMatch = MEMBERS_PATH_RE.exec(url.pathname)
  if (request.method === "POST" && membersMatch) {
    const iid = decodeInstallationId(membersMatch[1]!)
    return withPortalCors(request, await handleAddOrgMember(request, env, ctx, iid), env)
  }
  const memberMatch = MEMBER_PATH_RE.exec(url.pathname)
  if ((request.method === "PATCH" || request.method === "DELETE") && memberMatch) {
    const iid = decodeInstallationId(memberMatch[1]!)
    const githubUserId = decodePathSegment(memberMatch[2]!)
    if (githubUserId === null) {
      return withPortalCors(request, json({ error: "invalid_github_user_id" }, 400), env)
    }
    const response =
      request.method === "PATCH"
        ? await handleUpdateOrgMemberRole(request, env, ctx, iid, githubUserId)
        : await handleDeleteOrgMember(request, env, ctx, iid, githubUserId)
    return withPortalCors(request, response, env)
  }
  const seatMatch = SEAT_PATH_RE.exec(url.pathname)
  if (request.method === "POST" && seatMatch) {
    const iid = Number(decodeURIComponent(seatMatch[1]!))
    const who = decodeURIComponent(seatMatch[2]!)
    return withPortalCors(request, await handleOrgSeatRoute(request, env, ctx, iid, who), env)
  }
  // sig-training-data-consent: read/set the org's model-training consent — data-consent-route.ts
  const consentMatch = DATA_CONSENT_PATH_RE.exec(url.pathname)
  if (consentMatch) {
    const iid = Number(decodeURIComponent(consentMatch[1]!))
    if (request.method === "GET") {
      return withPortalCors(request, await handleGetDataConsent(request, env, ctx, iid), env)
    }
    if (request.method === "POST") {
      return withPortalCors(request, await handleSetDataConsent(request, env, ctx, iid), env)
    }
  }
  // sig-dashboard-review-config: read/write the portal's server-persisted review
  // config (admin-gated, merged UNDER the committed sigilix.json) — review-config-route.ts
  const reviewConfigMatch = REVIEW_CONFIG_PATH_RE.exec(url.pathname)
  if (reviewConfigMatch) {
    const iid = Number(decodeURIComponent(reviewConfigMatch[1]!))
    if (request.method === "GET") {
      return withPortalCors(request, await handleGetReviewConfig(request, env, ctx, iid), env)
    }
    if (request.method === "PUT") {
      return withPortalCors(request, await handleSetReviewConfig(request, env, ctx, iid), env)
    }
  }
  const linearConfigMatch = LINEAR_CONFIG_PATH_RE.exec(url.pathname)
  if (linearConfigMatch) {
    const iid = Number(decodeURIComponent(linearConfigMatch[1]!))
    if (request.method === "GET") {
      return withPortalCors(request, await handleGetLinearConfig(request, env, ctx, iid), env)
    }
    if (request.method === "PUT") {
      return withPortalCors(request, await handleSetLinearConfig(request, env, ctx, iid), env)
    }
  }
  // Slack channel→repo binding settings (admin-gated) — slack-config-route.ts
  const slackConfigMatch = SLACK_CONFIG_PATH_RE.exec(url.pathname)
  if (slackConfigMatch) {
    const iid = Number(decodeURIComponent(slackConfigMatch[1]!))
    if (request.method === "GET") {
      return withPortalCors(request, await handleGetSlackConfig(request, env, ctx, iid), env)
    }
    if (request.method === "PUT") {
      return withPortalCors(request, await handleSetSlackConfig(request, env, ctx, iid), env)
    }
  }
  const linearInstallMatch = LINEAR_INSTALL_PATH_RE.exec(url.pathname)
  if (request.method === "POST" && linearInstallMatch) {
    const iid = Number(decodeURIComponent(linearInstallMatch[1]!))
    return withPortalCors(request, await handleLinearTenantInstall(request, env, ctx, iid), env)
  }
  const appMemoryMatch = APP_MEMORY_PATH_RE.exec(url.pathname)
  if (appMemoryMatch) {
    let appId: string
    let memoryId: string | undefined
    try {
      appId = decodeURIComponent(appMemoryMatch[2]!)
      memoryId = appMemoryMatch[3] === undefined ? undefined : decodeURIComponent(appMemoryMatch[3])
    } catch {
      return withPortalCors(request, json({ error: "invalid app memory path" }, 400), env)
    }
    const installationId = Number(appMemoryMatch[1])
    if (request.method === "GET" && memoryId === undefined) {
      return withPortalCors(request, await handleListAppMemories(request, env, ctx, installationId, appId), env)
    }
    if (request.method === "POST" && memoryId === undefined) {
      return withPortalCors(request, await handleCreateAppMemory(request, env, ctx, installationId, appId), env)
    }
    if (request.method === "DELETE" && memoryId !== undefined) {
      return withPortalCors(
        request,
        await handleDeleteAppMemory(request, env, ctx, installationId, appId, memoryId),
        env,
      )
    }
  }
  // sig-portal-memories: admin-authored org learnings (Memories & Context) —
  // writes to the `learnings:org:*` KV store PR review reads — org-learnings-route.ts.
  const learningsMatch = LEARNINGS_PATH_RE.exec(url.pathname)
  if (learningsMatch) {
    const installationId = decodeInstallationId(learningsMatch[1]!)
    let learningId: string | undefined
    try {
      learningId = learningsMatch[2] === undefined ? undefined : decodeURIComponent(learningsMatch[2])
    } catch {
      return withPortalCors(request, json({ error: "invalid learnings path" }, 400), env)
    }
    if (request.method === "GET" && learningId === undefined) {
      return withPortalCors(request, await handleListOrgLearnings(request, env, ctx, installationId), env)
    }
    if (request.method === "POST" && learningId === undefined) {
      return withPortalCors(request, await handleCreateOrgLearning(request, env, ctx, installationId), env)
    }
    if (request.method === "DELETE" && learningId !== undefined) {
      return withPortalCors(request, await handleDeleteOrgLearning(request, env, ctx, installationId, learningId), env)
    }
  }
  const repositoryContextMatch = REPOSITORY_CONTEXT_PATH_RE.exec(url.pathname)
  if (repositoryContextMatch) {
    const installationId = decodeInstallationId(repositoryContextMatch[1]!)
    if (request.method === "GET") {
      return withPortalCors(request, await handleGetRepositoryContext(request, env, ctx, installationId), env)
    }
    if (request.method === "PUT") {
      return withPortalCors(request, await handlePutRepositoryContext(request, env, ctx, installationId), env)
    }
  }
  return null
}

function decodeInstallationId(value: string): number {
  const decoded = decodePathSegment(value)
  return decoded === null ? Number.NaN : Number(decoded)
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}
