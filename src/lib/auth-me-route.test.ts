// GET /auth/me — integration tests. Seeds a real encrypted session (via
// createSession, mirroring auth-setup-route.test.ts) and stubs global
// fetch to control GitHub's installations/membership responses, exercising
// the route through its real path: requireSession → decryptAccessToken →
// resolveUserRole → JSON response.

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleAuthMeRoute } from "@/src/lib/auth-me-route"
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

async function seedSession(kv: KVNamespace, sessionId: string, login: string, githubUserId: number): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

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
    const body = (await res.json()) as { login: string; githubUserId: number; role: string }
    expect(body).toEqual({ login: "octocat", githubUserId: 111, role: "admin" })
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
    const body = (await res.json()) as { login: string; githubUserId: number; role: string }
    expect(body).toEqual({ login: "octocat", githubUserId: 111, role: "member" })
  })

  it("falls back to role=member when the session encryption key is missing (never 500s)", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    await seedSession(kv, "sess-1", "octocat", 111)

    const res = await handleAuthMeRoute(reqWithSession("https://x/auth/me", "sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { login: string; githubUserId: number; role: string }
    expect(body).toEqual({ login: "octocat", githubUserId: 111, role: "member" })
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
    const body = (await res.json()) as { login: string; githubUserId: number; role: string }
    expect(body).toEqual({ login: "octocat", githubUserId: 111, role: "member" })
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
