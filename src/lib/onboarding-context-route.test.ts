// #155 onboarding-backend slice 3 — GET /v1/onboarding/context tests.
// Mirrors auth-setup-route.test.ts's fetch-stubbing style for GitHub calls.

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleOnboardingContextRoute } from "@/src/lib/onboarding-context-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))

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
  await createSession({
    kv,
    sessionId,
    login: "octocat",
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

function reqWithSession(url: string, sessionId: string | null): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleOnboardingContextRoute (GET /v1/onboarding/context)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", null), env)
    expect(res.status).toBe(401)
  })

  it("503 when OPENCLAW_SESSION_ENCRYPTION_KEY is not configured", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", "sess-1"), env)
    expect(res.status).toBe(503)
  })

  it("happy path: returns user + installations + repos in the exact contract shape", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat", name: "The Octocat" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return new Response(
            JSON.stringify({ total_count: 1, installations: [{ id: 42, account: { login: "acme-corp" } }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.startsWith("https://api.github.com/user/installations/42/repositories?")) {
          return new Response(
            JSON.stringify({
              total_count: 2,
              repositories: [
                { full_name: "acme-corp/api", description: "The API" },
                { full_name: "acme-corp/worker", description: null },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { login: string; name: string | null }
      installations: Array<{
        installationId: number
        account: string
        repos: Array<{ fullName: string; description: string | null }>
      }>
      gitlabConnectionCount: number
    }
    expect(body.user).toEqual({ login: "octocat", name: "The Octocat" })
    expect(body.installations).toHaveLength(1)
    expect(body.installations[0]).toEqual({
      installationId: 42,
      account: "acme-corp",
      repos: [
        { fullName: "acme-corp/api", description: "The API" },
        { fullName: "acme-corp/worker", description: null },
      ],
    })
    // No GitLab projects connected → 0 (never marks a non-GitLab user onboarded).
    expect(body.gitlabConnectionCount).toBe(0)
  })

  it("reports the count of GitLab projects the caller owns (only their own)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env

    // connectUserKey for a githubUserId-only session (no surrogate userId) → "gh:111".
    const userKey = "gh:111"
    // Two projects owned by this user + one connected by ANOTHER user that a stale
    // index entry still references — only the owned two must count.
    await kv.put(`gitlab-connections:${userKey}`, JSON.stringify([10, 20, 30]))
    await kv.put(
      "gitlab-connection:10",
      JSON.stringify({ userId: userKey, projectPath: "grp/a", name: "a", hookId: 1, connectedAt: "t" }),
    )
    await kv.put(
      "gitlab-connection:20",
      JSON.stringify({ userId: userKey, projectPath: "grp/b", name: "b", hookId: 2, connectedAt: "t" }),
    )
    await kv.put(
      "gitlab-connection:30",
      JSON.stringify({ userId: "gh:999", projectPath: "grp/c", name: "c", hookId: 3, connectedAt: "t" }),
    )

    // GitHub side has no installations (a GitLab-only-style user).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat", name: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return new Response(JSON.stringify({ total_count: 0, installations: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )

    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { installations: unknown[]; gitlabConnectionCount: number }
    expect(body.installations).toEqual([])
    expect(body.gitlabConnectionCount).toBe(2)
  })

  it("caps repos at 100 per installation across multiple pages", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env

    function reposPage(page: number) {
      const repos = Array.from({ length: 100 }, (_, i) => ({
        full_name: `acme-corp/repo-${page}-${i}`,
        description: null,
      }))
      return new Response(JSON.stringify({ total_count: 250, repositories: repos }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat", name: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return new Response(
            JSON.stringify({ total_count: 1, installations: [{ id: 7, account: { login: "acme" } }] }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          )
        }
        const m = /page=(\d+)/.exec(url)
        return reposPage(m ? Number(m[1]) : 1)
      }),
    )

    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      installations: Array<{ repos: Array<{ fullName: string }> }>
    }
    expect(body.installations[0]!.repos.length).toBe(100)
  })

  it("soft-fails to an empty installations list when GitHub errors (never 500s the wizard)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    )
    const res = await handleOnboardingContextRoute(reqWithSession("https://x/v1/onboarding/context", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { login: string }; installations: unknown[] }
    expect(body.user.login).toBe("octocat") // falls back to the session's cached login
    expect(body.installations).toEqual([])
  })
})
