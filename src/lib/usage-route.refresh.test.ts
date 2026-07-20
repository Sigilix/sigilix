import { afterEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleUsageRoute } from "@/src/lib/usage-route"
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("usage route session token refresh", () => {
  it("refreshes an expired GitHub token before resolving the usage scope", async () => {
    const kv = makeKV()
    await createSession({
      kv,
      sessionId: "expired-session",
      userId: "user-111",
      login: "Octocat",
      githubUserId: 111,
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60_000,
      encryptionKeyB64url: ENC_KEY,
    })
    const seenAuthorizations: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(
            JSON.stringify({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 28_800,
              refresh_token_expires_in: 15_897_600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (url.startsWith("https://api.github.com/user/installations?")) {
          seenAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
          return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 1 }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    } as unknown as Env
    const request = new Request("https://x/v1/usage", {
      headers: { cookie: `${SESSION_COOKIE}=expired-session` },
    })

    const res = await handleUsageRoute(request, env)

    expect(res.status).toBe(200)
    expect(seenAuthorizations).toEqual(["Bearer rotated-access"])
  })
})
