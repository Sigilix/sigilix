import { describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleAuthSessionProbeRoute } from "@/src/lib/auth-session-probe-route"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(4))

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

describe("handleAuthSessionProbeRoute", () => {
  it("returns 401 without a live session", async () => {
    const env = { OPENCLAW_STATE: makeKV() } as unknown as Env
    const res = await handleAuthSessionProbeRoute(new Request("https://x/auth/session"), env)
    expect(res.status).toBe(401)
  })

  it("returns stored identity without decrypting a provider token or calling GitHub", async () => {
    const kv = makeKV()
    await createSession({
      kv,
      sessionId: "sess-1",
      login: "octocat",
      githubUserId: 111,
      accessToken: "ghu_test_token",
      encryptionKeyB64url: ENC_KEY,
    })
    const githubFetch = vi.spyOn(globalThis, "fetch")
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleAuthSessionProbeRoute(
      new Request("https://x/auth/session", { headers: { cookie: `${SESSION_COOKIE}=sess-1` } }),
      env,
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: {
        login: "octocat",
        name: null,
        githubUserId: 111,
        userId: null,
        email: null,
        provider: "github",
      },
    })
    expect(githubFetch).not.toHaveBeenCalled()
    githubFetch.mockRestore()
  })
})
