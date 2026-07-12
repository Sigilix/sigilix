import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleGetLinearConfig, handleSetLinearConfig } from "@/src/lib/linear-config-route"
import { connectLinearOrganization } from "@/src/features/linear-integration"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const LINEAR_SQL = readFileSync(new URL("../../migrations/0016_create_linear_integration.sql", import.meta.url), "utf8")
const TEAM_REPO_SQL = readFileSync(
  new URL("../../migrations/0018_create_linear_team_repo.sql", import.meta.url),
  "utf8",
)
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
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
      put: async (key: string, value: string) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    } as unknown as KVNamespace,
  }
}

async function setup() {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(LINEAR_SQL)
  await db.exec(TEAM_REPO_SQL)
  const now = "2026-07-10T00:00:00.000Z"
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(now, now)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, 42, 'acme/api', ?)")
    .bind(now)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (102, 42, 'acme/web', ?)")
    .bind(now)
    .run()
  await connectLinearOrganization(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: 42,
      organizationId: "linear-acme",
      organizationName: "Acme Linear",
      appUserId: "linear-app-user",
      source: "oauth",
      grantedScopes: ["read", "write"],
      canAccessAllPublicTeams: false,
      installedByUserId: "111",
      installedByLogin: "octocat",
      teams: [
        { id: "team-api", key: "API", name: "API", githubRepoId: 0, githubRepoFullName: "" },
        { id: "team-web", key: "WEB", name: "Web", githubRepoId: 0, githubRepoFullName: "" },
      ],
      nowIso: now,
    },
  )
  const { kv } = makeKV()
  await createSession({
    kv,
    sessionId: "session-1",
    login: "octocat",
    githubUserId: 111,
    accessToken: "github-user-token",
    encryptionKeyB64url: ENC_KEY,
  })
  const broker = {
    getValidTenantToken: vi.fn(async () => ({ ok: true as const, accessToken: "linear-org-token" })),
    forceRefreshTenant: vi.fn(async () => ({ ok: true as const, accessToken: "linear-org-token" })),
  }
  const namespace = {
    idFromName: vi.fn((name: string) => ({ name })),
    get: vi.fn(() => broker),
  }
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
    LINEAR_TOKEN_BROKER: namespace,
    OPENCLAW_LINEAR_UNIFIED: "on",
  } as unknown as Env
  return { db, env, namespace }
}

function request(method: "GET" | "PUT", installationId: number, body?: unknown): Request {
  return new Request(`https://api.sigilix.ai/v1/org/${installationId}/linear-config`, {
    method,
    headers: {
      cookie: `${COOKIE}=session-1`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function stubExternalAccess(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://api.linear.app/graphql") {
        return new Response(
          JSON.stringify({
            data: {
              organization: { id: "linear-acme", name: "Acme Linear" },
              viewer: { id: "linear-app-user", name: "Sigilix", displayName: "Sigilix", app: true },
              teams: {
                nodes: [
                  { id: "team-api", key: "API", name: "API" },
                  { id: "team-web", key: "WEB", name: "Web" },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/user/installations/42/repositories")) {
        return new Response(
          JSON.stringify({
            repositories: [
              { id: 101, full_name: "acme/api" },
              { id: 102, full_name: "acme/web" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/user/installations")) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            installations: [{ id: 42, account: { type: "Organization", login: "acme" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url.includes("/user/memberships/orgs")) {
        return new Response(JSON.stringify([{ role: "admin", state: "active", organization: { login: "acme" } }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }),
  )
}

describe("Linear config route tenant contract", () => {
  beforeEach(stubExternalAccess)
  afterEach(() => vi.unstubAllGlobals())

  it("requires a session and exact-installation admin", async () => {
    const { env } = await setup()
    const noSession = await handleGetLinearConfig(
      new Request("https://api.sigilix.ai/v1/org/42/linear-config"),
      env,
      undefined,
      42,
    )
    expect(noSession.status).toBe(401)
    const crossTenant = await handleGetLinearConfig(request("GET", 999), env, undefined, 999)
    expect(crossTenant.status).toBe(403)
  })

  it("returns exact eligible repos, atomically persists bindings+scope, and rejects a stale revision", async () => {
    const { env, namespace } = await setup()
    const before = await handleGetLinearConfig(request("GET", 42), env, undefined, 42)
    expect(before.status).toBe(200)
    const beforeBody = (await before.json()) as {
      repositories: Array<{ githubRepoId: number; fullName: string }>
      teams: Array<{ warning: string | null }>
    }
    expect(beforeBody.repositories).toEqual([
      { githubRepoId: 101, fullName: "acme/api" },
      { githubRepoId: 102, fullName: "acme/web" },
    ])
    expect(beforeBody.teams.every((team) => team.warning === "missing_repo_binding")).toBe(true)

    const body = {
      revision: 1,
      contextMode: "disabled",
      scope: { mode: "explicit", teamIds: ["team-api"] },
      prValidation: false,
      createIssue: "disabled",
      planning: false,
      writeback: { comments: false, status: false, labels: false },
      bindings: [
        { teamId: "team-api", githubRepoId: 101 },
        { teamId: "team-web", githubRepoId: 102 },
      ],
    }
    const put = await handleSetLinearConfig(request("PUT", 42, body), env, undefined, 42)
    expect(put.status).toBe(200)
    const putBody = (await put.json()) as {
      config: { revision: number; scope: { teamIds: string[] }; contextMode: string }
      teams: Array<{ teamId: string; githubRepoId: number; warning: string | null }>
    }
    expect(putBody.config).toMatchObject({ revision: 2, contextMode: "disabled", scope: { teamIds: ["team-api"] } })
    expect(putBody.teams.map((team) => [team.teamId, team.githubRepoId, team.warning])).toEqual([
      ["team-api", 101, null],
      ["team-web", 102, null],
    ])
    expect(namespace.idFromName).toHaveBeenCalledWith("linear-org:v1:linear-acme")

    const stale = await handleSetLinearConfig(request("PUT", 42, body), env, undefined, 42)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: "stale-revision" })
  })

  it("keeps unimplemented high-risk settings dark", async () => {
    const { env } = await setup()
    const response = await handleSetLinearConfig(
      request("PUT", 42, {
        revision: 1,
        contextMode: "auto",
        scope: { mode: "auto", teamIds: [] },
        prValidation: true,
        createIssue: "auto",
        planning: true,
        writeback: { comments: true, status: true, labels: true },
        bindings: [
          { teamId: "team-api", githubRepoId: 101 },
          { teamId: "team-web", githubRepoId: 102 },
        ],
      }),
      env,
      undefined,
      42,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "invalid_config", reason: "unsafe-feature-dark" })
  })
})
