// github-user-token.ts — unit tests for the GitHub App user-token refresh that
// fixes the "session outlives the token → silent member/empty-feed" bug
// (sig-portal-bugs). Uses a REAL AES key + the real encrypt helper so the
// decrypt/refresh/persist round-trip is exercised end-to-end, with an injected
// fetch stub standing in for GitHub's refresh endpoint.

import { describe, expect, it, vi } from "vitest"
import { encryptAccessToken, base64urlEncode, type SessionRecord } from "@/src/lib/auth-session"
import { getValidGithubToken, parseGithubTokenSet } from "@/src/lib/github-user-token"

const KEY = base64urlEncode(new Uint8Array(32).fill(7)) // 32-byte AES-256 key

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** In-memory KV double capturing puts so we can assert the session was re-persisted. */
function makeKV() {
  const store = new Map<string, string>()
  return {
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k)
    }),
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    store,
  } as unknown as KVNamespace & { store: Map<string, string> }
}

function envWith(kv: KVNamespace) {
  return { OPENCLAW_STATE: kv, GITHUB_OAUTH_CLIENT_ID: "cid", GITHUB_OAUTH_CLIENT_SECRET: "secret" }
}

/** Build a session record whose access (and optional refresh) tokens are really encrypted. */
async function makeRecord(
  sessionId: string,
  opts: {
    accessToken: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    refreshTokenExpiresAt?: number
  },
): Promise<SessionRecord> {
  const access = await encryptAccessToken(opts.accessToken, sessionId, KEY)
  const record: SessionRecord = {
    login: "octocat",
    githubUserId: 1,
    encryptedAccessToken: access.ciphertext,
    iv: access.iv,
    createdAt: 0,
    lastSeenAt: 0,
  }
  if (opts.refreshToken !== undefined) {
    const refresh = await encryptAccessToken(opts.refreshToken, sessionId, KEY)
    record.encryptedRefreshToken = refresh.ciphertext
    record.refreshIv = refresh.iv
  }
  if (opts.accessTokenExpiresAt !== undefined) record.accessTokenExpiresAt = opts.accessTokenExpiresAt
  if (opts.refreshTokenExpiresAt !== undefined) record.refreshTokenExpiresAt = opts.refreshTokenExpiresAt
  return record
}

describe("parseGithubTokenSet", () => {
  it("resolves relative expiries into absolute ms-epoch", () => {
    const now = 1_000_000
    const set = parseGithubTokenSet(
      { access_token: "at", refresh_token: "rt", expires_in: 28800, refresh_token_expires_in: 15897600 },
      now,
    )
    expect(set).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      accessTokenExpiresAt: now + 28800 * 1000,
      refreshTokenExpiresAt: now + 15897600 * 1000,
    })
  })

  it("returns access-only (no expiry) when the App has expiration disabled", () => {
    expect(parseGithubTokenSet({ access_token: "at" }, 0)).toEqual({ accessToken: "at" })
  })

  it("returns null without an access token", () => {
    expect(parseGithubTokenSet({ error: "bad_verification_code" }, 0)).toBeNull()
  })
})

describe("getValidGithubToken", () => {
  it("returns the stored token unchanged for a legacy session (no expiry) — no refresh call", async () => {
    const kv = makeKV()
    const record = await makeRecord("s1", { accessToken: "legacy-token" })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const token = await getValidGithubToken({
      env: envWith(kv),
      sessionId: "s1",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    })
    expect(token).toBe("legacy-token")
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("returns the stored token when it is not yet expired — no refresh call", async () => {
    const kv = makeKV()
    const record = await makeRecord("s2", {
      accessToken: "fresh-token",
      refreshToken: "rt",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000, // 1h out
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const token = await getValidGithubToken({
      env: envWith(kv),
      sessionId: "s2",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    })
    expect(token).toBe("fresh-token")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refreshes an expired token, persists the rotation, and returns the new token", async () => {
    const kv = makeKV()
    const record = await makeRecord("s3", {
      accessToken: "dead-token",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1000, // expired
      refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("login/oauth/access_token")
      return jsonResponse({
        access_token: "new-token",
        refresh_token: "new-refresh",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      })
    }) as unknown as typeof fetch

    const token = await getValidGithubToken({
      env: envWith(kv),
      sessionId: "s3",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    })

    expect(token).toBe("new-token")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // Session re-persisted with the rotated material.
    expect(kv.put).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(kv.store.get("auth_session:s3")!) as SessionRecord
    expect(persisted.accessTokenExpiresAt).toBeGreaterThan(Date.now())
    // The plaintext tokens must never be stored — only ciphertext.
    const raw = kv.store.get("auth_session:s3")!
    expect(raw).not.toContain("new-token")
    expect(raw).not.toContain("new-refresh")
  })

  it("single-flights concurrent refreshes for the same expired session", async () => {
    const kv = makeKV()
    const record = await makeRecord("s3-race", {
      accessToken: "dead-token",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
      refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    let refreshCount = 0
    const fetchImpl = vi.fn(async () => {
      refreshCount += 1
      return jsonResponse({
        access_token: `new-token-${refreshCount}`,
        refresh_token: `new-refresh-${refreshCount}`,
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      })
    }) as unknown as typeof fetch

    const args = {
      env: envWith(kv),
      sessionId: "s3-race",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    }
    const tokens = await Promise.all([getValidGithubToken(args), getValidGithubToken(args)])

    expect(tokens).toEqual(["new-token-1", "new-token-1"])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it("shares a failed refresh fallback, clears it, and allows the next request to retry", async () => {
    const kv = makeKV()
    const record = await makeRecord("s3-retry", {
      accessToken: "stale-token",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
    })
    let shouldFail = true
    const fetchImpl = vi.fn(async () =>
      shouldFail
        ? jsonResponse({ error: "temporary_failure" }, 503)
        : jsonResponse({ access_token: "recovered-token", refresh_token: "rotated-refresh", expires_in: 28800 }),
    ) as unknown as typeof fetch
    const args = {
      env: envWith(kv),
      sessionId: "s3-retry",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    }

    const failedTokens = await Promise.all([getValidGithubToken(args), getValidGithubToken(args)])
    expect(failedTokens).toEqual(["stale-token", "stale-token"])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(kv.put).not.toHaveBeenCalled()

    shouldFail = false
    expect(await getValidGithubToken(args)).toBe("recovered-token")
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(kv.put).toHaveBeenCalledTimes(1)
  })

  it("refreshes different sessions independently", async () => {
    const kv = makeKV()
    const firstRecord = await makeRecord("s3-first", {
      accessToken: "first-stale",
      refreshToken: "first-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
    })
    const secondRecord = await makeRecord("s3-second", {
      accessToken: "second-stale",
      refreshToken: "second-refresh",
      accessTokenExpiresAt: Date.now() - 1000,
    })
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const refreshToken = (init?.body as URLSearchParams).get("refresh_token")
      return jsonResponse({ access_token: `${refreshToken}-access`, expires_in: 28800 })
    }) as unknown as typeof fetch

    const tokens = await Promise.all([
      getValidGithubToken({
        env: envWith(kv),
        sessionId: "s3-first",
        record: firstRecord,
        encryptionKeyB64url: KEY,
        fetchImpl,
      }),
      getValidGithubToken({
        env: envWith(kv),
        sessionId: "s3-second",
        record: secondRecord,
        encryptionKeyB64url: KEY,
        fetchImpl,
      }),
    ])

    expect(tokens).toEqual(["first-refresh-access", "second-refresh-access"])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(kv.put).toHaveBeenCalledTimes(2)
  })

  it("falls back to the stale token (never throws) when the refresh call fails", async () => {
    const kv = makeKV()
    const record = await makeRecord("s4", {
      accessToken: "stale-token",
      refreshToken: "rt",
      accessTokenExpiresAt: Date.now() - 1000,
    })
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "bad_refresh_token" }, 401)) as unknown as typeof fetch
    const token = await getValidGithubToken({
      env: envWith(kv),
      sessionId: "s4",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    })
    expect(token).toBe("stale-token")
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("does not refresh once the refresh token itself has expired", async () => {
    const kv = makeKV()
    const record = await makeRecord("s5", {
      accessToken: "stale-token",
      refreshToken: "rt",
      accessTokenExpiresAt: Date.now() - 1000,
      refreshTokenExpiresAt: Date.now() - 1000, // refresh token also dead
    })
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const token = await getValidGithubToken({
      env: envWith(kv),
      sessionId: "s5",
      record,
      encryptionKeyB64url: KEY,
      fetchImpl,
    })
    expect(token).toBe("stale-token")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("never logs a token during a refresh", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const kv = makeKV()
    const record = await makeRecord("s6", {
      accessToken: "dead",
      refreshToken: "old-refresh-secret",
      accessTokenExpiresAt: Date.now() - 1000,
    })
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ access_token: "brand-new-secret", refresh_token: "rot", expires_in: 28800 }),
    ) as unknown as typeof fetch
    await getValidGithubToken({ env: envWith(kv), sessionId: "s6", record, encryptionKeyB64url: KEY, fetchImpl })
    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map(String)
    for (const line of logged) {
      expect(line).not.toContain("brand-new-secret")
      expect(line).not.toContain("old-refresh-secret")
    }
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })
})
