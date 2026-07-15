// sig-gitlab-connector: end-to-end tests for the portal-facing connect endpoints
// (list projects / connect / disconnect) — exercised through their real handlers
// with a mock KV + stubbed GitLab REST, so a revert of the connect logic fails
// here. Mirrors onboarding-context-route.test.ts's fetch-stub + makeKV style.

import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import {
  handleGitLabConnectListProjects,
  handleGitLabConnectProject,
  handleGitLabConnectStatus,
  handleGitLabConnectDisconnect,
} from "./gitlab-connect-projects"
import { getProjectWebhookSecret, getUserConnectionIds, putUserOAuthToken } from "./gitlab-connect-store"
import { resolveGitLabProjectToken, isGitLabProjectAllowlisted } from "@/src/index-gitlab-scm-provider"
import {
  activateGitLabRepositoryAuthority,
  claimGitLabRepositoryAuthority,
  readGitLabRepositoryAuthority,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const AUTHORITY_MIGRATION = readFileSync(
  new URL("../../../migrations/0026_create_repository_context_authority.sql", import.meta.url),
  "utf8",
)
const CONTEXT_MIGRATION = readFileSync(
  new URL("../../../migrations/0024_create_repository_context.sql", import.meta.url),
  "utf8",
)

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number, userId?: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: "octo",
    githubUserId,
    accessToken: "x",
    encryptionKeyB64url: ENC_KEY,
    ...(userId ? { userId } : {}),
  })
}

function req(url: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { ...init, headers })
}

function makeEnv(kv: KVNamespace): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    OPENCLAW_BASE_URL: "https://api.sigilix.test",
  } as unknown as Env
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

afterEach(() => vi.unstubAllGlobals())

describe("gitlab connect — project endpoints", () => {
  it("status: 401 without a session", async () => {
    const kv = makeKV()
    const res = await handleGitLabConnectStatus(req("https://x/gitlab/connect/status", null), makeEnv(kv), ctx)
    expect(res.status).toBe(401)
  })

  it("status: authorized=false when no OAuth token is stored", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const res = await handleGitLabConnectStatus(req("https://x/gitlab/connect/status", "s1"), makeEnv(kv), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ authorized: false, projects: [] })
  })

  it("list: 409 gitlab_reauthorize when signed in but no GitLab authorization", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const res = await handleGitLabConnectListProjects(req("https://x/gitlab/connect/projects", "s1"), makeEnv(kv), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "gitlab_reauthorize" })
  })

  it("list: returns the user's Maintainer+ projects, marking already-connected ones", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)
    await putUserOAuthToken(env, "gh:111", "oauth-tok")

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.startsWith("https://gitlab.com/api/v4/projects?")) {
          return new Response(
            JSON.stringify([
              {
                id: 5,
                path_with_namespace: "grp/api",
                name: "api",
                permissions: { project_access: { access_level: 40 } },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const res = await handleGitLabConnectListProjects(req("https://x/gitlab/connect/projects", "s1"), env, ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: number; connected: boolean; accessLevel: number }> }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]).toMatchObject({ id: 5, path: "grp/api", accessLevel: 40, connected: false })
  })

  it("connect: 415 when the request is not application/json (CSRF guard)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)
    await putUserOAuthToken(env, "gh:111", "oauth-tok")
    // A cross-origin "simple" POST (text/plain, no preflight) must be refused
    // before the body is read — never provisioning anything.
    const res = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(415)
    expect(await resolveGitLabProjectToken(env, 5)).toBeNull()
  })

  it("connect: provisions hook + review token, stores + auto-allowlists the project", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)
    await putUserOAuthToken(env, "gh:111", "oauth-tok")

    const calls: string[] = []
    let hookBody: Record<string, unknown> = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        calls.push(`${init?.method ?? "GET"} ${url}`)
        if (url === "https://gitlab.com/api/v4/projects/5") {
          return new Response(
            JSON.stringify({
              id: 5,
              path_with_namespace: "grp/api",
              name: "api",
              permissions: { project_access: { access_level: 40 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url === "https://gitlab.com/api/v4/projects/5/hooks") {
          hookBody = JSON.parse(String(init?.body))
          return new Response(JSON.stringify({ id: 99 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        }
        if (url === "https://gitlab.com/api/v4/projects/5/access_tokens") {
          return new Response(JSON.stringify({ id: 77, token: "glpat-review" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const res = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ connected: true, projectId: 5, projectPath: "grp/api" })

    // The webhook points at our ingress with merge_requests_events + a secret.
    expect(hookBody.url).toBe("https://api.sigilix.test/gitlab/webhook")
    expect(hookBody.merge_requests_events).toBe(true)
    expect(typeof hookBody.token).toBe("string")

    // The REVIEW token the dispatch path reads is now stored (per-project),
    // which ALSO auto-allowlists the project (per-project token => onboarded).
    const resolved = await resolveGitLabProjectToken(env, 5)
    expect(resolved).toEqual({ token: "glpat-review", source: "per-project" })
    expect(isGitLabProjectAllowlisted(env, 5, "grp/api", true)).toBe(true)

    // The per-project webhook secret is persisted for the verify path.
    const secret = await getProjectWebhookSecret(env, 5)
    expect(typeof secret).toBe("string")
    expect(secret).toBe(hookBody.token)
  })

  it("connect + disconnect: activates and then removes exact stable-user D1 repository-context authority", async () => {
    const kv = makeKV()
    const stableUserId = "018f4f03-a7d3-7f32-8ad8-9c49c7440941"
    await seedSession(kv, "s1", 111, stableUserId)
    const db = makeD1()
    await db.exec(CONTEXT_MIGRATION)
    await db.exec(AUTHORITY_MIGRATION)
    const env = {
      ...makeEnv(kv),
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as Env
    await putUserOAuthToken(env, stableUserId, "oauth-tok")

    const deleteUrls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === "https://gitlab.com/api/v4/projects/5") {
          return new Response(
            JSON.stringify({
              id: 5,
              path_with_namespace: "grp/api",
              name: "api",
              permissions: { project_access: { access_level: 40 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url === "https://gitlab.com/api/v4/projects/5/hooks" && init?.method === "POST") {
          return new Response(JSON.stringify({ id: 99 }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        }
        if (url === "https://gitlab.com/api/v4/projects/5/access_tokens" && init?.method === "POST") {
          return new Response(JSON.stringify({ id: 77, token: "glpat-review" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        }
        if (init?.method === "DELETE") {
          deleteUrls.push(url)
          return new Response(null, { status: 204 })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const connected = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(connected.status).toBe(200)
    await expect(readGitLabRepositoryAuthority(db, stableUserId)).resolves.toMatchObject({
      status: "ok",
      revision: 1,
      repositories: [{ sourceId: 5, fullName: "grp/api" }],
    })

    env.SIGILIX_GITLAB_BASE_URL = "https://moved.example"
    const mismatchedRetry = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(mismatchedRetry.status).toBe(409)
    expect(await mismatchedRetry.json()).toEqual({ error: "gitlab_context_reconnect_required" })

    const disconnected = await handleGitLabConnectDisconnect(
      req("https://x/gitlab/connect/projects/5", "s1", { method: "DELETE" }),
      env,
      ctx,
      5,
    )
    expect(disconnected.status).toBe(200)
    expect(deleteUrls).toEqual([
      "https://gitlab.com/api/v4/projects/5/hooks/99",
      "https://gitlab.com/api/v4/projects/5/access_tokens/77",
    ])
    await expect(readGitLabRepositoryAuthority(db, stableUserId)).resolves.toEqual({
      status: "ok",
      revision: 2,
      repositories: [],
    })
  })

  it("disconnect: removes a persisted pending authority generation and its exact credentials", async () => {
    const kv = makeKV()
    const stableUserId = "018f4f03-a7d3-7f32-8ad8-9c49c7440941"
    await seedSession(kv, "s1", 111, stableUserId)
    const db = makeD1()
    await db.exec(CONTEXT_MIGRATION)
    await db.exec(AUTHORITY_MIGRATION)
    const env = {
      ...makeEnv(kv),
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as Env
    const pending = await claimGitLabRepositoryAuthority(db, {
      scopeId: stableUserId,
      instanceOrigin: "https://gitlab.com",
      sourceId: 5,
      fullName: "grp/api",
    })
    if (pending.status !== "claimed") throw new Error("expected pending claim")
    await kv.put(
      "gitlab-connection:5",
      JSON.stringify({
        userId: stableUserId,
        projectPath: "grp/api",
        name: "api",
        hookId: 99,
        patId: 77,
        connectedAt: "t",
        contextOwnerUserId: stableUserId,
        instanceOrigin: "https://gitlab.com",
        authorityExternalId: pending.repository.externalId,
        authorityClaimToken: pending.claimToken,
      }),
    )
    await kv.put(`gitlab-project-token:5:${pending.claimToken}`, "glpat-pending")
    await kv.put(`gitlab-webhook-secret:5:${pending.claimToken}`, "whsec-pending")
    await kv.put(`gitlab-connections:${stableUserId}`, JSON.stringify([5]))
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const disconnected = await handleGitLabConnectDisconnect(
      req("https://x/gitlab/connect/projects/5", "s1", { method: "DELETE" }),
      env,
      ctx,
      5,
    )

    expect(disconnected.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await kv.get(`gitlab-project-token:5:${pending.claimToken}`)).toBeNull()
    expect(await kv.get(`gitlab-webhook-secret:5:${pending.claimToken}`)).toBeNull()
    expect(await kv.get("gitlab-connection:5")).toBeNull()
    await expect(readGitLabRepositoryAuthority(db, stableUserId)).resolves.toEqual({
      status: "ok",
      revision: 0,
      repositories: [],
    })
  })

  it("connect retry: removes an expired authority generation before requiring a reconnect", async () => {
    const kv = makeKV()
    const stableUserId = "018f4f03-a7d3-7f32-8ad8-9c49c7440941"
    const replacementUserId = "018f4f03-a7d3-7f32-8ad8-9c49c7440999"
    await seedSession(kv, "s1", 111, stableUserId)
    const db = makeD1()
    await db.exec(AUTHORITY_MIGRATION)
    const env = {
      ...makeEnv(kv),
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as Env
    await putUserOAuthToken(env, stableUserId, "oauth-tok")

    const claimed = await claimGitLabRepositoryAuthority(db, {
      scopeId: stableUserId,
      instanceOrigin: "https://gitlab.com",
      sourceId: 5,
      fullName: "grp/api",
    })
    if (claimed.status !== "claimed") throw new Error("expected authority claim")
    await db
      .prepare(
        `UPDATE repository_context_authority_repository
            SET claim_expires_at = '2000-01-01T00:00:00.000Z'
          WHERE provider = 'gitlab' AND scope_id = ? AND external_id = ? AND claim_token = ?`,
      )
      .bind(stableUserId, claimed.repository.externalId, claimed.claimToken)
      .run()
    const replacement = await claimGitLabRepositoryAuthority(db, {
      scopeId: replacementUserId,
      instanceOrigin: "https://gitlab.com",
      sourceId: 5,
      fullName: "grp/api",
    })
    if (replacement.status !== "claimed") throw new Error("expected replacement authority claim")

    await kv.put(
      "gitlab-connection:5",
      JSON.stringify({
        userId: stableUserId,
        projectPath: "grp/api",
        name: "api",
        hookId: 99,
        patId: 77,
        connectedAt: "t",
        contextOwnerUserId: stableUserId,
        instanceOrigin: "https://gitlab.com",
        authorityExternalId: claimed.repository.externalId,
        authorityClaimToken: claimed.claimToken,
      }),
    )
    await kv.put(`gitlab-project-token:5:${claimed.claimToken}`, "glpat-stale")
    await kv.put(`gitlab-webhook-secret:5:${claimed.claimToken}`, "whsec-stale")
    await kv.put(`gitlab-connections:${stableUserId}`, JSON.stringify([5]))

    env.SIGILIX_GITLAB_BASE_URL = "https://moved.example"
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "gitlab_context_reconnect_required" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([input, init]) => `${init?.method} ${String(input)}`)).toEqual([
      "DELETE https://gitlab.com/api/v4/projects/5/hooks/99",
      "DELETE https://gitlab.com/api/v4/projects/5/access_tokens/77",
    ])
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("private-token")).toBe("glpat-stale")
    }
    expect(await resolveGitLabProjectToken(env, 5)).toBeNull()
    expect(await getProjectWebhookSecret(env, 5, claimed.claimToken)).toBeNull()
    expect(await kv.get("gitlab-connection:5")).toBeNull()
    expect(await getUserConnectionIds(env, stableUserId)).toEqual([])
    await expect(readGitLabRepositoryAuthority(db, stableUserId)).resolves.toEqual({
      status: "ok",
      revision: 0,
      repositories: [],
    })
    await expect(
      activateGitLabRepositoryAuthority(db, {
        scopeId: replacementUserId,
        externalId: replacement.repository.externalId,
        claimToken: replacement.claimToken,
      }),
    ).resolves.toMatchObject({ status: "activated", revision: 1 })
  })

  it("connect: requires a stable session before any GitLab side effect when context authority is on", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const db = makeD1()
    await db.exec(AUTHORITY_MIGRATION)
    const env = {
      ...makeEnv(kv),
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as Env
    await putUserOAuthToken(env, "gh:111", "oauth-tok")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "session_reauthenticate" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("connect: D1 ownership conflict stops before any GitLab provisioning side effect", async () => {
    const kv = makeKV()
    const requesterId = "018f4f03-a7d3-7f32-8ad8-9c49c7440941"
    await seedSession(kv, "s1", 111, requesterId)
    const db = makeD1()
    await db.exec(AUTHORITY_MIGRATION)
    const competing = await claimGitLabRepositoryAuthority(db, {
      scopeId: "018f4f03-a7d3-7f32-8ad8-9c49c7440999",
      instanceOrigin: "https://gitlab.com",
      sourceId: 5,
      fullName: "grp/api",
    })
    if (competing.status !== "claimed") throw new Error("expected competing claim")
    await activateGitLabRepositoryAuthority(db, {
      scopeId: "018f4f03-a7d3-7f32-8ad8-9c49c7440999",
      externalId: competing.repository.externalId,
      claimToken: competing.claimToken,
    })
    const env = {
      ...makeEnv(kv),
      OPENCLAW_REPOSITORY_CONTEXT_API: "on",
      SIGILIX_PLATFORM_DB: db,
    } as Env
    await putUserOAuthToken(env, requesterId, "oauth-tok")
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://gitlab.com/api/v4/projects/5" && !init?.method) {
        return new Response(
          JSON.stringify({
            id: 5,
            path_with_namespace: "grp/api",
            name: "api",
            permissions: { project_access: { access_level: 40 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected provisioning side effect: ${init?.method ?? "GET"} ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "already_connected_other" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("connect: 403 when the user is not a Maintainer of the project", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)
    await putUserOAuthToken(env, "gh:111", "oauth-tok")

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://gitlab.com/api/v4/projects/5") {
          return new Response(
            JSON.stringify({
              id: 5,
              path_with_namespace: "grp/api",
              name: "api",
              permissions: { project_access: { access_level: 30 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const res = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "insufficient_access" })
    // Nothing was provisioned.
    expect(await resolveGitLabProjectToken(env, 5)).toBeNull()
  })

  it("connect: 409 when the project is already connected by another tenant", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)
    await putUserOAuthToken(env, "gh:111", "oauth-tok")
    // Pre-seed a connection owned by a DIFFERENT user.
    await kv.put(
      "gitlab-connection:5",
      JSON.stringify({ userId: "gh:999", projectPath: "grp/api", name: "api", hookId: 1, connectedAt: "t" }),
    )

    const res = await handleGitLabConnectProject(
      req("https://x/gitlab/connect/projects", "s1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: 5 }),
      }),
      env,
      ctx,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "already_connected_other" })
  })

  it("disconnect: 404 for a project the user does not own; purges KV for one they do", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1", 111)
    const env = makeEnv(kv)

    // Not owned -> 404, no leak.
    await kv.put(
      "gitlab-connection:5",
      JSON.stringify({ userId: "gh:999", projectPath: "grp/api", name: "api", hookId: 1, connectedAt: "t" }),
    )
    const notOwned = await handleGitLabConnectDisconnect(
      req("https://x/gitlab/connect/projects/5", "s1", { method: "DELETE" }),
      env,
      ctx,
      5,
    )
    expect(notOwned.status).toBe(404)

    // Owned -> purge review token + secret + connection.
    await kv.put(
      "gitlab-connection:6",
      JSON.stringify({ userId: "gh:111", projectPath: "grp/web", name: "web", hookId: 2, patId: 3, connectedAt: "t" }),
    )
    await kv.put("gitlab-project-token:6", "glpat-review")
    await kv.put("gitlab-webhook-secret:6", "whsec")
    await kv.put("gitlab-connections:gh:111", JSON.stringify([6]))
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    )

    const owned = await handleGitLabConnectDisconnect(
      req("https://x/gitlab/connect/projects/6", "s1", { method: "DELETE" }),
      env,
      ctx,
      6,
    )
    expect(owned.status).toBe(200)
    expect(await resolveGitLabProjectToken(env, 6)).toBeNull()
    expect(await getProjectWebhookSecret(env, 6)).toBeNull()
    expect(await kv.get("gitlab-connection:6")).toBeNull()
  })
})
