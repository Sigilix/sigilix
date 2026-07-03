// GET /auth/me — integration tests. Seeds a real encrypted session (via
// createSession, mirroring auth-setup-route.test.ts) and stubs global
// fetch to control GitHub's installations/membership responses, exercising
// the route through its real path: requireSession → decryptAccessToken →
// resolveUserRole → JSON response.

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleAuthMeRoute } from "@/src/lib/auth-me-route"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
// 32-byte AES-256 key (base64url), matching the production secret shape.
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

async function seedSession(
  kv: KVNamespace,
  sessionId: string,
  login: string,
  githubUserId: number,
  name?: string,
): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
    ...(name !== undefined ? { name } : {}),
  })
}

interface MeBody {
  user: {
    login: string
    name: string | null
    githubUserId: number | null
    userId: string | null
    email: string | null
    provider: string
    role: string
  }
}

// sig-user-identity: sessions seeded via createSession here set no userId/email/
// provider, so /auth/me fills them with the documented defaults.
const IDENTITY_DEFAULTS = { userId: null, email: null, provider: "github" } as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function reqWithSession(url: string, sessionId: string | null): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleAuthMeRoute (GET /auth/me)", () => {
  it("401s when there is no session", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", null), env)
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe("unauthenticated")
  })

  it("returns login, githubUserId, and role=admin for a personal-install owner", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          total_count: 1,
          installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
        }),
      ),
    )

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: null, githubUserId: 111, ...IDENTITY_DEFAULTS, role: "admin" },
    })
  })

  it("falls back to role=member when GitHub is unreachable (never 500s)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: null, githubUserId: 111, ...IDENTITY_DEFAULTS, role: "member" },
    })
  })

  it("falls back to role=member when the session encryption key is missing (never 500s)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: null, githubUserId: 111, ...IDENTITY_DEFAULTS, role: "member" },
    })
  })

  it("falls back to role=member when the token fails to decrypt (never 500s)", async () => {
    const kv = makeKV()
    // Seed with ENC_KEY, then read back with a different key so
    // decryptAccessToken's AES-GCM AAD check fails — an independent failure
    // mode from the "key missing" case above.
    const wrongKey = base64urlEncode(new Uint8Array(32).fill(9))
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: wrongKey } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: null, githubUserId: 111, ...IDENTITY_DEFAULTS, role: "member" },
    })
  })

  it("returns the GitHub display name nested under `user` when the session has one", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111, "Octo Cat")

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          total_count: 1,
          installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
        }),
      ),
    )

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: "Octo Cat", githubUserId: 111, ...IDENTITY_DEFAULTS, role: "admin" },
    })
  })

  // #155 onboarding: the portal reads /auth/me cross-origin with
  // credentials:include, so the response MUST carry credentialed CORS headers
  // (echoed origin + allow-credentials) or the browser blocks the portal from
  // reading it — silently breaking the setup-wizard session bootstrap. These
  // drive the REAL worker entrypoint (index.ts) to prove the wrapping is wired,
  // mirroring org-overview-route.test.ts's CORS-path coverage.
  it("carries credentialed CORS headers for an allowlisted portal origin (via the worker entrypoint)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    await seedSession(kv, "sess-1", "octocat", 111)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          total_count: 1,
          installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
        }),
      ),
    )

    const req = new Request("https://x/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=sess-1`, origin: "https://app.sigilix.ai" },
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.sigilix.ai")
    expect(res.headers.get("access-control-allow-credentials")).toBe("true")
    const body = (await res.json()) as MeBody
    expect(body).toEqual({
      user: { login: "octocat", name: null, githubUserId: 111, ...IDENTITY_DEFAULTS, role: "admin" },
    })
  })

  it("does NOT echo an Access-Control-Allow-Origin for a non-allowlisted origin (via the worker entrypoint)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    await seedSession(kv, "sess-1", "octocat", 111)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )

    const req = new Request("https://x/auth/me", {
      headers: { cookie: `${SESSION_COOKIE}=sess-1`, origin: "https://evil.example.com" },
    })
    const res = await worker.fetch(req, env, ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    // Vary: Origin is always appended so a shared cache never leaks one
    // origin's (absent) CORS grant to another.
    expect(res.headers.get("vary")?.toLowerCase()).toContain("origin")
  })

  it("never includes the access token in any logged output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          total_count: 1,
          installations: [{ id: 1, account: { type: "User", login: "octocat" } }],
        }),
      ),
    )

    await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)

    const allLoggedArgs = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat()
    for (const arg of allLoggedArgs) {
      expect(String(arg)).not.toContain("ghu_test_token")
    }
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
