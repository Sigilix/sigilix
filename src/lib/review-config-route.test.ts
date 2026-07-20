// sig-dashboard-review-config: GET|PUT /v1/org/:installationId/review-config —
// admin-gating, tenant-isolation, validation, and round-trip coverage. Session-
// only + per-installation admin gate (mirrors data-consent-route.test.ts).

import { afterEach, describe, expect, it, vi } from "vitest"
import { handleGetReviewConfig, handleSetReviewConfig } from "@/src/lib/review-config-route"
import { base64urlEncode, createSession, decryptAccessToken, getSession } from "@/src/lib/auth-session"
import { orgConfigKey } from "@/src/lib/review-config-store"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))

function makeKV(): { kv: KVNamespace; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    // `getSession` reads with the "json" type param — mirror the real KV so the
    // stored session record parses back to an object (not a raw string).
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
  return { kv, store }
}

async function seedSession(kv: KVNamespace, sessionId: string, login: string): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId: 111,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

/** Stub GitHub so `isAdminOfInstallation` sees the given installation + membership role. */
function stubGitHub(opts: {
  installations: Array<{ id: number; account: { type: string; login: string } }>
  memberships: Array<{ role: string; state: string; organization: { login: string } }>
  expectedAccessToken?: string
}): string[] {
  const seenAuthorizations: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: opts.expectedAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (opts.expectedAccessToken) {
        seenAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      }
      if (url.startsWith("https://api.github.com/user/installations")) {
        return new Response(
          JSON.stringify({ total_count: opts.installations.length, installations: opts.installations }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/memberships/orgs")) {
        return new Response(JSON.stringify(opts.memberships), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }),
  )
  return seenAuthorizations
}

function stubOrgAdmin(): void {
  stubGitHub({
    installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
    memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
  })
}

function req(method: string, installationId: string | number, sessionId: string | null, body?: string): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  if (body !== undefined) headers.set("content-type", "application/json")
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body
  return new Request(`https://x/v1/org/${installationId}/review-config`, init)
}

function baseEnv(kv: KVNamespace): Env {
  return { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("review-config route", () => {
  it("refreshes an expired GitHub token before the exact-installation admin write", async () => {
    const { kv } = makeKV()
    await createSession({
      kv,
      sessionId: "expired-session",
      login: "octocat",
      githubUserId: 111,
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60_000,
      encryptionKeyB64url: ENC_KEY,
    })
    const seenAuthorizations = stubGitHub({
      installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "admin", state: "active", organization: { login: "acme" } }],
      expectedAccessToken: "rotated-access",
    })
    const env = {
      ...baseEnv(kv),
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    } as Env

    const res = await handleSetReviewConfig(
      req("PUT", 42, "expired-session", JSON.stringify({ guidance: "keep exact installation scope" })),
      env,
      undefined,
      42,
    )

    expect(res.status).toBe(200)
    expect(seenAuthorizations).toEqual(["Bearer rotated-access", "Bearer rotated-access"])
    const persisted = await getSession({ kv, sessionId: "expired-session" })
    expect(persisted).not.toBeNull()
    await expect(
      decryptAccessToken(
        { encryptedAccessToken: persisted!.encryptedAccessToken, iv: persisted!.iv },
        "expired-session",
        ENC_KEY,
      ),
    ).resolves.toBe("rotated-access")
  })

  it("401 with no session", async () => {
    const { kv } = makeKV()
    const res = await handleGetReviewConfig(req("GET", 42, null), baseEnv(kv), undefined, 42)
    expect(res.status).toBe(401)
  })

  it("400 on a non-positive installation id", async () => {
    const { kv } = makeKV()
    const res = await handleGetReviewConfig(req("GET", 0, "s1"), baseEnv(kv), undefined, 0)
    expect(res.status).toBe(400)
  })

  it("admin of the org can PUT and then GET the round-tripped config", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const config = {
      guidance: "enforce X",
      profile: "chill",
      overview: {
        showSummary: false,
        showWalkthrough: true,
        showSequenceDiagram: false,
        showConfidence: true,
      },
      preMergeGates: {
        titleFormat: { enabled: false },
        descriptionCompleteness: { enabled: true },
        linkedIssue: { enabled: false },
      },
    }
    const put = await handleSetReviewConfig(req("PUT", 42, "s1", JSON.stringify(config)), baseEnv(kv), undefined, 42)
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { config: unknown }
    expect(putBody.config).toEqual(config)

    const get = await handleGetReviewConfig(req("GET", 42, "s1"), baseEnv(kv), undefined, 42)
    expect(get.status).toBe(200)
    const getBody = (await get.json()) as { config: unknown }
    expect(getBody.config).toEqual(config)
  })

  it("ADMIN-GATE: a member (non-admin) is 403'd on both PUT and GET", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubGitHub({
      installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
      memberships: [{ role: "member", state: "active", organization: { login: "acme" } }],
    })
    const put = await handleSetReviewConfig(
      req("PUT", 42, "s1", JSON.stringify({ guidance: "x" })),
      baseEnv(kv),
      undefined,
      42,
    )
    expect(put.status).toBe(403)
    expect(store.has(orgConfigKey(42))).toBe(false)
    const get = await handleGetReviewConfig(req("GET", 42, "s1"), baseEnv(kv), undefined, 42)
    expect(get.status).toBe(403)
  })

  it("TENANT ISOLATION: an admin of org A cannot PUT config for an install they can't see", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    // The caller's token only sees install 42 — not 999 → isAdminOfInstallation false → 403.
    stubOrgAdmin()
    const res = await handleSetReviewConfig(
      req("PUT", 999, "s1", JSON.stringify({ guidance: "pwn" })),
      baseEnv(kv),
      undefined,
      999,
    )
    expect(res.status).toBe(403)
    expect(store.has(orgConfigKey(999))).toBe(false)
  })

  it("validation: malformed config body is rejected with 400 + reason, nothing stored", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const res = await handleSetReviewConfig(req("PUT", 42, "s1", "{ broken json"), baseEnv(kv), undefined, 42)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; reason?: string }
    expect(body.error).toBe("invalid config")
    expect(body.reason).toBeTruthy()
    // Nothing persisted under the config key (the session record is the only other entry).
    expect(store.has(orgConfigKey(42))).toBe(false)
  })

  it("validation: unknown top-level and nested fields are rejected, never silently ignored", async () => {
    const { kv, store } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()

    const unsupported = await handleSetReviewConfig(
      req("PUT", 42, "s1", JSON.stringify({ pathFilters: ["src/auth/**"] })),
      baseEnv(kv),
      undefined,
      42,
    )
    expect(unsupported.status).toBe(400)
    expect(await unsupported.json()).toMatchObject({
      error: "invalid config",
      reason: "unknown dashboard config field `pathFilters`",
    })

    const nestedNoOp = await handleSetReviewConfig(
      req("PUT", 42, "s1", JSON.stringify({ overview: { enabled: false } })),
      baseEnv(kv),
      undefined,
      42,
    )
    expect(nestedNoOp.status).toBe(400)
    expect(await nestedNoOp.json()).toMatchObject({
      error: "invalid config",
      reason: "unknown dashboard config field `overview.enabled`",
    })
    expect(store.has(orgConfigKey(42))).toBe(false)
  })

  it("415 on PUT without application/json content-type (CSRF guard)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const headers = new Headers({ cookie: `${SESSION_COOKIE}=s1` }) // no content-type
    const request = new Request("https://x/v1/org/42/review-config", {
      method: "PUT",
      headers,
      body: JSON.stringify({ guidance: "x" }),
    })
    const res = await handleSetReviewConfig(request, baseEnv(kv), undefined, 42)
    expect(res.status).toBe(415)
  })

  it("503 when the session-encryption key is missing (fails closed, never open)", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    const env = { OPENCLAW_STATE: kv } as unknown as Env // no OPENCLAW_SESSION_ENCRYPTION_KEY
    const res = await handleSetReviewConfig(req("PUT", 42, "s1", JSON.stringify({ guidance: "x" })), env, undefined, 42)
    expect(res.status).toBe(503)
  })

  it("400 on a malformed repoId query param", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const request = new Request("https://x/v1/org/42/review-config?repoId=notavalidrepo", {
      method: "GET",
      headers: { cookie: `${SESSION_COOKIE}=s1` },
    })
    const res = await handleGetReviewConfig(request, baseEnv(kv), undefined, 42)
    expect(res.status).toBe(400)
  })

  it("repo-scoped PUT/GET round-trips under a distinct scope from org", async () => {
    const { kv } = makeKV()
    await seedSession(kv, "s1", "octocat")
    stubOrgAdmin()
    const put = await handleSetReviewConfig(
      new Request("https://x/v1/org/42/review-config?repoId=acme/app", {
        method: "PUT",
        headers: { cookie: `${SESSION_COOKIE}=s1`, "content-type": "application/json" },
        body: JSON.stringify({ guidance: "repo-scoped" }),
      }),
      baseEnv(kv),
      undefined,
      42,
    )
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as { scope: { level: string; repoId?: string } }
    expect(putBody.scope).toEqual({ level: "repo", repoId: "acme/app" })
    // Org scope stays empty.
    const orgGet = await handleGetReviewConfig(req("GET", 42, "s1"), baseEnv(kv), undefined, 42)
    const orgBody = (await orgGet.json()) as { config: Record<string, unknown> }
    expect(orgBody.config).toEqual({})
  })
})
