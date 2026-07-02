// #155 onboarding-backend slice 3 — POST /v1/onboarding tests.

import { describe, expect, it } from "vitest"
import { handleOnboardingSubmitRoute } from "@/src/lib/onboarding-submit-route"
import type { SessionRecord } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"

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
  const record: SessionRecord = {
    login: "octocat",
    githubUserId,
    encryptedAccessToken: "unused-in-these-tests",
    iv: "unused",
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  }
  await kv.put(`auth_session:${sessionId}`, JSON.stringify(record))
}

function reqWithSession(url: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  // Default to application/json for a POST body unless the test explicitly
  // overrides it (the 415 CSRF-guard test below does) — every real call site
  // sends JSON, and the route now requires it (SIG-155 slice 3).
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  return new Request(url, { ...init, headers })
}

describe("handleOnboardingSubmitRoute (POST /v1/onboarding)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", null, { method: "POST", body: "{}" }),
      env,
    )
    expect(res.status).toBe(401)
  })

  it("stores the payload in KV keyed by githubUserId and returns {ok:true}", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const payload = { fullName: "Ada Lovelace", companySize: "1-10", ts: 1700000000000 }
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", { method: "POST", body: JSON.stringify(payload) }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const stored = await kv.get("onboarding:111", "json")
    expect(stored).toEqual(payload)
  })

  it("last-write-wins on a second submission", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        body: JSON.stringify({ fullName: "First" }),
      }),
      env,
    )
    await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        body: JSON.stringify({ fullName: "Second" }),
      }),
      env,
    )
    const stored = await kv.get("onboarding:111", "json")
    expect(stored).toEqual({ fullName: "Second" })
  })

  it("415 (CSRF guard) when Content-Type is not application/json — SIG-155 slice 3 (SameSite=None mitigation)", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ conventions: "x" }),
      }),
      env,
    )
    expect(res.status).toBe(415)
  })

  it("400 on invalid JSON", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", { method: "POST", body: "not json" }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("400 when a present field has the wrong type", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        body: JSON.stringify({ challenges: "not-an-array" }),
      }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("400 when a link entry is missing a required field", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        body: JSON.stringify({ links: [{ from: "api", label: "calls" }] }),
      }),
      env,
    )
    expect(res.status).toBe(400)
  })

  it("413 when the body exceeds the size cap", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const big = "x".repeat(40 * 1024)
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", {
        method: "POST",
        body: JSON.stringify({ conventions: big }),
      }),
      env,
    )
    expect(res.status).toBe(413)
  })

  it("accepts a well-typed full payload including links[]", async () => {
    const kv = makeKV()
    await seedSession(kv, "sess-1", 111)
    const env = { OPENCLAW_STATE: kv } as unknown as Env
    const payload = {
      fullName: "Ada",
      challenges: ["scale", "onboarding"],
      companySize: "11-50",
      hearAbout: "twitter",
      selectedRepos: ["acme/api"],
      repoDescriptions: { "acme/api": "The API" },
      links: [{ from: "acme/api", label: "calls", to: "acme/worker" }],
      conventions: "Use conventional commits.",
      model: "boreas",
      sceneId: "scene-1",
      ts: 1700000000000,
    }
    const res = await handleOnboardingSubmitRoute(
      reqWithSession("https://x/v1/onboarding", "sess-1", { method: "POST", body: JSON.stringify(payload) }),
      env,
    )
    expect(res.status).toBe(200)
    const stored = await kv.get("onboarding:111", "json")
    expect(stored).toEqual(payload)
  })
})
