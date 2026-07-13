// GET /v1/cli/installations — lightweight GitHub-backed discovery for the
// Portal CLI approval page. These tests keep discovery separate from the
// authoritative POST /v1/cli/authorize access decision and prove the list
// never fans out into repositories or GitHub App server credentials.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import worker from "@/src/index"
import { handleCliInstallationsRoute } from "@/src/lib/cli-login-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { removeOrgWorkspaceAccess } from "@/src/features/org-membership"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const WRONG_ENC_KEY = base64urlEncode(new Uint8Array(32).fill(8))
const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

interface TestKV extends KVNamespace {}

function makeKV(): TestKV {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = store.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as TestKV
}

interface Installation {
  id: number
  account: { login: string; type: "Organization" | "User" }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function requestWithSession(path: string, sessionId: string | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(`https://worker.test${path}`, { ...init, headers })
}

async function seedSession(
  kv: KVNamespace,
  sessionId: string,
  options: { githubUserId?: number; encryptionKey?: string; login?: string } = {},
): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: options.login ?? "octocat",
    ...(options.githubUserId !== undefined ? { githubUserId: options.githubUserId } : {}),
    accessToken: "ghu_test_token",
    encryptionKeyB64url: options.encryptionKey ?? ENC_KEY,
  })
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
}

function stubGitHubPages(
  pages: Installation[][],
  options: { installationStatus?: number; membershipRole?: "admin" | "member" } = {},
): ReturnType<typeof vi.fn> {
  const all = pages.flat()
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input)
    if (url.includes("/user/installations")) {
      const status = options.installationStatus ?? 200
      if (status !== 200) return jsonResponse({ message: "github error" }, status)
      const page = Number(new URL(url).searchParams.get("page") ?? "1")
      return jsonResponse({ total_count: all.length, installations: pages[page - 1] ?? [] })
    }
    if (url.includes("/user/memberships/orgs")) {
      return jsonResponse(
        all
          .filter((installation) => installation.account.type === "Organization")
          .map((installation) => ({
            role: options.membershipRole ?? "member",
            state: "active",
            organization: { login: installation.account.login },
          })),
      )
    }
    throw new Error(`unexpected GitHub request: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store")
}

async function applyCliSchema(db: D1Database): Promise<void> {
  for (const file of [
    "0001_create_tenant_repo_usage.sql",
    "0003_create_account_tenant_and_api_key.sql",
    "0006_create_user_identity.sql",
    "0010_add_gitlab_id_to_user_identity.sql",
  ]) {
    await db.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"))
  }
}

async function seedGithubIdentity(db: D1Database, githubUserId: string): Promise<void> {
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO user_identity" +
        " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), githubUserId, JSON.stringify(["github"]), now, now)
    .run()
}

async function seedStoredAccess(db: D1Database, installationId: number, githubUserId: string): Promise<void> {
  const now = "2026-07-13T00:00:00.000Z"
  await db
    .prepare(
      `INSERT INTO org_workspace_access
        (installation_id, github_user_id, role, created_at, updated_at, revoked_at,
         updated_by, last_audit_id, last_action)
       VALUES (?, ?, 'member', ?, ?, NULL, 'test-seed', ?, 'member_added_or_regranted')`,
    )
    .bind(installationId, githubUserId, now, now, `seed-${installationId}-${githubUserId}`)
    .run()
}

async function pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return {
    verifier,
    challenge: base64urlEncode(new Uint8Array(digest)),
    state: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleCliInstallationsRoute (GET /v1/cli/installations)", () => {
  let kv: TestKV
  let env: Env

  beforeEach(() => {
    kv = makeKV()
    env = {
      OPENCLAW_STATE: kv,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
  })

  it("returns only live GitHub installation identity fields without repo, membership, App, or D1 fan-out", async () => {
    await seedSession(kv, "sess-1", { githubUserId: 111 })
    const fetchMock = stubGitHubPages([
      [
        { id: 42, account: { login: "Sigilix", type: "Organization" } },
        { id: 84, account: { login: "octocat", type: "User" } },
      ],
    ])

    const response = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-1"), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      installations: [
        { installationId: 42, accountLogin: "Sigilix", accountType: "Organization" },
        { installationId: 84, accountLogin: "octocat", accountType: "User" },
      ],
    })
    expectPrivateNoStore(response)
    const urls = fetchMock.mock.calls.map(([input]) => urlOf(input as RequestInfo | URL))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain("/user/installations")
    expect(urls.join("\n")).not.toMatch(/repositories|memberships|\/app\//)
  })

  it("paginates installation discovery and preserves GitHub order", async () => {
    await seedSession(kv, "sess-pages", { githubUserId: 111 })
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `org-${index + 1}`, type: "Organization" as const },
    }))
    const fetchMock = stubGitHubPages([first, [{ id: 101, account: { login: "org-101", type: "Organization" } }]])

    const response = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-pages"), env)
    const body = (await response.json()) as { installations: Array<{ installationId: number }> }

    expect(response.status).toBe(200)
    expect(body.installations).toHaveLength(101)
    expect(body.installations[0]?.installationId).toBe(1)
    expect(body.installations.at(-1)?.installationId).toBe(101)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not truncate when full pages overlap or total_count is omitted", async () => {
    await seedSession(kv, "sess-overlap", { githubUserId: 111 })
    const first = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `org-${index + 1}`, type: "Organization" as const },
    }))
    const second = [
      first.at(-1)!,
      ...Array.from({ length: 99 }, (_, index) => ({
        id: index + 101,
        account: { login: `org-${index + 101}`, type: "Organization" as const },
      })),
    ]
    const final = [{ id: 200, account: { login: "org-200", type: "Organization" as const } }]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(urlOf(input)).searchParams.get("page") ?? "1")
      const pages = [first, second, final]
      // Deliberately omit total_count. A full page is the only reliable signal
      // that another page may exist while the upstream collection is changing.
      return jsonResponse({ installations: pages[page - 1] ?? [] })
    })
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-overlap"), env)
    const body = (await response.json()) as { installations: Array<{ installationId: number }> }

    expect(response.status).toBe(200)
    expect(body.installations).toHaveLength(200)
    expect(body.installations.at(-1)?.installationId).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it("filters malformed records and duplicate ids without widening the response contract", async () => {
    await seedSession(kv, "sess-shapes", { githubUserId: 111 })
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        total_count: 5,
        installations: [
          { id: 42, account: { login: "Sigilix", type: "Organization" } },
          { id: 42, account: { login: "duplicate", type: "Organization" } },
          { id: -1, account: { login: "bad-id", type: "Organization" } },
          { id: 84, account: { login: "", type: "Organization" } },
          { id: 99, account: { login: "bot", type: "Bot" } },
        ],
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-shapes"), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      installations: [{ installationId: 42, accountLogin: "Sigilix", accountType: "Organization" }],
    })
  })

  it("fails one full page when every installation violates the response contract", async () => {
    await seedSession(kv, "sess-invalid-page", { githubUserId: 111 })
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        total_count: 100,
        installations: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          account: { login: "", type: "Organization" },
        })),
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const response = await handleCliInstallationsRoute(
      requestWithSession("/v1/cli/installations", "sess-invalid-page"),
      env,
    )

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: "list_unavailable" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("distinguishes unauthenticated, non-GitHub, and invalid encrypted sessions", async () => {
    const unauthenticated = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", null), env)
    expect(unauthenticated.status).toBe(401)
    await expect(unauthenticated.json()).resolves.toEqual({ error: "unauthenticated" })

    await seedSession(kv, "sess-google")
    const nonGithub = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-google"), env)
    expect(nonGithub.status).toBe(403)
    await expect(nonGithub.json()).resolves.toEqual({ error: "github_account_required" })

    await seedSession(kv, "sess-corrupt", { githubUserId: 111, encryptionKey: WRONG_ENC_KEY })
    const invalid = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-corrupt"), env)
    expect(invalid.status).toBe(401)
    await expect(invalid.json()).resolves.toEqual({ error: "session_invalid" })
    expectPrivateNoStore(unauthenticated)
    expectPrivateNoStore(nonGithub)
    expectPrivateNoStore(invalid)
  })

  it("maps a rejected GitHub token to session_invalid and a genuine upstream failure to list_unavailable", async () => {
    await seedSession(kv, "sess-upstream", { githubUserId: 111 })

    stubGitHubPages([], { installationStatus: 401 })
    const rejected = await handleCliInstallationsRoute(
      requestWithSession("/v1/cli/installations", "sess-upstream"),
      env,
    )
    expect(rejected.status).toBe(401)
    await expect(rejected.json()).resolves.toEqual({ error: "session_invalid" })

    stubGitHubPages([], { installationStatus: 503 })
    const unavailable = await handleCliInstallationsRoute(
      requestWithSession("/v1/cli/installations", "sess-upstream"),
      env,
    )
    expect(unavailable.status).toBe(502)
    await expect(unavailable.json()).resolves.toEqual({ error: "list_unavailable" })
    expectPrivateNoStore(rejected)
    expectPrivateNoStore(unavailable)
  })

  it("fails strictly on network and malformed-JSON responses but returns 200 for a genuine empty list", async () => {
    await seedSession(kv, "sess-strict", { githubUserId: 111 })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("network down"))),
    )
    const network = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-strict"), env)
    expect(network.status).toBe(502)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    )
    const malformed = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-strict"), env)
    expect(malformed.status).toBe(502)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(null)),
    )
    const wrongShape = await handleCliInstallationsRoute(
      requestWithSession("/v1/cli/installations", "sess-strict"),
      env,
    )
    expect(wrongShape.status).toBe(502)

    stubGitHubPages([[]])
    const empty = await handleCliInstallationsRoute(requestWithSession("/v1/cli/installations", "sess-strict"), env)
    expect(empty.status).toBe(200)
    await expect(empty.json()).resolves.toEqual({ installations: [] })
  })

  it("fails closed when the session encryption key is missing", async () => {
    await seedSession(kv, "sess-misconfigured", { githubUserId: 111 })
    delete env.OPENCLAW_SESSION_ENCRYPTION_KEY

    const response = await handleCliInstallationsRoute(
      requestWithSession("/v1/cli/installations", "sess-misconfigured"),
      env,
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "misconfigured" })
    expectPrivateNoStore(response)
  })
})

describe("CLI installation picker through worker.fetch", () => {
  it("routes CORS/preflight and authorizes the explicitly selected second organization end to end", async () => {
    const db = makeD1()
    await applyCliSchema(db)
    await seedGithubIdentity(db, "111")
    const kv = makeKV()
    await seedSession(kv, "sess-e2e", { githubUserId: 111 })
    const installations: Installation[] = [
      { id: 42, account: { login: "first-org", type: "Organization" } },
      { id: 84, account: { login: "second-org", type: "Organization" } },
    ]
    const fetchMock = stubGitHubPages([installations])
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    } as unknown as Env
    const origin = "https://app.sigilix.ai"

    const preflight = await worker.fetch(
      requestWithSession("/v1/cli/installations", null, { method: "OPTIONS", headers: { origin } }),
      env,
      CTX,
    )
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin)
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true")

    const list = await worker.fetch(
      requestWithSession("/v1/cli/installations", "sess-e2e", { headers: { origin } }),
      env,
      CTX,
    )
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { installations: Array<{ installationId: number }> }
    expect(listed.installations.map((installation) => installation.installationId)).toEqual([42, 84])
    expect(list.headers.get("access-control-allow-origin")).toBe(origin)
    expect(list.headers.get("access-control-allow-credentials")).toBe("true")
    expectPrivateNoStore(list)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })

    const selected = listed.installations[1]!
    const p = await pkce()
    const authorize = await worker.fetch(
      requestWithSession("/v1/cli/authorize", "sess-e2e", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ state: p.state, challenge: p.challenge, installationId: selected.installationId }),
      }),
      env,
      CTX,
    )
    expect(authorize.status).toBe(200)
    await expect(
      db.prepare("SELECT installation_id FROM account_tenant WHERE github_user_id = '111'").first(),
    ).resolves.toEqual({ installation_id: 84 })
    const urls = fetchMock.mock.calls.map(([input]) => urlOf(input as RequestInfo | URL)).join("\n")
    expect(urls).not.toMatch(/repositories|\/app\//)
  })

  it("rechecks managed access and denies when access is removed after discovery", async () => {
    const db = makeD1()
    await applyCliSchema(db)
    await db.exec(
      readFileSync(new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url), "utf8"),
    )
    await seedGithubIdentity(db, "111")
    await seedStoredAccess(db, 84, "111")
    const kv = makeKV()
    await seedSession(kv, "sess-race", { githubUserId: 111 })
    stubGitHubPages([[{ id: 84, account: { login: "second-org", type: "Organization" } }]])
    const env = {
      OPENCLAW_STATE: kv,
      SIGILIX_PLATFORM_DB: db,
      OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
      OPENCLAW_ORG_MEMBERSHIP_MODE: "on",
    } as unknown as Env

    const list = await worker.fetch(requestWithSession("/v1/cli/installations", "sess-race"), env, CTX)
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toEqual({
      installations: [{ installationId: 84, accountLogin: "second-org", accountType: "Organization" }],
    })
    await expect(
      removeOrgWorkspaceAccess(db, {
        installationId: 84,
        githubUserId: "111",
        nowIso: "2026-07-13T01:00:00.000Z",
        updatedBy: "test:admin",
      }),
    ).resolves.toEqual({ status: "removed" })

    const p = await pkce()
    const authorize = await worker.fetch(
      requestWithSession("/v1/cli/authorize", "sess-race", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: p.state, challenge: p.challenge, installationId: 84 }),
      }),
      env,
      CTX,
    )
    expect(authorize.status).toBe(403)
    expectPrivateNoStore(authorize)
    await expect(db.prepare("SELECT COUNT(*) AS n FROM account_tenant").first<{ n: number }>()).resolves.toEqual({
      n: 0,
    })
  })
})
