import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import type { Env } from "@/src/shared/types/env"

const { getInstallationTokenMock, listGithubAppInstallationReposMock } = vi.hoisted(() => ({
  getInstallationTokenMock: vi.fn(),
  listGithubAppInstallationReposMock: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: getInstallationTokenMock,
}))

vi.mock("@/src/lib/github-user-repo-scope", () => ({
  listGithubAppInstallationRepos: listGithubAppInstallationReposMock,
}))

import { resolveSlackScope } from "@/src/lib/slack/slack-scope"

const BASE_SQL = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(
  new URL("../../../migrations/0019_create_slack_channel_repo.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-13T00:00:00.000Z"

interface LiveRepo {
  repoId: number
  owner: string
  repo: string
}

const liveByInstallation = new Map<number, LiveRepo[]>()

function makeKv(): KVNamespace {
  return {
    get: vi.fn(async () => null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace
}

function makeEnv(
  args: {
    db?: D1Database
    scopeMap?: string
    installationMap?: string
  } = {},
): Env {
  return {
    OPENCLAW_STATE: makeKv(),
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "test-private-key",
    SIGILIX_SLACK_SCOPE_MAP: args.scopeMap ?? "{}",
    OPENCLAW_GITHUB_INSTALLATION_MAP: args.installationMap ?? "{}",
    ...(args.db ? { SIGILIX_PLATFORM_DB: args.db } : {}),
  } as unknown as Env
}

function allowLive(installationId: number, repos: LiveRepo[]): void {
  liveByInstallation.set(installationId, repos)
}

async function makeSlackDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(SLACK_SQL)
  for (const [installationId, login] of [
    [42, "acme"],
    [77, "globex"],
  ] as const) {
    await db
      .prepare(
        "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
          " VALUES (?, ?, 'Organization', ?, ?)",
      )
      .bind(installationId, login, NOW, NOW)
      .run()
  }
  await db
    .prepare(
      "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
        " VALUES ('TDB', 42, 'octocat', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, 42, 'acme/stale', ?)")
    .bind(NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (102, 42, 'acme/removed', ?)")
    .bind(NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (202, 77, 'globex/web', ?)")
    .bind(NOW)
    .run()
  return db
}

async function bindChannel(
  db: D1Database,
  args: {
    channelId: string
    bindingInstallationId?: number
    useAllRepos?: boolean
    repos?: Array<{ repoId: number; fullName: string; installationId?: number }>
  },
): Promise<void> {
  const bindingInstallationId = args.bindingInstallationId ?? 42
  await db
    .prepare(
      "INSERT INTO slack_channel_binding" +
        " (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
        " VALUES ('TDB', ?, ?, ?, ?, ?)",
    )
    .bind(args.channelId, bindingInstallationId, args.useAllRepos ? 1 : 0, NOW, NOW)
    .run()
  for (const repo of args.repos ?? []) {
    await db
      .prepare(
        "INSERT INTO slack_channel_repo" +
          " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
          " VALUES ('TDB', ?, ?, ?, ?, ?, ?)",
      )
      .bind(args.channelId, repo.installationId ?? bindingInstallationId, repo.repoId, repo.fullName, NOW, NOW)
      .run()
  }
}

function authorityEvents(logSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return logSpy.mock.calls.flatMap((call) => {
    if (typeof call[0] !== "string") return []
    try {
      const parsed = JSON.parse(call[0]) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
}

beforeEach(() => {
  liveByInstallation.clear()
  getInstallationTokenMock.mockReset().mockImplementation(async (args: { installationId: number }) => {
    return "token-" + String(args.installationId)
  })
  listGithubAppInstallationReposMock.mockReset().mockImplementation(async (_token: string, installationId: number) => ({
    ok: true,
    repos: (liveByInstallation.get(installationId) ?? []).map((repo) => ({ installationId, ...repo })),
  }))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("resolveSlackScope exact D1 authority", () => {
  it("threads the caller deadline through token exchange and live repository reconciliation", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CABORT1",
      repos: [{ repoId: 101, fullName: "acme/api" }],
    })
    allowLive(42, [{ repoId: 101, owner: "acme", repo: "api" }])
    const controller = new AbortController()

    await expect(
      resolveSlackScope(makeEnv({ db }), {
        teamId: "TDB",
        channelId: "CABORT1",
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(getInstallationTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 42, signal: controller.signal }),
    )
    expect(listGithubAppInstallationReposMock).toHaveBeenCalledWith("token-42", 42, {
      signal: controller.signal,
    })
  })

  it("reconciles an explicit binding by immutable repo id and emits the current GitHub name", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CRENAME1",
      repos: [{ repoId: 101, fullName: "acme/old-name" }],
    })
    allowLive(42, [{ repoId: 101, owner: "acme", repo: "api-renamed" }])

    await expect(resolveSlackScope(makeEnv({ db }), { teamId: "TDB", channelId: "CRENAME1" })).resolves.toEqual({
      ok: true,
      scope: {
        teamId: "TDB",
        channelId: "CRENAME1",
        installationId: 42,
        repos: [{ githubRepoId: 101, owner: "acme", repo: "api-renamed" }],
        linearTeam: null,
      },
    })
    expect(getInstallationTokenMock).toHaveBeenCalledWith(expect.objectContaining({ installationId: 42 }))
    expect(listGithubAppInstallationReposMock).toHaveBeenCalledWith("token-42", 42)
  })

  it("expands use-all from the complete live App list, never the stale D1 repo table", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, { channelId: "CALL1", useAllRepos: true })
    allowLive(42, [
      { repoId: 101, owner: "acme", repo: "api-renamed" },
      { repoId: 103, owner: "acme", repo: "new-service" },
    ])

    const result = await resolveSlackScope(makeEnv({ db }), { teamId: "TDB", channelId: "CALL1" })
    expect(result).toEqual({
      ok: true,
      scope: {
        teamId: "TDB",
        channelId: "CALL1",
        installationId: 42,
        repos: [
          { githubRepoId: 101, owner: "acme", repo: "api-renamed" },
          { githubRepoId: 103, owner: "acme", repo: "new-service" },
        ],
        linearTeam: null,
      },
    })
  })

  it("denies a removed explicit repo and never falls through to an env mapping for that channel", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CREMOVED1",
      repos: [{ repoId: 101, fullName: "acme/api" }],
    })
    allowLive(42, [{ repoId: 102, owner: "acme", repo: "other" }])
    allowLive(111, [{ repoId: 901, owner: "legacy", repo: "repo" }])
    const scopeMap = JSON.stringify({ "TDB:CREMOVED1": { repos: ["legacy/repo"] } })
    const installationMap = JSON.stringify({ "legacy/repo": "111" })

    await expect(
      resolveSlackScope(makeEnv({ db, scopeMap, installationMap }), {
        teamId: "TDB",
        channelId: "CREMOVED1",
      }),
    ).resolves.toEqual({ ok: false, reason: "no-installation" })
    expect(getInstallationTokenMock).toHaveBeenCalledTimes(1)
    expect(getInstallationTokenMock).toHaveBeenCalledWith(expect.objectContaining({ installationId: 42 }))
  })

  it("treats a workspace/binding installation mismatch as authoritative invalid D1", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CWRONG1",
      bindingInstallationId: 77,
      repos: [{ repoId: 202, fullName: "globex/web", installationId: 77 }],
    })
    const scopeMap = JSON.stringify({ "TDB:CWRONG1": { repos: ["legacy/repo"] } })
    const installationMap = JSON.stringify({ "legacy/repo": "111" })

    await expect(
      resolveSlackScope(makeEnv({ db, scopeMap, installationMap }), { teamId: "TDB", channelId: "CWRONG1" }),
    ).resolves.toEqual({ ok: false, reason: "invalid-binding" })
    expect(getInstallationTokenMock).not.toHaveBeenCalled()
    expect(listGithubAppInstallationReposMock).not.toHaveBeenCalled()
  })

  it("treats an explicit-row/binding installation mismatch as authoritative invalid D1", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CWRONG2",
      repos: [{ repoId: 202, fullName: "globex/web", installationId: 77 }],
    })
    const scopeMap = JSON.stringify({ "TDB:CWRONG2": { repos: ["legacy/repo"] } })
    const installationMap = JSON.stringify({ "legacy/repo": "111" })

    await expect(
      resolveSlackScope(makeEnv({ db, scopeMap, installationMap }), { teamId: "TDB", channelId: "CWRONG2" }),
    ).resolves.toEqual({ ok: false, reason: "invalid-binding" })
    expect(getInstallationTokenMock).not.toHaveBeenCalled()
  })

  it("fails closed when a bound D1 cannot be queried and never uses the env fallback", async () => {
    const db = makeD1()
    const scopeMap = JSON.stringify({ "TDB:CFAIL1": { repos: ["legacy/repo"] } })
    const installationMap = JSON.stringify({ "legacy/repo": "111" })

    await expect(
      resolveSlackScope(makeEnv({ db, scopeMap, installationMap }), { teamId: "TDB", channelId: "CFAIL1" }),
    ).resolves.toEqual({ ok: false, reason: "scope-unavailable" })
    expect(getInstallationTokenMock).not.toHaveBeenCalled()
  })

  it("fails closed when the complete live App repository lookup is unavailable", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, {
      channelId: "CTIMEOUT1",
      repos: [{ repoId: 101, fullName: "acme/api" }],
    })
    listGithubAppInstallationReposMock.mockResolvedValueOnce({ ok: false, reason: "timeout" })

    await expect(resolveSlackScope(makeEnv({ db }), { teamId: "TDB", channelId: "CTIMEOUT1" })).resolves.toEqual({
      ok: false,
      reason: "scope-unavailable",
    })
  })
})

describe("resolveSlackScope legacy authority", () => {
  const LEGACY_SCOPE = JSON.stringify({ "TLEGACY:CLEGACY": { repos: ["sigilix/sigilix"] } })
  const LEGACY_INSTALLATIONS = JSON.stringify({ "sigilix/sigilix": "111" })

  it("uses the legacy map when D1 is unbound, reconciles live ids, and logs that authority decision", async () => {
    allowLive(111, [{ repoId: 901, owner: "Sigilix", repo: "sigilix" }])
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    await expect(
      resolveSlackScope(makeEnv({ scopeMap: LEGACY_SCOPE, installationMap: LEGACY_INSTALLATIONS }), {
        teamId: "TLEGACY",
        channelId: "CLEGACY",
      }),
    ).resolves.toEqual({
      ok: true,
      scope: {
        teamId: "TLEGACY",
        channelId: "CLEGACY",
        installationId: 111,
        repos: [{ githubRepoId: 901, owner: "Sigilix", repo: "sigilix" }],
        linearTeam: null,
      },
    })
    expect(authorityEvents(logSpy)).toContainEqual(
      expect.objectContaining({
        event: "slack-scope-authority",
        authority: "legacy-env",
        dbState: "unbound",
        teamId: "TLEGACY",
        channelId: "CLEGACY",
      }),
    )
  })

  it("uses the legacy map after a healthy absent D1 lookup and logs that authority decision", async () => {
    const db = await makeSlackDb()
    allowLive(111, [{ repoId: 901, owner: "sigilix", repo: "sigilix" }])
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)

    const result = await resolveSlackScope(
      makeEnv({ db, scopeMap: LEGACY_SCOPE, installationMap: LEGACY_INSTALLATIONS }),
      { teamId: "TLEGACY", channelId: "CLEGACY" },
    )
    expect(result.ok && result.scope.installationId).toBe(111)
    expect(authorityEvents(logSpy)).toContainEqual(
      expect.objectContaining({
        event: "slack-scope-authority",
        authority: "legacy-env",
        dbState: "absent",
      }),
    )
  })

  it("rejects a legacy channel whose repos resolve to different installations before live lookup", async () => {
    const scopeMap = JSON.stringify({ "TLEGACY:CLEGACY": { repos: ["acme/api", "globex/web"] } })
    const installationMap = JSON.stringify({ "acme/api": "42", "globex/web": "77" })

    await expect(
      resolveSlackScope(makeEnv({ scopeMap, installationMap }), {
        teamId: "TLEGACY",
        channelId: "CLEGACY",
      }),
    ).resolves.toEqual({ ok: false, reason: "no-installation" })
    expect(getInstallationTokenMock).not.toHaveBeenCalled()
    expect(listGithubAppInstallationReposMock).not.toHaveBeenCalled()
  })

  it.each(["1.5", String(Number.MAX_SAFE_INTEGER + 1), true, [111], { id: 111 }])(
    "rejects malformed or unsafe legacy installation id %# before live lookup",
    async (installationId) => {
      const installationMap = JSON.stringify({ "sigilix/sigilix": installationId })
      await expect(
        resolveSlackScope(makeEnv({ scopeMap: LEGACY_SCOPE, installationMap }), {
          teamId: "TLEGACY",
          channelId: "CLEGACY",
        }),
      ).resolves.toEqual({ ok: false, reason: "no-installation" })
      expect(getInstallationTokenMock).not.toHaveBeenCalled()
    },
  )

  it("fails closed when live reconciliation removes the legacy repo", async () => {
    allowLive(111, [{ repoId: 902, owner: "sigilix", repo: "other" }])
    await expect(
      resolveSlackScope(makeEnv({ scopeMap: LEGACY_SCOPE, installationMap: LEGACY_INSTALLATIONS }), {
        teamId: "TLEGACY",
        channelId: "CLEGACY",
      }),
    ).resolves.toEqual({ ok: false, reason: "no-installation" })
  })

  it("retains closed parsing and no-config failures", async () => {
    await expect(
      resolveSlackScope(makeEnv({ scopeMap: "{nope", installationMap: LEGACY_INSTALLATIONS }), {
        teamId: "TLEGACY",
        channelId: "CLEGACY",
      }),
    ).resolves.toEqual({ ok: false, reason: "parse-error" })
    await expect(resolveSlackScope(makeEnv(), { teamId: "TLEGACY", channelId: "CLEGACY" })).resolves.toEqual({
      ok: false,
      reason: "no-config",
    })
  })
})
