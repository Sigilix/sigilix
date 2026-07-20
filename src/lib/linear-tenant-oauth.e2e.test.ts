import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getLinearConnectionByInstallation } from "@/src/features/linear-integration"
import {
  handleLinearOAuthCallback,
  handleLinearTenantInstall,
  LINEAR_AGENT_TOKEN_KEY,
  type LinearAgentTokenRecord,
} from "@/src/lib/linear-agent-oauth"
import { base64urlEncode, createSession, decryptAccessToken, getSession } from "@/src/lib/auth-session"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const IDENTITY_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const LINEAR_SQL = readFileSync(new URL("../../migrations/0016_create_linear_integration.sql", import.meta.url), "utf8")
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(4))
const COOKIE = "__Host-sigilix_session"

function makeKV(): { kv: KVNamespace; values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    kv: {
      get: async (key: string, type?: "json") => {
        const raw = values.get(key)
        if (raw === undefined) return null
        return type === "json" ? JSON.parse(raw) : raw
      },
      put: async (key: string, value: string) => values.set(key, value),
      delete: async (key: string) => values.delete(key),
    } as unknown as KVNamespace,
  }
}

async function setup(options?: { expiredGithubToken?: boolean }) {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(IDENTITY_SQL)
  await db.exec(LINEAR_SQL)
  const now = "2026-07-10T00:00:00.000Z"
  for (const [installationId, login, repoId, repo] of [
    [11, "acme", 101, "acme/api"],
    [22, "globex", 202, "globex/web"],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (?, ?, 'Organization', ?, ?)",
      )
      .bind(installationId, login, now, now)
      .run()
    await db
      .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)")
      .bind(repoId, installationId, repo, now)
      .run()
  }

  const { kv, values } = makeKV()
  for (const [userId, githubUserId] of [
    ["linear-user-111", "111"],
    ["linear-user-222", "222"],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO user_identity" +
          " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(userId, githubUserId, JSON.stringify(["github"]), now, now)
      .run()
  }
  await createSession({
    kv,
    sessionId: "alice-session",
    login: "alice",
    githubUserId: 111,
    userId: "linear-user-111",
    accessToken: options?.expiredGithubToken ? "expired-access" : "gh-alice",
    ...(options?.expiredGithubToken
      ? {
          refreshToken: "old-refresh",
          accessTokenExpiresAt: Date.now() - 1_000,
          refreshTokenExpiresAt: Date.now() + 60_000,
        }
      : {}),
    encryptionKeyB64url: ENC_KEY,
  })
  await createSession({
    kv,
    sessionId: "mallory-session",
    login: "mallory",
    githubUserId: 222,
    userId: "linear-user-222",
    accessToken: "gh-mallory",
    encryptionKeyB64url: ENC_KEY,
  })

  const records = new Map<string, LinearAgentTokenRecord>()
  const pending = new Map<string, { generation: string; record: LinearAgentTokenRecord }>()
  const uninstallCalls: Array<{ organizationId: string; installationId: number }> = []
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn((id: { name: string }) => ({
      installTenant: async (record: LinearAgentTokenRecord) => {
        const prior = records.get(id.name)
        if (
          prior &&
          (prior.organizationId !== record.organizationId || prior.installationId !== record.installationId)
        ) {
          throw new Error("tenant conflict")
        }
        records.set(id.name, record)
        return { ok: true as const }
      },
      stageTenantInstall: async (
        record: LinearAgentTokenRecord,
        _scope: { organizationId: string; installationId: number },
        generation: string,
      ) => {
        pending.set(id.name, { generation, record })
        return { ok: true as const }
      },
      commitTenantInstall: async (_scope: { organizationId: string; installationId: number }, generation: string) => {
        const staged = pending.get(id.name)
        if (!staged || staged.generation !== generation) {
          return { ok: false as const, reason: "not-staged" as const }
        }
        records.set(id.name, { ...staged.record, installGeneration: generation })
        pending.delete(id.name)
        return { ok: true as const, committed: true }
      },
      rollbackTenantInstall: async (scope: { organizationId: string; installationId: number }, generation: string) => {
        uninstallCalls.push(scope)
        const staged = pending.get(id.name)
        if (!staged) return { ok: true as const, removed: false }
        if (staged.generation !== generation) {
          return { ok: false as const, reason: "generation-mismatch" as const }
        }
        pending.delete(id.name)
        return { ok: true as const, removed: true }
      },
      uninstallTenant: async (scope: { organizationId: string; installationId: number }) => {
        uninstallCalls.push(scope)
        const prior = records.get(id.name)
        if (!prior) return { ok: true as const, removed: false }
        if (prior.organizationId !== scope.organizationId || prior.installationId !== scope.installationId) {
          return { ok: false as const, reason: "tenant-mismatch" as const }
        }
        records.delete(id.name)
        return { ok: true as const, removed: true }
      },
    })),
  }
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
    LINEAR_TOKEN_BROKER: namespace,
    LINEAR_OAUTH_CLIENT_ID: "client-id",
    LINEAR_OAUTH_CLIENT_SECRET: "client-secret",
    OPENCLAW_GATEWAY_ISSUER: "https://api.sigilix.ai",
    GITHUB_OAUTH_CLIENT_ID: "github-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "github-client-secret",
  } as unknown as Env
  return { db, env, kv, records, pending, values, uninstallCalls }
}

function withBatch(db: D1Database, batch: (statements: D1PreparedStatement[]) => Promise<D1Result[]>): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "batch") return batch
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

function installRequest(installationId: number, sessionId: string): Request {
  return new Request(`https://api.sigilix.ai/v1/org/${installationId}/linear/install`, {
    method: "POST",
    headers: { cookie: `${COOKIE}=${sessionId}` },
  })
}

function callbackRequest(code: string, state: string, sessionId: string): Request {
  return new Request(`https://api.sigilix.ai/linear/oauth/callback?code=${code}&state=${state}`, {
    headers: { cookie: `${COOKIE}=${sessionId}` },
  })
}

function stateFrom(responseBody: { authorizeUrl: string }): string {
  return new URL(responseBody.authorizeUrl).searchParams.get("state") ?? ""
}

function stubExternal(options?: { expectedAccessToken?: string }): string[] {
  const seenAuthorizations: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: options?.expectedAccessToken,
            refresh_token: "rotated-refresh",
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.startsWith("https://api.github.com/")) {
        seenAuthorizations.push(new Headers(init?.headers).get("authorization") ?? "")
      }
      if (url.includes("/user/installations")) {
        return new Response(
          JSON.stringify({
            installations: [
              { id: 11, account: { type: "Organization", login: "acme" } },
              { id: 22, account: { type: "Organization", login: "globex" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/user/memberships/orgs")) {
        return new Response(
          JSON.stringify([
            { role: "admin", state: "active", organization: { login: "acme" } },
            { role: "admin", state: "active", organization: { login: "globex" } },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url === "https://api.linear.app/oauth/token") {
        const form = init?.body as URLSearchParams
        const code = form.get("code")
        const suffix = code === "code-a" ? "a" : "b"
        return new Response(
          JSON.stringify({
            access_token: `linear-token-${suffix}`,
            refresh_token: `linear-refresh-${suffix}`,
            expires_in: 86_400,
            scope: ["read", "write", "app:assignable", "app:mentionable"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url === "https://api.linear.app/graphql") {
        const authorization = (init?.headers as Record<string, string> | undefined)?.authorization ?? ""
        const suffix = authorization.endsWith("-a") ? "a" : "b"
        return new Response(
          JSON.stringify({
            data: {
              organization: { id: `org-${suffix}`, name: `Org ${suffix.toUpperCase()}` },
              viewer: { id: `app-${suffix}`, name: "Sigilix", displayName: "Sigilix", app: true },
              teams: {
                nodes: [{ id: `team-${suffix}`, key: suffix.toUpperCase(), name: `Team ${suffix.toUpperCase()}` }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      return new Response("not found", { status: 404 })
    }),
  )
  return seenAuthorizations
}

describe("tenant-bound Linear OAuth", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("refreshes an expired GitHub token before exact-install admin proof and state minting", async () => {
    const { env, kv, values } = await setup({ expiredGithubToken: true })
    const seenAuthorizations = stubExternal({ expectedAccessToken: "rotated-access" })

    const response = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)

    expect(response.status).toBe(200)
    expect(seenAuthorizations).toEqual(["Bearer rotated-access", "Bearer rotated-access"])
    const state = stateFrom((await response.json()) as { authorizeUrl: string })
    expect(JSON.parse(values.get(`linear-oauth-state:${state}`) ?? "{}")).toMatchObject({
      version: 1,
      installationId: 11,
      userId: "linear-user-111",
      login: "alice",
    })
    const persisted = await getSession({ kv, sessionId: "alice-session" })
    expect(persisted).not.toBeNull()
    await expect(
      decryptAccessToken(
        { encryptedAccessToken: persisted!.encryptedAccessToken, iv: persisted!.iv },
        "alice-session",
        ENC_KEY,
      ),
    ).resolves.toBe("rotated-access")
  })

  it("binds state to installation+user and stores two org tokens in different DO shards", async () => {
    const { db, env, records, values } = await setup()
    stubExternal()

    const startA = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)
    expect(startA.status).toBe(200)
    const startBodyA = (await startA.json()) as { authorizeUrl: string }
    // prompt=consent forces Linear to re-issue a code on every reconnect, even
    // when the workspace already has the app installed — without it an already-
    // installed org never reaches the callback that writes linear_connection.
    expect(new URL(startBodyA.authorizeUrl).searchParams.get("prompt")).toBe("consent")
    const stateA = stateFrom(startBodyA)
    const storedState = JSON.parse(values.get(`linear-oauth-state:${stateA}`) ?? "{}") as Record<string, unknown>
    expect(storedState).toMatchObject({
      version: 1,
      installationId: 11,
      userId: "linear-user-111",
      login: "alice",
    })

    const wrongUser = await handleLinearOAuthCallback(callbackRequest("code-a", stateA, "mallory-session"), env)
    expect(wrongUser.status).toBe(403)
    expect(records.size).toBe(0)

    const callbackA = await handleLinearOAuthCallback(callbackRequest("code-a", stateA, "alice-session"), env)
    expect(callbackA.status).toBe(200)
    const startB = await handleLinearTenantInstall(installRequest(22, "alice-session"), env, undefined, 22)
    const stateB = stateFrom((await startB.json()) as { authorizeUrl: string })
    const callbackB = await handleLinearOAuthCallback(callbackRequest("code-b", stateB, "alice-session"), env)
    expect(callbackB.status).toBe(200)

    expect([...records.keys()].sort()).toEqual(["linear-org:v1:org-a", "linear-org:v1:org-b"])
    expect(records.get("linear-org:v1:org-a")).toMatchObject({
      accessToken: "linear-token-a",
      organizationId: "org-a",
      installationId: 11,
      actorType: "app",
    })
    expect(records.get("linear-org:v1:org-b")).toMatchObject({
      accessToken: "linear-token-b",
      organizationId: "org-b",
      installationId: 22,
      actorType: "app",
    })
    expect((await getLinearConnectionByInstallation({ SIGILIX_PLATFORM_DB: db }, 11))?.organizationId).toBe("org-a")
    expect((await getLinearConnectionByInstallation({ SIGILIX_PLATFORM_DB: db }, 22))?.organizationId).toBe("org-b")
    expect(values.has(LINEAR_AGENT_TOKEN_KEY)).toBe(false)
  })

  it("rejects explicitly expired and future-dated tenant state before token exchange", async () => {
    const { env, records, values } = await setup()
    stubExternal()
    const fetchMock = vi.mocked(fetch)

    for (const createdAt of [Date.now() - 601_000, Date.now() + 60_000]) {
      const start = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)
      const state = stateFrom((await start.json()) as { authorizeUrl: string })
      const stateKey = `linear-oauth-state:${state}`
      const stored = JSON.parse(values.get(stateKey) ?? "{}") as Record<string, unknown>
      values.set(stateKey, JSON.stringify({ ...stored, createdAt }))
      const callsBeforeCallback = fetchMock.mock.calls.length

      const response = await handleLinearOAuthCallback(callbackRequest("code-a", state, "alice-session"), env)

      expect(response.status).toBe(400)
      expect(fetchMock.mock.calls).toHaveLength(callsBeforeCallback)
      expect(values.has(stateKey)).toBe(false)
      expect(records.size).toBe(0)
    }
  })

  it("uninstalls the exact broker token when the D1 link fails before commit", async () => {
    const { db, env, records, uninstallCalls } = await setup()
    stubExternal()
    env.SIGILIX_PLATFORM_DB = withBatch(db, async () => {
      throw new Error("D1 unavailable")
    })
    const start = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)
    const state = stateFrom((await start.json()) as { authorizeUrl: string })

    const response = await handleLinearOAuthCallback(callbackRequest("code-a", state, "alice-session"), env)

    expect(response.status).toBe(502)
    expect(uninstallCalls).toEqual([{ organizationId: "org-a", installationId: 11 }])
    expect(records.size).toBe(0)
    expect(await getLinearConnectionByInstallation({ SIGILIX_PLATFORM_DB: db }, 11)).toBeNull()
  })

  it("rolls back a failed reconnect generation without deleting the prior same-tenant token", async () => {
    const { db, env, records, pending, uninstallCalls } = await setup()
    stubExternal()
    records.set("linear-org:v1:org-a", {
      accessToken: "linear-token-prior",
      refreshToken: "linear-refresh-prior",
      installedAt: 1,
      organizationId: "org-a",
      installationId: 11,
      actorType: "app",
      appUserId: "app-a",
    })
    env.SIGILIX_PLATFORM_DB = withBatch(db, async () => {
      throw new Error("D1 unavailable")
    })
    const start = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)
    const state = stateFrom((await start.json()) as { authorizeUrl: string })

    const response = await handleLinearOAuthCallback(callbackRequest("code-a", state, "alice-session"), env)

    expect(response.status).toBe(502)
    expect(uninstallCalls).toEqual([{ organizationId: "org-a", installationId: 11 }])
    expect(pending.size).toBe(0)
    expect(records.get("linear-org:v1:org-a")?.accessToken).toBe("linear-token-prior")
  })

  it("retains the token when an ambiguous D1 failure committed the exact active link", async () => {
    const { db, env, records, uninstallCalls } = await setup()
    stubExternal()
    env.SIGILIX_PLATFORM_DB = withBatch(db, async (statements) => {
      const result = await db.batch(statements)
      throw Object.assign(new Error("response lost after commit"), { result })
    })
    const start = await handleLinearTenantInstall(installRequest(11, "alice-session"), env, undefined, 11)
    const state = stateFrom((await start.json()) as { authorizeUrl: string })

    const response = await handleLinearOAuthCallback(callbackRequest("code-a", state, "alice-session"), env)

    expect(response.status).toBe(502)
    expect(uninstallCalls).toEqual([])
    expect(records.get("linear-org:v1:org-a")?.accessToken).toBe("linear-token-a")
    expect((await getLinearConnectionByInstallation({ SIGILIX_PLATFORM_DB: db }, 11))?.organizationId).toBe("org-a")
  })
})
