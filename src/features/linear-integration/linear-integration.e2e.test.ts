import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { handleLinearWebhook } from "@/src/index-webhooks"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  claimLinearDelivery,
  connectLinearOrganization,
  getLinearConfig,
  getLinearIntegrationSnapshot,
  resolveLinearTeamBinding,
  updateLinearConfig,
} from "@/src/features/linear-integration"
import type { Env } from "@/src/shared/types/env"

const BASE_SQL = readFileSync(new URL("../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")
const LINEAR_SQL = readFileSync(
  new URL("../../../migrations/0016_create_linear_integration.sql", import.meta.url),
  "utf8",
)
const SECRET = "linear-e2e-secret"

async function makeDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(BASE_SQL)
  await db.exec(LINEAR_SQL)
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, 'Organization', ?, ?)",
    )
    .bind(11, "acme", "2026-07-10T00:00:00.000Z", "2026-07-10T00:00:00.000Z")
    .run()
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, account_login, account_type, created_at, updated_at)" +
        " VALUES (?, ?, 'Organization', ?, ?)",
    )
    .bind(22, "globex", "2026-07-10T00:00:00.000Z", "2026-07-10T00:00:00.000Z")
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)")
    .bind(101, 11, "acme/api", "2026-07-10T00:00:00.000Z")
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (?, ?, ?, ?)")
    .bind(202, 22, "globex/web", "2026-07-10T00:00:00.000Z")
    .run()
  return db
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

async function seedConnection(
  db: D1Database,
  input: { installationId: number; orgId: string; teamId: string; repoId: number; repo: string },
): Promise<void> {
  const connected = await connectLinearOrganization(
    { SIGILIX_PLATFORM_DB: db },
    {
      installationId: input.installationId,
      organizationId: input.orgId,
      organizationName: input.orgId,
      appUserId: `app-${input.orgId}`,
      source: "oauth",
      grantedScopes: ["read", "write"],
      canAccessAllPublicTeams: false,
      installedByUserId: `user-${input.installationId}`,
      installedByLogin: `admin-${input.installationId}`,
      teams: [
        {
          id: input.teamId,
          key: input.teamId.toUpperCase(),
          name: input.teamId,
          githubRepoId: input.repoId,
          githubRepoFullName: input.repo,
        },
      ],
      nowIso: "2026-07-10T00:00:00.000Z",
    },
  )
  expect(connected).toEqual({ ok: true })
}

function configInput(revision: number, teamId: string) {
  return {
    revision,
    contextMode: "disabled" as const,
    scope: { mode: "explicit" as const, teamIds: [teamId] },
    prValidation: false,
    createIssue: "disabled" as const,
    planning: false,
    writeback: { comments: false, status: false, labels: false },
  }
}

async function sign(body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function webhookRequest(body: Record<string, unknown>, deliveryId: string): Promise<Request> {
  const raw = JSON.stringify(body)
  return new Request("https://api.sigilix.ai/linear/webhook", {
    method: "POST",
    headers: { "linear-signature": await sign(raw), "linear-delivery": deliveryId },
    body: raw,
  })
}

describe("SIG-242 Linear tenant boundary", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await makeDb()
    await seedConnection(db, { installationId: 11, orgId: "org-a", teamId: "team-a", repoId: 101, repo: "acme/api" })
    await seedConnection(db, {
      installationId: 22,
      orgId: "org-b",
      teamId: "team-b",
      repoId: 202,
      repo: "globex/web",
    })
  })

  it("keeps two organizations, configs, teams, revisions, and repo bindings isolated", async () => {
    expect((await getLinearIntegrationSnapshot({ SIGILIX_PLATFORM_DB: db }, 11)).connection?.organizationId).toBe(
      "org-a",
    )
    expect((await getLinearIntegrationSnapshot({ SIGILIX_PLATFORM_DB: db }, 22)).connection?.organizationId).toBe(
      "org-b",
    )

    const updated = await updateLinearConfig(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 11,
        input: configInput(1, "team-a"),
        bindings: [{ teamId: "team-a", githubRepoId: 101, githubRepoFullName: "acme/api" }],
        updatedBy: "alice",
        nowIso: "2026-07-10T00:01:00.000Z",
      },
    )
    expect(updated.ok && updated.config.revision).toBe(2)
    expect(updated.ok && updated.config.contextMode).toBe("disabled")
    expect((await getLinearConfig({ SIGILIX_PLATFORM_DB: db }, 22))?.revision).toBe(1)
    expect((await getLinearIntegrationSnapshot({ SIGILIX_PLATFORM_DB: db }, 22)).teams[0]?.githubRepoFullName).toBe(
      "globex/web",
    )

    const stale = await updateLinearConfig(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 11,
        input: configInput(1, "team-a"),
        bindings: [{ teamId: "team-a", githubRepoId: 101, githubRepoFullName: "acme/api" }],
        updatedBy: "alice",
        nowIso: "2026-07-10T00:02:00.000Z",
      },
    )
    expect(stale).toEqual({ ok: false, reason: "stale-revision" })

    const crossTenantTeam = await updateLinearConfig(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 11,
        input: configInput(2, "team-b"),
        bindings: [{ teamId: "team-b", githubRepoId: 202, githubRepoFullName: "globex/web" }],
        updatedBy: "alice",
        nowIso: "2026-07-10T00:03:00.000Z",
      },
    )
    expect(crossTenantTeam).toEqual({ ok: false, reason: "team-not-allowed" })
  })

  it("enforces one active organization per installation and one installation per organization", async () => {
    const installationConflict = await connectLinearOrganization(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 11,
        organizationId: "org-c",
        organizationName: "Org C",
        appUserId: "app-c",
        source: "oauth",
        grantedScopes: [],
        canAccessAllPublicTeams: false,
        installedByUserId: "u",
        installedByLogin: "u",
        teams: [],
        nowIso: "2026-07-10T00:04:00.000Z",
      },
    )
    expect(installationConflict).toEqual({ ok: false, reason: "installation-conflict" })

    const organizationConflict = await connectLinearOrganization(
      { SIGILIX_PLATFORM_DB: db },
      {
        installationId: 33,
        organizationId: "org-a",
        organizationName: "Org A",
        appUserId: "app-a",
        source: "oauth",
        grantedScopes: [],
        canAccessAllPublicTeams: false,
        installedByUserId: "u",
        installedByLogin: "u",
        teams: [],
        nowIso: "2026-07-10T00:04:00.000Z",
      },
    )
    expect(organizationConflict).toEqual({ ok: false, reason: "organization-conflict" })
  })

  it("does not report success when the guarded connection write loses a race", async () => {
    const raced = withBatch(db, async (statements) =>
      statements.map(() => ({ meta: { changes: 0 } }) as unknown as D1Result),
    )

    const result = await connectLinearOrganization(
      { SIGILIX_PLATFORM_DB: raced },
      {
        installationId: 11,
        organizationId: "org-a",
        organizationName: "Org A",
        appUserId: "app-org-a",
        source: "oauth",
        grantedScopes: [],
        canAccessAllPublicTeams: false,
        installedByUserId: "u",
        installedByLogin: "u",
        teams: [],
        nowIso: "2026-07-10T00:04:00.000Z",
      },
    )

    expect(result).toEqual({ ok: false, reason: "installation-conflict" })
  })

  it("does not resolve a revoked team binding", async () => {
    await db
      .prepare("UPDATE linear_team_binding SET access_state = 'revoked', selected = 0 WHERE team_id = ?")
      .bind("team-a")
      .run()

    await expect(resolveLinearTeamBinding({ SIGILIX_PLATFORM_DB: db }, "org-a", "team-a")).resolves.toBeNull()
  })

  it("verifies signed fresh delivery, dedupes it, rejects stale payloads, and returns 500/retries on queue failure", async () => {
    const send = vi.fn(async () => undefined)
    const env = {
      SIGILIX_PLATFORM_DB: db,
      LINEAR_WEBHOOK_SECRET: SECRET,
      OPENCLAW_JOBS: { send },
    } as unknown as Env
    const fresh = {
      action: "create",
      type: "Issue",
      organizationId: "org-a",
      webhookTimestamp: Date.now(),
      data: { id: "issue-a", team: { id: "team-a", key: "TEAM-A" } },
    }
    const first = await handleLinearWebhook(await webhookRequest(fresh, "delivery-a"), env, {} as ExecutionContext)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe("ok\n")
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "linear-triage",
        organizationId: "org-a",
        installationId: 11,
        teamId: "team-a",
        deliveryId: "delivery-a",
      }),
    )
    const duplicate = await handleLinearWebhook(await webhookRequest(fresh, "delivery-a"), env, {} as ExecutionContext)
    expect(duplicate.status).toBe(200)
    expect(send).toHaveBeenCalledTimes(1)

    const stale = await handleLinearWebhook(
      await webhookRequest({ ...fresh, webhookTimestamp: Date.now() - 61_000 }, "delivery-stale"),
      env,
      {} as ExecutionContext,
    )
    expect(stale.status).toBe(401)

    send.mockRejectedValueOnce(new Error("queue unavailable"))
    const failurePayload = { ...fresh, data: { id: "issue-retry", team: { id: "team-a", key: "TEAM-A" } } }
    const failed = await handleLinearWebhook(
      await webhookRequest(failurePayload, "delivery-retry"),
      env,
      {} as ExecutionContext,
    )
    expect(failed.status).toBe(500)
    const retried = await handleLinearWebhook(
      await webhookRequest(failurePayload, "delivery-retry"),
      env,
      {} as ExecutionContext,
    )
    expect(retried.status).toBe(200)
  })

  it("rejects a malformed signed payload before D1 work and ignores an unconnected organization", async () => {
    const send = vi.fn(async () => undefined)
    const env = {
      SIGILIX_PLATFORM_DB: db,
      LINEAR_WEBHOOK_SECRET: SECRET,
      OPENCLAW_JOBS: { send },
    } as unknown as Env
    const rowsBefore = await db
      .prepare("SELECT COUNT(*) AS count FROM linear_delivery_lease")
      .first<{ count: number }>()
    const malformed = await handleLinearWebhook(
      await webhookRequest(
        { action: "create", type: "Issue", organizationId: "org-a", webhookTimestamp: Date.now() },
        "delivery-malformed",
      ),
      env,
      {} as ExecutionContext,
    )

    expect(malformed.status).toBe(400)
    expect(await malformed.text()).toBe("invalid payload\n")
    expect(send).not.toHaveBeenCalled()
    const rowsAfter = await db.prepare("SELECT COUNT(*) AS count FROM linear_delivery_lease").first<{ count: number }>()
    expect(rowsAfter?.count).toBe(rowsBefore?.count)

    const unknownOrganization = await handleLinearWebhook(
      await webhookRequest(
        {
          action: "create",
          type: "Issue",
          organizationId: "org-not-connected",
          webhookTimestamp: Date.now(),
          data: { id: "issue-unknown", team: { id: "team-unknown" } },
        },
        "delivery-unknown-org",
      ),
      env,
      {} as ExecutionContext,
    )
    expect(unknownOrganization.status).toBe(200)
    expect(send).not.toHaveBeenCalled()
    const rowsFinal = await db.prepare("SELECT COUNT(*) AS count FROM linear_delivery_lease").first<{ count: number }>()
    expect(rowsFinal?.count).toBe(rowsBefore?.count)
  })

  it("never lets one organization's delivery lease claim the same id for another org", async () => {
    expect(
      await claimLinearDelivery(
        { SIGILIX_PLATFORM_DB: db },
        { deliveryId: "same-id", organizationId: "org-a", eventType: "Issue.create", nowMs: 100 },
      ),
    ).toBe("acquired")
    expect(
      await claimLinearDelivery(
        { SIGILIX_PLATFORM_DB: db },
        { deliveryId: "same-id", organizationId: "org-b", eventType: "Issue.create", nowMs: 100_000 },
      ),
    ).toBe("duplicate")
  })
})
