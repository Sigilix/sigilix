// Slack channel→repo binding route — tenant contract tests (mirrors
// linear-config-route.e2e.test.ts). Covers session/admin gating, the connected-
// workspace requirement, binding persistence, org isolation (an org cannot bind
// a repo outside its own eligible set), and the end-to-end proof that a saved
// binding resolves through resolveSlackScope while the env map keeps working.

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import { handleGetSlackConfig, handleSetSlackConfig } from "@/src/lib/slack-config-route"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { upsertSlackWorkspace } from "@/src/lib/slack/slack-binding-store"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const { getInstallationTokenMock, listGithubAppInstallationReposMock } = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(),
  listGithubAppInstallationReposMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/shared/adapters/github/github-app")>()),
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/lib/github-user-repo-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/lib/github-user-repo-scope")>()),
  listGithubAppInstallationRepos: listGithubAppInstallationReposMock,
}))

const BASE_SQL = readFileSync(new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const IDENTITY_SQL = readFileSync(new URL("../../migrations/0006_create_user_identity.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(new URL("../../migrations/0019_create_slack_channel_repo.sql", import.meta.url), "utf8")
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(7))
const COOKIE = "__Host-sigilix_session"
const NOW = "2026-07-11T00:00:00.000Z"

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

async function setup(options?: { connectWorkspace?: boolean }) {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(IDENTITY_SQL)
  await db.exec(SLACK_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, 42, 'acme/api', ?)")
    .bind(NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (102, 42, 'acme/web', ?)")
    .bind(NOW)
    .run()
  // Another tenant's repo — must never be bindable by installation 42.
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (77, 'globex', 'Organization', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (202, 77, 'globex/web', ?)")
    .bind(NOW)
    .run()
  if (options?.connectWorkspace !== false) {
    await upsertSlackWorkspace(
      { SIGILIX_PLATFORM_DB: db },
      { teamId: "TACME", installationId: 42, installedBy: "octocat", nowIso: NOW },
    )
  }
  const { kv } = makeKV()
  const userId = "slack-config-user-111"
  await db
    .prepare(
      "INSERT INTO user_identity" +
        " (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, '111', ?, ?, ?)",
    )
    .bind(userId, JSON.stringify(["github"]), NOW, NOW)
    .run()
  await createSession({
    kv,
    sessionId: "session-1",
    login: "octocat",
    githubUserId: 111,
    userId,
    accessToken: "github-user-token",
    encryptionKeyB64url: ENC_KEY,
  })
  const env = {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    SIGILIX_PLATFORM_DB: db,
  } as unknown as Env
  return { db, env }
}

function request(method: "GET" | "PUT", installationId: number, body?: unknown): Request {
  return new Request(`https://api.sigilix.ai/v1/org/${installationId}/slack-config`, {
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

describe("Slack config route tenant contract", () => {
  beforeEach(() => {
    stubExternalAccess()
    getInstallationTokenMock.mockReset().mockImplementation(async (args: { installationId: number }) => {
      return `token-${args.installationId}`
    })
    listGithubAppInstallationReposMock
      .mockReset()
      .mockImplementation(async (_token: string, installationId: number) => {
        const repos =
          installationId === 42
            ? [
                { repoId: 101, owner: "acme", repo: "api" },
                { repoId: 102, owner: "acme", repo: "web" },
              ]
            : installationId === 111
              ? [{ repoId: 301, owner: "sigilix", repo: "sigilix" }]
              : []
        return { ok: true, repos: repos.map((repo) => ({ installationId, ...repo })) }
      })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("requires a session and exact-installation admin", async () => {
    const { env } = await setup()
    const noSession = await handleGetSlackConfig(
      new Request("https://api.sigilix.ai/v1/org/42/slack-config"),
      env,
      undefined,
      42,
    )
    expect(noSession.status).toBe(401)
    const crossTenant = await handleGetSlackConfig(request("GET", 999), env, undefined, 999)
    expect(crossTenant.status).toBe(403)
  })

  it("GET returns the linked workspace, eligible repos, and current bindings", async () => {
    const { env } = await setup()
    const res = await handleGetSlackConfig(request("GET", 42), env, undefined, 42)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      workspace: { teamId: "TACME", installedAt: NOW },
      bindings: [],
      repositories: [
        { githubRepoId: 101, fullName: "acme/api" },
        { githubRepoId: 102, fullName: "acme/web" },
      ],
    })
  })

  it("PUT persists channel bindings and the saved binding resolves via resolveSlackScope (DB path)", async () => {
    const { env } = await setup()
    const put = await handleSetSlackConfig(
      request("PUT", 42, {
        bindings: [
          { channelId: "C0CUSTOMER1", githubRepoIds: [101] },
          { channelId: "C0CUSTOMER2", useAllRepos: true },
        ],
      }),
      env,
      undefined,
      42,
    )
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({
      workspace: { teamId: "TACME" },
      bindings: [
        { channelId: "C0CUSTOMER1", useAllRepos: false, repos: [{ githubRepoId: 101, fullName: "acme/api" }] },
        { channelId: "C0CUSTOMER2", useAllRepos: true, repos: [] },
      ],
    })

    // End-to-end: the DB binding now resolves the customer's channel…
    const scopeEnv = {
      ...env,
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "test-private-key",
      SIGILIX_SLACK_SCOPE_MAP: '{"T0AFVBGRDRD:C0BEL8ZAARE":{"repos":["sigilix/sigilix"]}}',
      OPENCLAW_GITHUB_INSTALLATION_MAP: '{"sigilix/sigilix":"111"}',
    } as Env
    const explicit = await resolveSlackScope(scopeEnv, { teamId: "TACME", channelId: "C0CUSTOMER1" })
    expect(explicit).toEqual({
      ok: true,
      scope: {
        teamId: "TACME",
        channelId: "C0CUSTOMER1",
        installationId: 42,
        repos: [{ githubRepoId: 101, owner: "acme", repo: "api" }],
        linearTeam: null,
      },
    })
    const allRepos = await resolveSlackScope(scopeEnv, { teamId: "TACME", channelId: "C0CUSTOMER2" })
    expect(allRepos.ok && allRepos.scope.repos.map((r) => r.repo)).toEqual(["api", "web"])
    // …while the founder's env-mapped beta channel still resolves untouched…
    const beta = await resolveSlackScope(scopeEnv, { teamId: "T0AFVBGRDRD", channelId: "C0BEL8ZAARE" })
    expect(beta.ok && beta.scope.repos).toEqual([{ githubRepoId: 301, owner: "sigilix", repo: "sigilix" }])
    // …and an unmapped channel still gets no-config.
    expect(await resolveSlackScope(scopeEnv, { teamId: "TACME", channelId: "C0UNMAPPED9" })).toEqual({
      ok: false,
      reason: "no-config",
    })
  })

  it("ORG ISOLATION — rejects a repo id outside the caller's installation (another org's repo)", async () => {
    const { env, db } = await setup()
    const res = await handleSetSlackConfig(
      request("PUT", 42, { bindings: [{ channelId: "C0EVIL11111", githubRepoIds: [202] }] }),
      env,
      undefined,
      42,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "slack_channel_repo_binding_invalid", channelId: "C0EVIL11111" })
    // Nothing was written.
    const rows = await db.prepare("SELECT channel_id FROM slack_channel_binding").all()
    expect(rows.results).toEqual([])
  })

  it("409s when the org has no linked Slack workspace yet", async () => {
    const { env } = await setup({ connectWorkspace: false })
    const res = await handleSetSlackConfig(
      request("PUT", 42, { bindings: [{ channelId: "C0CUSTOMER1", githubRepoIds: [101] }] }),
      env,
      undefined,
      42,
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "slack_not_connected" })
  })

  it("rejects malformed binding shapes (closed contract)", async () => {
    const { env } = await setup()
    for (const bindings of [
      [{ channelId: "not a channel id", githubRepoIds: [101] }],
      [{ channelId: "C0CUSTOMER1", githubRepoIds: [] }],
      [{ channelId: "C0CUSTOMER1", useAllRepos: false }],
      [{ channelId: "C0CUSTOMER1", githubRepoIds: [101], useAllRepos: true }],
      [
        { channelId: "C0CUSTOMER1", githubRepoIds: [101] },
        { channelId: "C0CUSTOMER1", githubRepoIds: [102] },
      ],
    ]) {
      const res = await handleSetSlackConfig(request("PUT", 42, { bindings }), env, undefined, 42)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: "invalid_bindings" })
    }
  })
})
