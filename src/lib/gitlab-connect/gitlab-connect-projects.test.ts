// sig-gitlab-connector: end-to-end tests for the portal-facing connect endpoints
// (list projects / connect / disconnect) — exercised through their real handlers
// with a mock KV + stubbed GitLab REST, so a revert of the connect logic fails
// here. Mirrors onboarding-context-route.test.ts's fetch-stub + makeKV style.

import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import {
  handleGitLabConnectListProjects,
  handleGitLabConnectProject,
  handleGitLabConnectStatus,
  handleGitLabConnectDisconnect,
} from "./gitlab-connect-projects"
import { putUserOAuthToken, getProjectWebhookSecret } from "./gitlab-connect-store"
import { resolveGitLabProjectToken, isGitLabProjectAllowlisted } from "@/src/index-gitlab-scm-provider"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))

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

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId: number): Promise<void> {
  await createSession({ kv, sessionId, login: "octo", githubUserId, accessToken: "x", encryptionKeyB64url: ENC_KEY })
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
