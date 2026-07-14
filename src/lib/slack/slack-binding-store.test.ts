import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { getSlackChannelDbScope } from "@/src/lib/slack/slack-binding-store"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const BASE_SQL = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(
  new URL("../../../migrations/0019_create_slack_channel_repo.sql", import.meta.url),
  "utf8",
)
const NOW = "2026-07-13T00:00:00.000Z"

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
        " VALUES ('TACME', 42, 'octocat', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (101, 42, 'acme/api', ?)")
    .bind(NOW)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (202, 77, 'globex/web', ?)")
    .bind(NOW)
    .run()
  return db
}

async function insertBinding(
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
        " VALUES ('TACME', ?, ?, ?, ?, ?)",
    )
    .bind(args.channelId, bindingInstallationId, args.useAllRepos ? 1 : 0, NOW, NOW)
    .run()
  for (const repo of args.repos ?? []) {
    await db
      .prepare(
        "INSERT INTO slack_channel_repo" +
          " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
          " VALUES ('TACME', ?, ?, ?, ?, ?, ?)",
      )
      .bind(args.channelId, repo.installationId ?? bindingInstallationId, repo.repoId, repo.fullName, NOW, NOW)
      .run()
  }
}

describe("getSlackChannelDbScope", () => {
  it("returns a discriminated unbound result when D1 is not configured", async () => {
    await expect(getSlackChannelDbScope({}, { teamId: "TACME", channelId: "CAPI1" })).resolves.toEqual({
      kind: "unbound",
    })
  })

  it("returns absent only after a healthy D1 query finds no channel binding", async () => {
    const db = await makeSlackDb()
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CMISSING" }),
    ).resolves.toEqual({ kind: "absent" })
  })

  it("returns unavailable when the bound D1 schema cannot be queried", async () => {
    const db = makeD1()
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CAPI1" }),
    ).resolves.toEqual({ kind: "unavailable" })
  })

  it("returns the raw explicit repo ids for a consistent binding", async () => {
    const db = await makeSlackDb()
    await insertBinding(db, {
      channelId: "CAPI1",
      repos: [{ repoId: 101, fullName: "acme/api" }],
    })
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CAPI1" }),
    ).resolves.toEqual({
      kind: "bound",
      installationId: 42,
      useAllRepos: false,
      repos: [{ githubRepoId: 101, githubRepoFullName: "acme/api" }],
    })
  })

  it("returns a raw use-all selection without expanding the D1 repo table", async () => {
    const db = await makeSlackDb()
    await insertBinding(db, { channelId: "CALL1", useAllRepos: true })
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CALL1" }),
    ).resolves.toEqual({
      kind: "bound",
      installationId: 42,
      useAllRepos: true,
      repos: [],
    })
  })

  it("marks a workspace/binding installation mismatch invalid", async () => {
    const db = await makeSlackDb()
    await insertBinding(db, {
      channelId: "CWRONG1",
      bindingInstallationId: 77,
      repos: [{ repoId: 202, fullName: "globex/web", installationId: 77 }],
    })
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CWRONG1" }),
    ).resolves.toEqual({ kind: "invalid" })
  })

  it("marks an explicit-row/binding installation mismatch invalid", async () => {
    const db = await makeSlackDb()
    await insertBinding(db, {
      channelId: "CWRONG2",
      repos: [{ repoId: 202, fullName: "globex/web", installationId: 77 }],
    })
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CWRONG2" }),
    ).resolves.toEqual({ kind: "invalid" })
  })

  it.each([
    { repoId: Number.MAX_SAFE_INTEGER + 1, fullName: "acme/api" },
    { repoId: 101, fullName: "acme/api/extra" },
    { repoId: 101, fullName: "/api" },
  ])("marks unsafe or malformed explicit repo data invalid: $fullName / $repoId", async (repo) => {
    const db = await makeSlackDb()
    await insertBinding(db, { channelId: "CINVALID1", repos: [repo] })
    await expect(
      getSlackChannelDbScope({ SIGILIX_PLATFORM_DB: db }, { teamId: "TACME", channelId: "CINVALID1" }),
    ).resolves.toEqual({ kind: "invalid" })
  })
})
