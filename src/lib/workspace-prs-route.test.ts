// sig-workspace-prs — GET /v1/workspace/prs tests.
// Mirrors onboarding-context-route.test.ts's fetch-stubbing style for GitHub
// calls, and api-key-resolver.test.ts's D1 seeding style for the api-key path.

import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleWorkspacePrsRoute } from "@/src/lib/workspace-prs-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { LEGACY_TENANT_INSTALLATION_ID } from "@/src/lib/api-key-resolver"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const GLOBAL_KEY = "global-shared-secret-token"

const MIGRATION_USAGE_SQL = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_API_KEY_SQL = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

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

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIGRATION_USAGE_SQL)
  await db.exec(MIGRATION_API_KEY_SQL)
  return db
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

/** repo.installation_id FK-references tenant(installation_id) — seed the tenant row first. */
async function insertTenant(db: D1Database, installationId: number) {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, created_at, updated_at)" +
        " VALUES (?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')" +
        " ON CONFLICT(installation_id) DO NOTHING",
    )
    .bind(installationId)
    .run()
}

async function insertRepo(db: D1Database, repoId: number, installationId: number, fullName: string) {
  await insertTenant(db, installationId)
  await db
    .prepare(
      "INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
    )
    .bind(repoId, installationId, fullName)
    .run()
}

async function insertUsage(
  db: D1Database,
  args: {
    installationId: number
    repoId: number
    prNumber: number
    headSha: string
    authorLogin: string | null
    createdAt: string
  },
) {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, 1, 100, ?, ?)",
    )
    .bind(args.installationId, args.repoId, args.prNumber, args.headSha, args.authorLogin, args.createdAt)
    .run()
}

function reqWithSession(sessionId: string | null): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request("https://x/v1/workspace/prs", { headers })
}

function reqWithBearer(token: string): Request {
  return new Request("https://x/v1/workspace/prs", { headers: { authorization: `Bearer ${token}` } })
}

function stubInstallations(installationIds: number[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(
          JSON.stringify({
            total_count: installationIds.length,
            installations: installationIds.map((id) => ({ id, account: { login: "acme" } })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleWorkspacePrsRoute (GET /v1/workspace/prs)", () => {
  it("401 with neither a session nor a bearer api key", async () => {
    const db = await makeDb()
    const kv = makeKV()
    const env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db, OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY } as unknown as Env
    const res = await handleWorkspacePrsRoute(reqWithSession(null), env)
    expect(res.status).toBe(401)
  })

  describe("session path", () => {
    it("splits org/mine, case-insensitively, collapses repeat reviews to the latest, newest-first", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "Octocat", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env
      stubInstallations([1])

      await insertRepo(db, 100, 1, "acme/api")
      // PR #1 authored by the session user (different casing) — reviewed twice.
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 1,
        headSha: "sha-old",
        authorLogin: "OCTOCAT",
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 1,
        headSha: "sha-new",
        authorLogin: "OCTOCAT",
        createdAt: "2026-06-03T00:00:00.000Z",
      })
      // PR #2 authored by someone else — reviewed once.
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 2,
        headSha: "sha-other",
        authorLogin: "someone-else",
        createdAt: "2026-06-02T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        org: Array<{ repo: string; prNumber: number; headSha: string; reviews: number; url: string }>
        mine: Array<{ prNumber: number }>
      }

      // org: both PRs, newest-first (PR #1's latest review is newer than PR #2's).
      expect(body.org.map((p) => p.prNumber)).toEqual([1, 2])
      expect(body.org[0]).toMatchObject({
        repo: "acme/api",
        prNumber: 1,
        headSha: "sha-new",
        reviews: 2,
        url: "https://github.com/acme/api/pull/1",
      })

      // mine: only PR #1, matched case-insensitively against the session login "Octocat".
      expect(body.mine.map((p) => p.prNumber)).toEqual([1])
    })

    it("attaches installationId + a GitHub-resolved author (avatar + id) to each row, incl. bot authors", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "octocat", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env

      // Serve both the installations listing and the per-author lookups. The
      // bot login (`sigilix[bot]`) resolves to a `.../in/<app_id>` avatar — the
      // exact case the login-based `github.com/<login>.png` URL 404s on.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString()
          if (url.startsWith("https://api.github.com/user/installations?")) {
            return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 1 }] }), { status: 200 })
          }
          const userMatch = /https:\/\/api\.github\.com\/users\/([^?]+)/.exec(url)
          if (userMatch) {
            const login = decodeURIComponent(userMatch[1]!)
            if (login === "sigilix[bot]") {
              return new Response(
                JSON.stringify({
                  login: "sigilix[bot]",
                  id: 280779545,
                  avatar_url: "https://avatars.githubusercontent.com/in/3558711?v=4",
                }),
                { status: 200 },
              )
            }
            return new Response(
              JSON.stringify({
                login: "octocat",
                id: 583231,
                avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
              }),
              { status: 200 },
            )
          }
          throw new Error(`unexpected fetch: ${url}`)
        }),
      )

      await insertRepo(db, 100, 1, "acme/api")
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 7,
        headSha: "sha-bot",
        authorLogin: "sigilix[bot]",
        createdAt: "2026-06-05T00:00:00.000Z",
      })
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 8,
        headSha: "sha-human",
        authorLogin: "octocat",
        createdAt: "2026-06-04T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        org: Array<{
          installationId: number
          authorLogin: string
          author: { login: string | null; avatar_url: string | null; id: number | null }
        }>
      }
      const bot = body.org.find((p) => p.authorLogin === "sigilix[bot]")!
      expect(bot.installationId).toBe(1)
      expect(bot.author).toEqual({
        login: "sigilix[bot]",
        avatar_url: "https://avatars.githubusercontent.com/in/3558711?v=4",
        id: 280779545,
      })
      const human = body.org.find((p) => p.authorLogin === "octocat")!
      expect(human.author.avatar_url).toBe("https://avatars.githubusercontent.com/u/583231?v=4")
      expect(human.author.id).toBe(583231)
    })

    it("degrades to a login-only author (null avatar/id) when the GitHub user lookup fails", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "octocat", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input.toString()
          if (url.startsWith("https://api.github.com/user/installations?")) {
            return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 1 }] }), { status: 200 })
          }
          return new Response("not found", { status: 404 })
        }),
      )

      await insertRepo(db, 100, 1, "acme/api")
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 3,
        headSha: "sha-x",
        authorLogin: "octocat",
        createdAt: "2026-06-05T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      const body = (await res.json()) as {
        org: Array<{ author: { login: string | null; avatar_url: string | null; id: number | null } }>
      }
      expect(body.org[0]!.author).toEqual({ login: "octocat", avatar_url: null, id: null })
    })

    it("busy installation: a less-active author's own recent PR still reaches `mine` even though it falls outside the old raw-100 window (regression for the pre-collapse-cap bug)", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "quiet-dev", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env
      stubInstallations([1])

      await insertRepo(db, 100, 1, "acme/api")

      const base = Date.parse("2026-06-01T00:00:00.000Z")
      // quiet-dev's own PR, reviewed once, well before the flood of busy-bot
      // activity below.
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 9999,
        headSha: "sha-quiet",
        authorLogin: "quiet-dev",
        createdAt: new Date(base).toISOString(),
      })
      // 150 distinct PRs from a busy author, each reviewed once, all newer
      // than quiet-dev's PR — enough on their own to fill (and overflow) the
      // OLD raw-100 window, pushing quiet-dev's row entirely outside it even
      // though the collapsed result (151 distinct PRs) has plenty of room.
      for (let i = 0; i < 150; i++) {
        await insertUsage(db, {
          installationId: 1,
          repoId: 100,
          prNumber: i,
          headSha: `sha-busy-${i}`,
          authorLogin: "busy-bot",
          createdAt: new Date(base + (i + 1) * 60_000).toISOString(),
        })
      }

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { org: Array<{ prNumber: number }>; mine: Array<{ prNumber: number }> }

      // Under the old raw-100-then-collapse behavior, quiet-dev's row never
      // survives the raw scan at all (150 busier rows outrank it), so `mine`
      // would be empty here. The wider raw scan (400) plus computing `mine`
      // from the full collapsed set — not a pre-capped `org` slice — means
      // quiet-dev's own PR still reaches their personal section.
      expect(body.mine.map((p) => p.prNumber)).toEqual([9999])
    })

    it("scopes org to only the session user's own installations (never another tenant's rows)", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "octocat", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env
      stubInstallations([1]) // session user only sees installation 1

      await insertRepo(db, 100, 1, "acme/api")
      await insertRepo(db, 200, 2, "other-org/secret")
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 1,
        headSha: "sha-a",
        authorLogin: "octocat",
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      await insertUsage(db, {
        installationId: 2,
        repoId: 200,
        prNumber: 1,
        headSha: "sha-secret",
        authorLogin: "someone-else",
        createdAt: "2026-06-02T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      const body = (await res.json()) as { org: Array<{ repo: string }> }
      expect(body.org).toHaveLength(1)
      expect(body.org[0]!.repo).toBe("acme/api")
    })

    it("401 for an unknown/expired session cookie (falls through to the api-key path, which also fails)", async () => {
      const db = await makeDb()
      const kv = makeKV()
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      } as unknown as Env
      const res = await handleWorkspacePrsRoute(reqWithSession("no-such-session"), env)
      expect(res.status).toBe(401)
    })

    it("soft-fails to empty org/mine when GitHub's installations call errors (never 500s the panel)", async () => {
      const db = await makeDb()
      const kv = makeKV()
      await seedSession(kv, "sess-1", "octocat", 111)
      const env = {
        OPENCLAW_STATE: kv,
        OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
        SIGILIX_PLATFORM_DB: db,
      } as unknown as Env
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("boom", { status: 500 })),
      )

      const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { org: unknown[]; mine: unknown[] }
      expect(body.org).toEqual([])
      expect(body.mine).toEqual([])
    })
  })

  describe("api-key path", () => {
    it("a per-installation key scopes org to only its own installation", async () => {
      const db = await makeDb()
      const kv = makeKV()
      const env = {
        OPENCLAW_STATE: kv,
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      } as unknown as Env

      const plaintext = "sigilix_live_workspace_prs"
      await insertApiKey(db, {
        id: "key-1",
        keyHash: await sha256Hex(plaintext),
        installationId: 1,
        createdBy: "1",
        nowIso: "2026-01-01T00:00:00Z",
      })

      await insertRepo(db, 100, 1, "acme/api")
      await insertRepo(db, 200, 2, "other-org/secret")
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 1,
        headSha: "sha-a",
        authorLogin: "octocat",
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      await insertUsage(db, {
        installationId: 2,
        repoId: 200,
        prNumber: 1,
        headSha: "sha-secret",
        authorLogin: "someone-else",
        createdAt: "2026-06-02T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithBearer(plaintext), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { org: Array<{ repo: string }>; mine: unknown[] }
      expect(body.org).toHaveLength(1)
      expect(body.org[0]!.repo).toBe("acme/api")
      // No user identity on the api-key path.
      expect(body.mine).toEqual([])
    })

    it("the legacy global-key sentinel sees rows across every installation (matches callerOwnsInstallation's broad legacy semantics)", async () => {
      const db = await makeDb()
      const kv = makeKV()
      const env = {
        OPENCLAW_STATE: kv,
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      } as unknown as Env

      await insertRepo(db, 100, 1, "acme/api")
      await insertRepo(db, 200, 2, "other-org/repo")
      await insertUsage(db, {
        installationId: 1,
        repoId: 100,
        prNumber: 1,
        headSha: "sha-a",
        authorLogin: "octocat",
        createdAt: "2026-06-01T00:00:00.000Z",
      })
      await insertUsage(db, {
        installationId: 2,
        repoId: 200,
        prNumber: 1,
        headSha: "sha-b",
        authorLogin: "someone-else",
        createdAt: "2026-06-02T00:00:00.000Z",
      })

      const res = await handleWorkspacePrsRoute(reqWithBearer(GLOBAL_KEY), env)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { org: Array<{ repo: string }> }
      expect(body.org).toHaveLength(2)
      expect(LEGACY_TENANT_INSTALLATION_ID).toBe(-1) // sanity — sentinel is negative, never a real installation id
    })

    it("401 for a garbage bearer", async () => {
      const db = await makeDb()
      const kv = makeKV()
      const env = {
        OPENCLAW_STATE: kv,
        SIGILIX_PLATFORM_DB: db,
        OPENCLAW_SIGILIX_API_KEY: GLOBAL_KEY,
      } as unknown as Env
      const res = await handleWorkspacePrsRoute(reqWithBearer("totally-wrong"), env)
      expect(res.status).toBe(401)
    })
  })

  it("fail-soft on a D1 read error: 200 with empty org/mine, never a 500", async () => {
    // Session path (KV-only auth — never touches D1) so the fault under test
    // is isolated to the usage_ledger READ, not auth. requireApiTenant's own
    // D1 lookup fails CLOSED on a broken db (401, see api-key-resolver.ts) —
    // that's a different, already-covered contract, not this one.
    const kv = makeKV()
    await seedSession(kv, "sess-1", "octocat", 111)
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 error")
      },
    } as unknown as D1Database
    const env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      SIGILIX_PLATFORM_DB: brokenDb,
    } as unknown as Env
    stubInstallations([1])

    const res = await handleWorkspacePrsRoute(reqWithSession("sess-1"), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { org: unknown[]; mine: unknown[] }
    expect(body.org).toEqual([])
    expect(body.mine).toEqual([])
  })
})
