// sig-gitlab-connector: the single dispatcher index.ts calls for the GitLab
// connect surface. Returns a Response when it owns the route, or null to fall
// through (COMPLIANCE §4 — keeps index.ts under the file-size ceiling).
//
// The two OAuth routes are TOP-LEVEL browser navigations (302s, no CORS). The
// project routes are cross-origin portal FETCHES, so they're wrapped in
// withPortalCors here and their OPTIONS preflight is answered in index.ts's
// portal-cors block (which lists these paths).

import type { Env } from "@/src/shared/types/env"
import { withPortalCors } from "@/src/lib/portal-cors"
import { handleGitLabConnectStart, handleGitLabConnectCallback } from "./gitlab-connect-oauth"
import {
  handleGitLabConnectStatus,
  handleGitLabConnectListProjects,
  handleGitLabConnectProject,
  handleGitLabConnectDisconnect,
} from "./gitlab-connect-projects"
import { handleGetGitLabRepositoryContext, handlePutGitLabRepositoryContext } from "./gitlab-repository-context"

/** Paths whose cross-origin portal fetches need the CORS-with-credentials grant
 *  (used by index.ts to answer the OPTIONS preflight in one place). */
export function isGitLabConnectCorsPath(pathname: string): boolean {
  return (
    pathname === "/gitlab/connect/status" ||
    pathname === "/gitlab/connect/projects" ||
    pathname === "/gitlab/connect/repository-context" ||
    pathname.startsWith("/gitlab/connect/projects/")
  )
}

export async function tryHandleGitLabConnectRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response | null> {
  const { pathname } = url
  const method = request.method

  // OAuth round-trip — top-level navigation, no CORS.
  if (method === "GET" && pathname === "/gitlab/connect/start") {
    return handleGitLabConnectStart(request, env, ctx)
  }
  if (method === "GET" && pathname === "/gitlab/connect/callback") {
    return handleGitLabConnectCallback(request, env)
  }

  // Portal fetches — CORS-wrapped.
  if (method === "GET" && pathname === "/gitlab/connect/status") {
    return withPortalCors(request, await handleGitLabConnectStatus(request, env, ctx), env)
  }
  if (pathname === "/gitlab/connect/repository-context") {
    if (method === "GET") {
      return withPortalCors(request, await handleGetGitLabRepositoryContext(request, env, ctx), env)
    }
    if (method === "PUT") {
      return withPortalCors(request, await handlePutGitLabRepositoryContext(request, env, ctx), env)
    }
  }
  if (pathname === "/gitlab/connect/projects") {
    if (method === "GET") {
      return withPortalCors(request, await handleGitLabConnectListProjects(request, env, ctx), env)
    }
    if (method === "POST") {
      return withPortalCors(request, await handleGitLabConnectProject(request, env, ctx), env)
    }
  }
  if (method === "DELETE" && pathname.startsWith("/gitlab/connect/projects/")) {
    const raw = decodeURIComponent(pathname.slice("/gitlab/connect/projects/".length))
    const projectId = Number(raw)
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return withPortalCors(
        request,
        new Response(JSON.stringify({ error: "invalid_project_id" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
        env,
      )
    }
    return withPortalCors(request, await handleGitLabConnectDisconnect(request, env, ctx, projectId), env)
  }

  return null
}
