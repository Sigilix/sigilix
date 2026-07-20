// sig-pr-interface-fixes — GET /v1/workspace/prs/:installationId/:repo/:number/review tests.
// Mirrors workspace-prs-route.test.ts's session/api-key + fetch-stub style.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  handleWorkspacePrReviewRoute,
  parseReviewPath,
  groupReviewComments,
  latestReviewSummary,
  pickOverviewComment,
} from "@/src/lib/workspace-pr-review-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const BOT = "sigilix[bot]"

const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

function makeKV(seed: Record<string, unknown> = {}): KVNamespace {
  const store = new Map<string, string>()
  for (const [k, v] of Object.entries(seed)) store.set(k, JSON.stringify(v))
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

/** Pre-seed the installation-token cache so the handler mints no JWT. */
function tokenCache(installationId: number, token = "inst-token"): Record<string, unknown> {
  return { [`gh-installation-token:${installationId}`]: { token, expiresAt: Date.now() + 3_600_000 } }
}

async function seedSession(
  kv: KVNamespace,
  sessionId: string,
  login: string,
  tokens: {
    accessToken?: string
    refreshToken?: string
    accessTokenExpiresAt?: number
    refreshTokenExpiresAt?: number
  } = {},
): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login,
    githubUserId: 1,
    accessToken: tokens.accessToken ?? "ghu_test",
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.accessTokenExpiresAt !== undefined ? { accessTokenExpiresAt: tokens.accessTokenExpiresAt } : {}),
    ...(tokens.refreshTokenExpiresAt !== undefined ? { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt } : {}),
    encryptionKeyB64url: ENC_KEY,
  })
}

function reqSession(sessionId: string, path: string): Request {
  return new Request(`https://x${path}`, { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } })
}

function reqBearer(token: string, path: string): Request {
  return new Request(`https://x${path}`, { headers: { authorization: `Bearer ${token}` } })
}

const REVIEW_PATH = `/v1/workspace/prs/1/${encodeURIComponent("acme/api")}/42/review`

function baseEnv(kv: KVNamespace, db?: D1Database): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "unused-because-token-is-cached",
    ...(db ? { SIGILIX_PLATFORM_DB: db } : {}),
  } as unknown as Env
}

/** Stub GitHub: installations listing + PR inline comments + PR reviews + issue comments. */
function stubGithub(opts: {
  installationIds?: number[]
  comments?: unknown[]
  reviews?: unknown[]
  issueComments?: unknown[]
  expectedUserAccessToken?: string
}): string[] {
  const seenUserAuthorizations: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: opts.expectedUserAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/user/installations?")) {
        if (opts.expectedUserAccessToken) {
          seenUserAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
        }
        const ids = opts.installationIds ?? [1]
        return new Response(JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }), {
          status: 200,
        })
      }
      if (/\/pulls\/42\/comments/.test(url)) {
        return new Response(JSON.stringify(opts.comments ?? []), { status: 200 })
      }
      if (/\/pulls\/42\/reviews/.test(url)) {
        return new Response(JSON.stringify(opts.reviews ?? []), { status: 200 })
      }
      if (/\/issues\/42\/comments/.test(url)) {
        return new Response(JSON.stringify(opts.issueComments ?? []), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return seenUserAuthorizations
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseReviewPath", () => {
  it("parses an encoded owner/repo segment", () => {
    expect(parseReviewPath(REVIEW_PATH)).toEqual({ installationId: 1, owner: "acme", repo: "api", prNumber: 42 })
  })
  it("rejects a non-workspace path, missing /review, or non-numeric ids", () => {
    expect(parseReviewPath("/v1/workspace/prs")).toBeNull()
    expect(parseReviewPath(`/v1/workspace/prs/1/${encodeURIComponent("acme/api")}/42`)).toBeNull()
    expect(parseReviewPath(`/v1/workspace/prs/abc/${encodeURIComponent("acme/api")}/42/review`)).toBeNull()
    expect(parseReviewPath(`/v1/workspace/prs/1/${encodeURIComponent("noslash")}/42/review`)).toBeNull()
  })
})

describe("groupReviewComments", () => {
  it("filters to the Sigilix bot and groups by file, first-seen order, with line fallback", () => {
    const files = groupReviewComments([
      { id: 1, path: "a.ts", line: 10, body: "P1 bug", diff_hunk: "@@", user: { login: BOT } },
      { id: 2, path: "a.ts", original_line: 20, body: "note", user: { login: BOT } },
      { id: 3, path: "b.ts", line: 5, body: "human", user: { login: "someone" } },
      { id: 4, path: "b.ts", line: 6, body: "bot-b", user: { login: BOT } },
    ])
    expect(files).toEqual([
      {
        path: "a.ts",
        comments: [
          { id: 1, line: 10, body: "P1 bug", diffHunk: "@@" },
          { id: 2, line: 20, body: "note", diffHunk: null },
        ],
      },
      { path: "b.ts", comments: [{ id: 4, line: 6, body: "bot-b", diffHunk: null }] },
    ])
  })
})

describe("latestReviewSummary", () => {
  it("returns the bot's most recent non-empty review, ignoring humans + empty bodies", () => {
    expect(
      latestReviewSummary([
        { id: 1, state: "COMMENTED", body: "old", submitted_at: "2026-06-01T00:00:00Z", user: { login: BOT } },
        { id: 2, state: "APPROVED", body: "", submitted_at: "2026-06-03T00:00:00Z", user: { login: BOT } },
        { id: 3, state: "CHANGES_REQUESTED", body: "new", submitted_at: "2026-06-02T00:00:00Z", user: { login: BOT } },
        { id: 4, state: "COMMENTED", body: "human", submitted_at: "2026-06-09T00:00:00Z", user: { login: "x" } },
      ]),
    ).toEqual({ id: 3, state: "CHANGES_REQUESTED", body: "new" })
  })
  it("returns null when the bot has no non-empty review", () => {
    expect(latestReviewSummary([{ id: 1, state: "APPROVED", body: "", user: { login: BOT } }])).toBeNull()
  })
  it("skips a SIG-471 marker-only review body (never re-exposes the raw marker on the fallback)", () => {
    expect(
      latestReviewSummary([
        {
          id: 1,
          state: "APPROVED",
          body: "<!-- sigilix:pr-review -->\n",
          submitted_at: "2026-06-03T00:00:00Z",
          user: { login: BOT },
        },
      ]),
    ).toBeNull()
  })
})

describe("pickOverviewComment", () => {
  const OVERVIEW = "<!-- sigilix:pr-overview -->\n\n## Sigilix Overview\n\n### Summary\n\nDoes the thing."
  it("picks the bot's overview sticky (state OVERVIEW), ignoring humans + non-overview comments", () => {
    expect(
      pickOverviewComment([
        { id: 1, body: "just a chat comment", updated_at: "2026-06-01T00:00:00Z", user: { login: BOT } },
        {
          id: 2,
          body: "human overview? <!-- sigilix:pr-overview -->",
          updated_at: "2026-06-09T00:00:00Z",
          user: { login: "x" },
        },
        { id: 3, body: OVERVIEW, updated_at: "2026-06-02T00:00:00Z", user: { login: BOT } },
      ]),
    ).toEqual({ id: 3, state: "OVERVIEW", body: OVERVIEW })
  })
  it("matches the legacy openclaw marker and keeps the most recently updated on duplicates", () => {
    const legacy = "<!-- openclaw:pr-overview -->\n\n## Sigilix Overview\n\nlegacy"
    const fresh = "<!-- sigilix:pr-overview -->\n\n## Sigilix Overview\n\nfresh"
    expect(
      pickOverviewComment([
        { id: 1, body: legacy, updated_at: "2026-06-01T00:00:00Z", user: { login: BOT } },
        { id: 2, body: fresh, updated_at: "2026-06-05T00:00:00Z", user: { login: BOT } },
      ]),
    ).toEqual({ id: 2, state: "OVERVIEW", body: fresh })
  })
  it("returns null when no overview sticky exists", () => {
    expect(pickOverviewComment([{ id: 1, body: "hi", user: { login: BOT } }])).toBeNull()
  })
})

describe("handleWorkspacePrReviewRoute", () => {
  it("refreshes an expired GitHub token before checking installation ownership", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "expired-session", "octocat", {
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: Date.now() - 1_000,
      refreshTokenExpiresAt: Date.now() + 60_000,
    })
    const seenUserAuthorizations = stubGithub({ installationIds: [1], expectedUserAccessToken: "rotated-access" })
    const env = {
      ...baseEnv(kv),
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    } as Env

    const res = await handleWorkspacePrReviewRoute(reqSession("expired-session", REVIEW_PATH), env)

    expect(res.status).toBe(200)
    expect(seenUserAuthorizations).toEqual(["Bearer rotated-access"])
  })

  it("404 on a malformed path", async () => {
    const res = await handleWorkspacePrReviewRoute(new Request("https://x/v1/workspace/prs/bad"), baseEnv(makeKV()))
    expect(res.status).toBe(404)
  })

  it("401 with neither a session nor a bearer api key", async () => {
    const res = await handleWorkspacePrReviewRoute(new Request(`https://x${REVIEW_PATH}`), baseEnv(makeKV()))
    expect(res.status).toBe(401)
  })

  it("session path: 403 when the caller does not own the installation", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "sess-1", "octocat")
    stubGithub({ installationIds: [2] }) // owns 2, not 1
    const res = await handleWorkspacePrReviewRoute(reqSession("sess-1", REVIEW_PATH), baseEnv(kv))
    expect(res.status).toBe(403)
  })

  it("session path: 200 with the bot's review stack grouped by file", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "sess-1", "octocat")
    stubGithub({
      installationIds: [1],
      comments: [
        { id: 11, path: "src/a.ts", line: 3, body: "P1: nul deref", diff_hunk: "@@ hunk", user: { login: BOT } },
        { id: 12, path: "src/a.ts", line: 9, body: "style", user: { login: BOT } },
        { id: 13, path: "src/b.ts", line: 1, body: "coderabbit note", user: { login: "coderabbitai[bot]" } },
      ],
      reviews: [
        {
          id: 90,
          state: "CHANGES_REQUESTED",
          body: "1 blocking finding",
          submitted_at: "2026-06-02T00:00:00Z",
          user: { login: BOT },
        },
      ],
    })
    const res = await handleWorkspacePrReviewRoute(reqSession("sess-1", REVIEW_PATH), baseEnv(kv))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      installationId: number
      repo: string
      prNumber: number
      summary: { body: string } | null
      files: Array<{ path: string; comments: Array<{ id: number }> }>
    }
    expect(body).toMatchObject({ installationId: 1, repo: "acme/api", prNumber: 42 })
    expect(body.summary?.body).toBe("1 blocking finding")
    // Only the bot's comments, grouped to one file (b.ts was CodeRabbit → dropped).
    expect(body.files).toEqual([
      {
        path: "src/a.ts",
        comments: [
          { id: 11, line: 3, body: "P1: nul deref", diffHunk: "@@ hunk" },
          { id: 12, line: 9, body: "style", diffHunk: null },
        ],
      },
    ])
  })

  it("session path: prefers the overview sticky over the review-submission body", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "sess-1", "octocat")
    const overviewBody = "<!-- sigilix:pr-overview -->\n\n## Sigilix Overview\n\n### Summary\n\nThe real overview."
    stubGithub({
      installationIds: [1],
      // SIG-471: the review-submission body is gutted to just the marker.
      reviews: [
        {
          id: 90,
          state: "APPROVED",
          body: "<!-- sigilix:pr-review -->\n",
          submitted_at: "2026-06-02T00:00:00Z",
          user: { login: BOT },
        },
      ],
      issueComments: [{ id: 500, body: overviewBody, updated_at: "2026-06-02T00:00:00Z", user: { login: BOT } }],
    })
    const res = await handleWorkspacePrReviewRoute(reqSession("sess-1", REVIEW_PATH), baseEnv(kv))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: { state: string; body: string } | null }
    expect(body.summary).toEqual({ id: 500, state: "OVERVIEW", body: overviewBody })
  })

  it("api-key path: 403 when the key's installation differs from the requested one", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_API_KEY_SQL)
    const kv = makeKV(tokenCache(1))
    const key = "tenant-key-abc-123456"
    await insertApiKey(db, {
      id: "k1",
      keyHash: await sha256Hex(key),
      installationId: 999,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00.000Z",
    })
    stubGithub({})
    const res = await handleWorkspacePrReviewRoute(reqBearer(key, REVIEW_PATH), baseEnv(kv, db))
    expect(res.status).toBe(403)
  })

  it("503 when the GitHub App is not configured", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "sess-1", "octocat")
    stubGithub({ installationIds: [1] })
    const env = { OPENCLAW_STATE: kv, OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY } as unknown as Env
    const res = await handleWorkspacePrReviewRoute(reqSession("sess-1", REVIEW_PATH), env)
    expect(res.status).toBe(503)
  })

  it("502 when GitHub returns an error for the comments fetch", async () => {
    const kv = makeKV(tokenCache(1))
    await seedSession(kv, "sess-1", "octocat")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.startsWith("https://api.github.com/user/installations?")) {
          return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 1 }] }), { status: 200 })
        }
        return new Response("boom", { status: 500 })
      }),
    )
    const res = await handleWorkspacePrReviewRoute(reqSession("sess-1", REVIEW_PATH), baseEnv(kv))
    expect(res.status).toBe(502)
  })
})
