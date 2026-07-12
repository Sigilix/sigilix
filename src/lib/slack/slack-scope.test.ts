// SIG-196: unit tests for resolveSlackScope — DB-first channel→repo scope resolver
// with the SIGILIX_SLACK_SCOPE_MAP env map as the fallback path.
// Env-path scope-safety rule: an owner/repo is accepted ONLY if
// OPENCLAW_GITHUB_INSTALLATION_MAP has an EXACT "owner/repo" key. Owner-only
// entries do NOT authorize a repo. Fail-closed.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { resolveSlackScope } from "@/src/lib/slack/slack-scope"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const INSTALL = JSON.stringify({ "sigilix/sigilix": "111", acme: "222" })

const BASE_SQL = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const SLACK_SQL = readFileSync(
  new URL("../../../migrations/0019_create_slack_channel_repo.sql", import.meta.url),
  "utf8",
)

const NOW = "2026-07-11T00:00:00.000Z"

/** D1 with migration 0019 applied and one workspace (team TDB → installation 42)
 *  plus `repo` rows for installation 42 (acme/api 101, acme/web 102). */
async function makeSlackDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(SLACK_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (42, 'acme', 'Organization', ?, ?)",
    )
    .bind(NOW, NOW)
    .run()
  await db
    .prepare(
      "INSERT INTO slack_workspace (team_id, installation_id, installed_by, installed_at, updated_at)" +
        " VALUES ('TDB', 42, 'octocat', ?, ?)",
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
  return db
}

async function bindChannel(
  db: D1Database,
  channelId: string,
  opts: { useAllRepos?: boolean; repos?: Array<[number, string]> },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO slack_channel_binding (team_id, channel_id, installation_id, use_all_repos, created_at, updated_at)" +
        " VALUES ('TDB', ?, 42, ?, ?, ?)",
    )
    .bind(channelId, opts.useAllRepos ? 1 : 0, NOW, NOW)
    .run()
  for (const [repoId, fullName] of opts.repos ?? []) {
    await db
      .prepare(
        "INSERT INTO slack_channel_repo" +
          " (team_id, channel_id, installation_id, github_repo_id, github_repo_full_name, created_at, updated_at)" +
          " VALUES ('TDB', ?, 42, ?, ?, ?, ?)",
      )
      .bind(channelId, repoId, fullName, NOW, NOW)
      .run()
  }
}

describe("resolveSlackScope — D1 binding path", () => {
  it("resolves a DB-bound channel (explicit repo set, installation id from the binding)", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, "CDB1", { repos: [[101, "acme/api"]] })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: "{}", OPENCLAW_GITHUB_INSTALLATION_MAP: "{}", SIGILIX_PLATFORM_DB: db },
      { teamId: "TDB", channelId: "CDB1" },
    )
    expect(r).toEqual({
      ok: true,
      scope: {
        teamId: "TDB",
        channelId: "CDB1",
        repos: [{ owner: "acme", repo: "api", installationId: 42 }],
        linearTeam: null,
      },
    })
  })
  it("expands useAllRepos from the installation's repo table", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, "CALL1", { useAllRepos: true })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: "{}", OPENCLAW_GITHUB_INSTALLATION_MAP: "{}", SIGILIX_PLATFORM_DB: db },
      { teamId: "TDB", channelId: "CALL1" },
    )
    expect(r.ok && r.scope.repos).toEqual([
      { owner: "acme", repo: "api", installationId: 42 },
      { owner: "acme", repo: "web", installationId: 42 },
    ])
  })
  it("a DB binding is AUTHORITATIVE — it wins over an env entry for the same channel", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, "CBOTH", { repos: [[102, "acme/web"]] })
    const map = JSON.stringify({ "TDB:CBOTH": { repos: ["sigilix/sigilix"] } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL, SIGILIX_PLATFORM_DB: db },
      { teamId: "TDB", channelId: "CBOTH" },
    )
    expect(r.ok && r.scope.repos).toEqual([{ owner: "acme", repo: "web", installationId: 42 }])
  })
  it("a DB binding with no resolvable repos fails closed (no env fallthrough)", async () => {
    const db = await makeSlackDb()
    await bindChannel(db, "CEMPT", { repos: [] })
    const map = JSON.stringify({ "TDB:CEMPT": { repos: ["sigilix/sigilix"] } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL, SIGILIX_PLATFORM_DB: db },
      { teamId: "TDB", channelId: "CEMPT" },
    )
    expect(r).toEqual({ ok: false, reason: "no-installation" })
  })
  it("falls back to the env map when the channel has no DB binding (founder's beta channel)", async () => {
    const db = await makeSlackDb()
    const map = JSON.stringify({ "T0AFVBGRDRD:C0BEL8ZAARE": { repos: ["sigilix/sigilix"] } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL, SIGILIX_PLATFORM_DB: db },
      { teamId: "T0AFVBGRDRD", channelId: "C0BEL8ZAARE" },
    )
    expect(r).toEqual({
      ok: true,
      scope: {
        teamId: "T0AFVBGRDRD",
        channelId: "C0BEL8ZAARE",
        repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
        linearTeam: null,
      },
    })
  })
  it("falls back to the env map when migration 0019 hasn't been applied (table missing)", async () => {
    const db = makeD1() // no migrations at all — the DB query throws → env fallback
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"] } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL, SIGILIX_PLATFORM_DB: db },
      { teamId: "T1", channelId: "C1" },
    )
    expect(r.ok && r.scope.repos).toEqual([{ owner: "sigilix", repo: "sigilix", installationId: 111 }])
  })
  it("still returns no-config for a channel unmapped in BOTH the DB and the env map", async () => {
    const db = await makeSlackDb()
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: "{}", OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL, SIGILIX_PLATFORM_DB: db },
      { teamId: "T9", channelId: "C9" },
    )
    expect(r).toEqual({ ok: false, reason: "no-config" })
  })
})

describe("resolveSlackScope — env fallback path (no DB bound)", () => {
  it("resolves an exact-match repo", async () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"], linearTeam: "uuid-1" } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
      { teamId: "T1", channelId: "C1" },
    )
    expect(r).toEqual({
      ok: true,
      scope: {
        teamId: "T1",
        channelId: "C1",
        repos: [{ owner: "sigilix", repo: "sigilix", installationId: 111 }],
        linearTeam: "uuid-1",
      },
    })
  })
  it("DROPS a repo that only has an owner-only install entry (no owner fallback)", async () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["acme/widgets"] } }) // map only has "acme" owner-level
    expect(
      await resolveSlackScope(
        { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
        { teamId: "T1", channelId: "C1" },
      ),
    ).toEqual({ ok: false, reason: "no-installation" })
  })
  it("DROPS a repo with no install entry but keeps the exact one", async () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix", "evil/repo"] } })
    const r = await resolveSlackScope(
      { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
      { teamId: "T1", channelId: "C1" },
    )
    expect(r.ok && r.scope.repos.map((x) => x.repo)).toEqual(["sigilix"])
  })
  it("denies an unconfigured channel", async () => {
    expect(
      await resolveSlackScope(
        { SIGILIX_SLACK_SCOPE_MAP: "{}", OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
        { teamId: "T9", channelId: "C9" },
      ),
    ).toEqual({ ok: false, reason: "no-config" })
  })
  it("fails closed on malformed scope JSON", async () => {
    expect(
      (
        await resolveSlackScope(
          { SIGILIX_SLACK_SCOPE_MAP: "{nope", OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
          { teamId: "T1", channelId: "C1" },
        )
      ).ok,
    ).toBe(false)
  })
  it("DROPS a repo whose installation id is '0' → no-installation", async () => {
    const install = JSON.stringify({ "sigilix/sigilix": "0" })
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"] } })
    expect(
      await resolveSlackScope(
        { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: install },
        { teamId: "T1", channelId: "C1" },
      ),
    ).toEqual({ ok: false, reason: "no-installation" })
  })
  it("returns parse-error (not throw) when repos is not an array", async () => {
    const map = JSON.stringify({ "T1:C1": { repos: 42 } })
    await expect(
      resolveSlackScope(
        { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: INSTALL },
        { teamId: "T1", channelId: "C1" },
      ),
    ).resolves.toEqual({ ok: false, reason: "parse-error" })
  })
  it("fails closed → no-installation when OPENCLAW_GITHUB_INSTALLATION_MAP is malformed JSON", async () => {
    const map = JSON.stringify({ "T1:C1": { repos: ["sigilix/sigilix"] } })
    expect(
      await resolveSlackScope(
        { SIGILIX_SLACK_SCOPE_MAP: map, OPENCLAW_GITHUB_INSTALLATION_MAP: "{nope" },
        { teamId: "T1", channelId: "C1" },
      ),
    ).toEqual({ ok: false, reason: "no-installation" })
  })
})
