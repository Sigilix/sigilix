import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "@/src/index"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleGetRepositoryContext, handlePutRepositoryContext } from "@/src/lib/repository-context-route"
import { bootstrapFirstOrgAdmin } from "@/src/features/org-membership"
import {
  purgeRepositoryContext,
  readRepositoryContext,
  replaceRepositoryContext,
} from "@/src/features/repository-context"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const INSTALLATION_ID = 42
const SESSION_ID = "repository-context-session"
const SESSION_COOKIE = "__Host-sigilix_session"
const PORTAL_ORIGIN = "https://app.sigilix.ai"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(41))
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const migration = readFileSync(new URL("../../migrations/0024_create_repository_context.sql", import.meta.url), "utf8")
const orgMembershipMigration = readFileSync(
  new URL("../../migrations/0022_create_org_workspace_access.sql", import.meta.url),
  "utf8",
)

interface LiveRepository {
  id: number
  full_name: string
}

interface PublicSnapshot {
  provider: "github"
  scopeId: string
  revision: number
  repositories: Array<{
    repositoryId: number
    fullName: string
    context: string
    available: boolean
  }>
  relationships: Array<{
    fromRepositoryId: number
    toRepositoryId: number
    label: string
  }>
  conventions: string
  availableRepositories: Array<{ repositoryId: number; fullName: string }>
}

function makeKV(): KVNamespace {
  const values = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const value = values.get(key)
      if (value === undefined) return null
      return type === "json" ? JSON.parse(value) : value
    },
    put: async (key: string, value: string) => void values.set(key, value),
    delete: async (key: string) => void values.delete(key),
  } as unknown as KVNamespace
}

async function makeDb(applyMigration = true): Promise<D1Database> {
  const db = makeD1()
  if (applyMigration) await db.exec(migration)
  return db
}

async function makeEnv(
  options: {
    db?: D1Database
    mode?: string
    githubUserId?: number
    membershipMode?: string
    appCredentials?: boolean
    cacheAppToken?: boolean
  } = {},
): Promise<Env> {
  const kv = makeKV()
  await createSession({
    kv,
    sessionId: SESSION_ID,
    login: "owner",
    githubUserId: options.githubUserId ?? 111,
    accessToken: "ghu_repository_context",
    encryptionKeyB64url: ENC_KEY,
  })
  if (options.cacheAppToken !== false) {
    await kv.put(
      `gh-installation-token:${INSTALLATION_ID}`,
      JSON.stringify({ token: "ghs_repository_context", expiresAt: Date.now() + 60 * 60 * 1_000 }),
    )
  }
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    OPENCLAW_REPOSITORY_CONTEXT_API: options.mode ?? "on",
    ...(options.membershipMode ? { OPENCLAW_ORG_MEMBERSHIP_MODE: options.membershipMode } : {}),
    ...(options.appCredentials === false
      ? {}
      : { GITHUB_APP_ID: "123", GITHUB_PRIVATE_KEY: "unused-cached-private-key" }),
    ...(options.db ? { SIGILIX_PLATFORM_DB: options.db } : {}),
  } as unknown as Env
}

function stubGitHub(
  options: {
    role?: "admin" | "member"
    visibleInstallationId?: number
    userRepositories?: LiveRepository[]
    appRepositories?: LiveRepository[]
    appStatus?: number
    events?: string[]
  } = {},
): ReturnType<typeof vi.fn> {
  const visibleInstallationId = options.visibleInstallationId ?? INSTALLATION_ID
  const role = options.role ?? "admin"
  const appRepositories = options.appRepositories ?? [
    { id: 101, full_name: "acme/api" },
    { id: 202, full_name: "acme/worker" },
  ]
  const userRepositories = options.userRepositories ?? appRepositories
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes(`/user/installations/${INSTALLATION_ID}/repositories?`)) {
      options.events?.push("user-repository-lookup")
      return new Response(JSON.stringify({ total_count: userRepositories.length, repositories: userRepositories }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.startsWith("https://api.github.com/installation/repositories?")) {
      options.events?.push("app-repository-lookup")
      expect(new Headers(init?.headers).get("authorization")).toBe("token ghs_repository_context")
      return new Response(JSON.stringify({ total_count: appRepositories.length, repositories: appRepositories }), {
        status: options.appStatus ?? 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (url.startsWith("https://api.github.com/user/installations?")) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          installations: [
            {
              id: visibleInstallationId,
              account: { type: "Organization", login: "acme" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.startsWith("https://api.github.com/user/memberships/orgs?")) {
      return new Response(
        JSON.stringify([
          {
            role,
            state: "active",
            organization: { login: "acme" },
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function request(
  method: "GET" | "PUT",
  options: { installationId?: number; body?: string; contentType?: string | null; origin?: string } = {},
): Request {
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${SESSION_ID}` })
  if (options.body !== undefined && options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json")
  }
  if (options.origin) headers.set("origin", options.origin)
  return new Request(`https://api.sigilix.ai/v1/org/${options.installationId ?? INSTALLATION_ID}/repository-context`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  })
}

function validBody(revision = 0): Record<string, unknown> {
  return {
    revision,
    repositories: [
      { repositoryId: 101, context: "Public API" },
      { repositoryId: 202, context: "Background jobs" },
    ],
    relationships: [
      {
        fromRepositoryId: 101,
        toRepositoryId: 202,
        label: "publishes jobs",
      },
    ],
    conventions: "Use conventional commits.",
  }
}

async function seedSnapshot(db: D1Database): Promise<void> {
  const result = await replaceRepositoryContext(db, {
    provider: "github",
    scopeId: String(INSTALLATION_ID),
    expectedRevision: 0,
    repositories: [
      { externalId: "101", fullName: "acme/api", context: "Public API", position: 0 },
      { externalId: "202", fullName: "acme/worker", context: "Background jobs", position: 1 },
    ],
    relationships: [
      {
        fromExternalId: "101",
        toExternalId: "202",
        label: "publishes jobs",
        normalizedLabel: "publishes jobs",
        position: 0,
      },
    ],
    conventions: "Use conventional commits.",
    nowIso: "2026-07-13T21:00:00.000Z",
    updatedBy: "github:111",
  })
  expect(result.status).toBe("updated")
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("repository-context route", () => {
  it("is private, no-store, default-off, and returns 404 before auth, GitHub, or D1 for GET and PUT", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    let dbReads = 0
    const env = {
      OPENCLAW_REPOSITORY_CONTEXT_API: "off",
      get OPENCLAW_STATE() {
        throw new Error("auth must not run")
      },
      get SIGILIX_PLATFORM_DB() {
        dbReads += 1
        throw new Error("D1 must not run")
      },
    } as unknown as Env

    for (const req of [request("GET"), request("PUT", { body: JSON.stringify(validBody()) })]) {
      const response =
        req.method === "GET"
          ? await handleGetRepositoryContext(req, env, undefined, INSTALLATION_ID)
          : await handlePutRepositoryContext(req, env, undefined, INSTALLATION_ID)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dbReads).toBe(0)
  })

  it("stays default-off through worker.fetch normalization/dispatch with CORS and zero auth, GitHub, or D1 calls", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const kvGet = vi.fn(async () => null)
    const dbPrepare = vi.fn(() => {
      throw new Error("D1 must not run")
    })
    const env = {
      OPENCLAW_REPOSITORY_CONTEXT_API: "off",
      OPENCLAW_STATE: {
        get: kvGet,
        put: vi.fn(),
        delete: vi.fn(),
      } as unknown as KVNamespace,
      SIGILIX_PLATFORM_DB: { prepare: dbPrepare } as unknown as D1Database,
    } as unknown as Env

    for (const req of [
      request("GET", { origin: PORTAL_ORIGIN }),
      request("PUT", { body: JSON.stringify(validBody()), origin: PORTAL_ORIGIN }),
    ]) {
      const response = await worker.fetch(req, env, ctx)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
      expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    }
    expect(kvGet).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(dbPrepare).not.toHaveBeenCalled()
  })

  it("requires an exact-installation admin before reading the PUT body or D1", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub({ role: "member" })
    const memberRequest = request("PUT", { body: JSON.stringify(validBody()) })
    const originalBody = memberRequest.body
    let bodyReads = 0
    Object.defineProperty(memberRequest, "body", {
      configurable: true,
      get() {
        bodyReads += 1
        return originalBody
      },
    })
    const member = await handlePutRepositoryContext(memberRequest, env, undefined, INSTALLATION_ID)
    expect(member.status).toBe(403)
    expect(bodyReads).toBe(0)
    await expect(readRepositoryContext(db, "github", String(INSTALLATION_ID))).resolves.toEqual({
      status: "not_found",
    })

    const outsideFetch = stubGitHub({ visibleInstallationId: 999 })
    const outside = await handleGetRepositoryContext(
      request("GET", { installationId: INSTALLATION_ID }),
      env,
      undefined,
      INSTALLATION_ID,
    )
    expect(outside.status).toBe(403)
    expect(
      outsideFetch.mock.calls.some(([input]) =>
        String(input).startsWith("https://api.github.com/installation/repositories?"),
      ),
    ).toBe(false)
    expect(
      outsideFetch.mock.calls.some(([input]) => String(input).includes("/app/installations/42/access_tokens")),
    ).toBe(false)
  })

  it("requires JSON and enforces the streaming 64KiB cap after admin authorization", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub()
    const wrongType = await handlePutRepositoryContext(
      request("PUT", {
        body: JSON.stringify(validBody()),
        contentType: "text/plain",
      }),
      env,
      undefined,
      INSTALLATION_ID,
    )
    expect(wrongType.status).toBe(415)

    const oversized = await handlePutRepositoryContext(
      request("PUT", {
        body: JSON.stringify({ ...validBody(), conventions: "x".repeat(64 * 1024) }),
      }),
      env,
      undefined,
      INSTALLATION_ID,
    )
    expect(oversized.status).toBe(413)
    await expect(readRepositoryContext(db, "github", String(INSTALLATION_ID))).resolves.toEqual({
      status: "not_found",
    })
  })

  it("completes the exact repository lookup before touching repository-context D1 and maps failure to 503", async () => {
    const events: string[] = []
    const db = {
      prepare() {
        events.push("d1")
        throw new Error("migration missing")
      },
    } as unknown as D1Database
    const env = await makeEnv({ db })
    stubGitHub({ events })
    const response = await handleGetRepositoryContext(request("GET"), env, undefined, INSTALLATION_ID)
    expect(response.status).toBe(503)
    expect(events).toEqual(["app-repository-lookup", "d1"])

    const realDb = await makeDb()
    const lookupEnv = await makeEnv({ db: realDb })
    stubGitHub({ appStatus: 500 })
    const lookupFailed = await handleGetRepositoryContext(request("GET"), lookupEnv, undefined, INSTALLATION_ID)
    expect(lookupFailed.status).toBe(503)
    expect(await lookupFailed.json()).toEqual({ error: "repository_scope_unavailable" })
  })

  it("returns 503 before reading the body or repository-context D1 when app credentials, token, or listing fail", async () => {
    const cases: Array<{
      name: string
      env: Parameters<typeof makeEnv>[0]
      github?: Parameters<typeof stubGitHub>[0]
    }> = [
      { name: "missing credentials", env: { appCredentials: false } },
      { name: "installation token", env: { cacheAppToken: false } },
      { name: "installation repository list", env: {}, github: { appStatus: 500 } },
    ]

    for (const testCase of cases) {
      const dbPrepare = vi.fn(() => {
        throw new Error("repository-context D1 must not run")
      })
      const env = await makeEnv({
        ...testCase.env,
        db: { prepare: dbPrepare } as unknown as D1Database,
      })
      stubGitHub(testCase.github)
      const putRequest = request("PUT", { body: JSON.stringify(validBody()) })
      const originalBody = putRequest.body
      let bodyReads = 0
      Object.defineProperty(putRequest, "body", {
        configurable: true,
        get() {
          bodyReads += 1
          return originalBody
        },
      })

      const response = await handlePutRepositoryContext(putRequest, env, undefined, INSTALLATION_ID)
      expect(response.status, testCase.name).toBe(503)
      expect(await response.json()).toEqual({ error: "repository_scope_unavailable" })
      expect(bodyReads, testCase.name).toBe(0)
      expect(dbPrepare, testCase.name).not.toHaveBeenCalled()
    }
  })

  it("uses app-installed repos so a stored admin can retain context hidden from their user-scoped list", async () => {
    const db = makeD1()
    await db.exec(orgMembershipMigration)
    await db.exec(migration)
    await seedSnapshot(db)
    await bootstrapFirstOrgAdmin(db, {
      installationId: INSTALLATION_ID,
      githubUserId: "111",
      nowIso: "2026-07-13T21:01:00.000Z",
      updatedBy: "test",
    })
    const env = await makeEnv({ db, membershipMode: "on" })
    const fetchMock = stubGitHub({
      role: "member",
      userRepositories: [{ id: 101, full_name: "acme/api" }],
      appRepositories: [
        { id: 101, full_name: "acme/api" },
        { id: 202, full_name: "acme/worker" },
      ],
    })
    const response = await handlePutRepositoryContext(
      request("PUT", {
        body: JSON.stringify({
          ...validBody(1),
          repositories: [
            { repositoryId: 101, context: "Updated public API" },
            { repositoryId: 202, context: "Background jobs" },
          ],
        }),
      }),
      env,
      undefined,
      INSTALLATION_ID,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      revision: 2,
      repositories: [
        { repositoryId: 101, context: "Updated public API", available: true },
        { repositoryId: 202, context: "Background jobs", available: true },
      ],
      relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "publishes jobs" }],
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/user/installations/42/repositories?"))).toBe(
      false,
    )
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("https://api.github.com/installation/repositories?"),
      ),
    ).toBe(true)
    await expect(readRepositoryContext(db, "github", String(INSTALLATION_ID))).resolves.toMatchObject({
      status: "ok",
      snapshot: {
        revision: 2,
        repositories: [
          { externalId: "101", context: "Updated public API" },
          { externalId: "202", context: "Background jobs" },
        ],
        relationships: [{ fromExternalId: "101", toExternalId: "202", label: "publishes jobs" }],
      },
    })
  })

  it("rejects raw, NFKC-only, and lone-surrogate credential/text payloads without a D1 write", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub({ appRepositories: [{ id: 101, full_name: "acme/api" }] })
    const cases = [
      "Deploy with sk_live_4eC39HqLyjWDarjtT1zdp7dc",
      "ｓｋ＿ｌｉｖｅ＿４ｅＣ３９ＨｑＬｙｊＷＤａｒｊｔＴ１ｚｄｐ７ｄｃ",
      "\ud800",
    ]
    for (const context of cases) {
      const response = await handlePutRepositoryContext(
        request("PUT", {
          body: JSON.stringify({
            revision: 0,
            repositories: [{ repositoryId: 101, context }],
            relationships: [],
            conventions: "",
          }),
        }),
        env,
        undefined,
        INSTALLATION_ID,
      )
      expect(response.status, JSON.stringify(context)).toBe(400)
    }
    await expect(readRepositoryContext(db, "github", String(INSTALLATION_ID))).resolves.toEqual({
      status: "not_found",
    })
  })

  it("rejects client-supplied provider, scope, and repository names through the closed route contract", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub()
    const cases = [
      { ...validBody(), provider: "github" },
      { ...validBody(), scopeId: "42" },
      {
        ...validBody(),
        repositories: [{ repositoryId: 101, fullName: "attacker/repo", context: "Public API" }],
        relationships: [],
      },
    ]
    for (const body of cases) {
      const response = await handlePutRepositoryContext(
        request("PUT", { body: JSON.stringify(body) }),
        env,
        undefined,
        INSTALLATION_ID,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "invalid_repository_context", reason: "invalid_shape" })
    }
    await expect(readRepositoryContext(db, "github", String(INSTALLATION_ID))).resolves.toEqual({
      status: "not_found",
    })
  })

  it("returns repository_scope_changed when a submitted immutable id is not currently available", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub({ appRepositories: [{ id: 101, full_name: "acme/api" }] })
    const response = await handlePutRepositoryContext(
      request("PUT", {
        body: JSON.stringify({
          revision: 0,
          repositories: [{ repositoryId: 999, context: "foreign" }],
          relationships: [],
          conventions: "",
        }),
      }),
      env,
      undefined,
      INSTALLATION_ID,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "repository_scope_changed" })
  })

  it("returns 503 when the repository-context migration is missing", async () => {
    const db = await makeDb(false)
    const env = await makeEnv({ db })
    stubGitHub()
    const response = await handleGetRepositoryContext(request("GET"), env, undefined, INSTALLATION_ID)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "repository_context_unavailable" })
  })

  it("keeps revoked configured repos and relationships while exposing exact current availability", async () => {
    const db = await makeDb()
    await seedSnapshot(db)
    const env = await makeEnv({ db })
    stubGitHub({
      appRepositories: [
        { id: 101, full_name: "acme/api-renamed" },
        { id: 303, full_name: "acme/web" },
      ],
    })
    const response = await handleGetRepositoryContext(request("GET"), env, undefined, INSTALLATION_ID)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      provider: "github",
      scopeId: "42",
      revision: 1,
      repositories: [
        { repositoryId: 101, fullName: "acme/api-renamed", context: "Public API", available: true },
        {
          repositoryId: 202,
          fullName: "acme/worker",
          context: "Background jobs",
          available: false,
        },
      ],
      relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "publishes jobs" }],
      conventions: "Use conventional commits.",
      availableRepositories: [
        { repositoryId: 101, fullName: "acme/api-renamed" },
        { repositoryId: 303, fullName: "acme/web" },
      ],
    } satisfies PublicSnapshot)
  })

  it("returns an absent rev0 snapshot and preserves a tombstone's current revision with empty content", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub({ appRepositories: [{ id: 101, full_name: "acme/api" }] })
    const absent = await handleGetRepositoryContext(request("GET"), env, undefined, INSTALLATION_ID)
    expect(absent.status).toBe(200)
    expect(await absent.json()).toMatchObject({
      provider: "github",
      scopeId: "42",
      revision: 0,
      repositories: [],
      relationships: [],
      conventions: "",
    })

    await seedSnapshot(db)
    const purged = await purgeRepositoryContext(db, {
      provider: "github",
      scopeId: "42",
      expectedRevision: 1,
      nowIso: "2026-07-13T21:01:00.000Z",
      updatedBy: "github:111",
    })
    expect(purged.status).toBe("updated")
    const tombstone = await handleGetRepositoryContext(request("GET"), env, undefined, INSTALLATION_ID)
    expect(tombstone.status).toBe(200)
    expect(await tombstone.json()).toMatchObject({
      revision: 2,
      repositories: [],
      relationships: [],
      conventions: "",
    })
  })

  it("returns the current revision on a stale optimistic write", async () => {
    const db = await makeDb()
    await seedSnapshot(db)
    const env = await makeEnv({ db })
    stubGitHub()
    const response = await handlePutRepositoryContext(
      request("PUT", { body: JSON.stringify(validBody(0)) }),
      env,
      undefined,
      INSTALLATION_ID,
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "revision_conflict", currentRevision: 1 })
  })

  it("round-trips PUT then GET through worker.fetch, D1, exact live scope, and portal CORS", async () => {
    const db = await makeDb()
    const env = await makeEnv({ db })
    stubGitHub()
    const put = await worker.fetch(
      request("PUT", {
        body: JSON.stringify(validBody()),
        origin: PORTAL_ORIGIN,
      }),
      env,
      ctx,
    )
    expect(put.status).toBe(200)
    expect(put.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(put.headers.get("cache-control")).toBe("private, no-store")
    expect(await put.json()).toMatchObject({ revision: 1, provider: "github", scopeId: "42" })

    const get = await worker.fetch(request("GET", { origin: PORTAL_ORIGIN }), env, ctx)
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({
      provider: "github",
      scopeId: "42",
      revision: 1,
      repositories: [
        { repositoryId: 101, fullName: "acme/api", context: "Public API", available: true },
        { repositoryId: 202, fullName: "acme/worker", context: "Background jobs", available: true },
      ],
      relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "publishes jobs" }],
      conventions: "Use conventional commits.",
      availableRepositories: [
        { repositoryId: 101, fullName: "acme/api" },
        { repositoryId: 202, fullName: "acme/worker" },
      ],
    } satisfies PublicSnapshot)
  })
})
