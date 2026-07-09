// SIG-343 PR C Task 2 + Task 8 — d1-tenant-store unit tests.
//
// Schema is owned by the migration; no ensureSchema here.
// The shim's exec() applies the migration SQL before each test.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  upsertTenantAndRepo,
  upsertTenantTier,
  upsertTenantAccount,
  readTenantConfig,
  readTenantSubscriptionStatus,
  resolveInstallationByAccountLogin,
  readTenantBillingGuard,
} from "@/src/features/tenancy/adapters/d1-tenant-store"
import type { Env } from "@/src/shared/types/env"

// sig-trial-cap: apply 0001 (tenant table) + 0011 (subscription_status column) so the
// shim schema matches production, which the tier UPSERT + status read both depend on.
const MIGRATION_0001_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0011_SQL = readFileSync(
  new URL("../../../../migrations/0011_add_tenant_subscription_status.sql", import.meta.url),
  "utf8",
)
// sig-github-marketplace-billing: 0012 adds tenant.billing_source, co-written by the tier UPSERT.
const MIGRATION_0012_SQL = readFileSync(
  new URL("../../../../migrations/0012_add_tenant_billing_source.sql", import.meta.url),
  "utf8",
)
const MIGRATION_SQL = [MIGRATION_0001_SQL, MIGRATION_0011_SQL, MIGRATION_0012_SQL].join("\n")

function makeEnv(db: D1Database): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return { SIGILIX_PLATFORM_DB: db }
}

function makeAbsentEnv(): Pick<Env, "SIGILIX_PLATFORM_DB"> {
  return {}
}

/** Throws on any operation — simulates a D1 error to verify fail-open behaviour. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
    batch() {
      return Promise.reject(new Error("simulated D1 error"))
    },
    exec() {
      return Promise.reject(new Error("simulated D1 error"))
    },
  } as unknown as D1Database
}

describe("upsertTenantAndRepo", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("creates a tenant row and a repo row on first call", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/widgets",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const tenant = await db
      .prepare("SELECT installation_id, concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(1)
      .first<{ installation_id: number; concurrency_cap: number | null }>()
    expect(tenant?.installation_id).toBe(1)
    expect(tenant?.concurrency_cap).toBeNull() // nullable — no schema DEFAULT

    const repo = await db
      .prepare("SELECT full_name, updated_at FROM repo WHERE repo_id = ?")
      .bind(100)
      .first<{ full_name: string; updated_at: string }>()
    expect(repo?.full_name).toBe("acme/widgets")
    expect(repo?.updated_at).toBe("2026-01-01T00:00:00Z")
  })

  it("re-upsert refreshes repo.full_name + updated_at but preserves operator-tuned concurrency_cap", async () => {
    // First call
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/old-name",
      nowIso: "2026-01-01T00:00:00Z",
    })

    // Operator tunes the cap
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(5, 1).run()

    // Second call with a different name
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 1,
      repoId: 100,
      fullName: "acme/new-name",
      nowIso: "2026-06-01T00:00:00Z",
    })

    // COALESCE upsert must have left concurrency_cap alone (untouched by DO UPDATE)
    const tenant = await db
      .prepare("SELECT concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(1)
      .first<{ concurrency_cap: number }>()
    expect(tenant?.concurrency_cap).toBe(5)

    // ON CONFLICT DO UPDATE must have refreshed repo fields
    const repo = await db
      .prepare("SELECT full_name, updated_at FROM repo WHERE repo_id = ?")
      .bind(100)
      .first<{ full_name: string; updated_at: string }>()
    expect(repo?.full_name).toBe("acme/new-name")
    expect(repo?.updated_at).toBe("2026-06-01T00:00:00Z")
  })

  it("binding absent — resolves without throwing and inserts nothing", async () => {
    await expect(
      upsertTenantAndRepo(makeAbsentEnv(), {
        installationId: 1,
        repoId: 100,
        fullName: "acme/widgets",
        nowIso: "2026-01-01T00:00:00Z",
      }),
    ).resolves.toBeUndefined()

    // Nothing was written to the real db
    const count = await db.prepare("SELECT COUNT(*) AS n FROM tenant").first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("thrown query — no-op, never throws (fail-open)", async () => {
    await expect(
      upsertTenantAndRepo(
        { SIGILIX_PLATFORM_DB: makeBrokenDb() },
        {
          installationId: 1,
          repoId: 100,
          fullName: "acme/widgets",
          nowIso: "2026-01-01T00:00:00Z",
        },
      ),
    ).resolves.toBeUndefined()
  })

  it("first insert stores account_login and account_type", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 10,
      repoId: 1000,
      fullName: "acme/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "acme-org",
      accountType: "Organization",
    })

    const tenant = await db
      .prepare("SELECT account_login, account_type FROM tenant WHERE installation_id = ?")
      .bind(10)
      .first<{ account_login: string; account_type: string }>()
    expect(tenant?.account_login).toBe("acme-org")
    expect(tenant?.account_type).toBe("Organization")
  })

  it("re-upsert with changed accountLogin updates account_login but preserves operator-set concurrency_cap", async () => {
    // First insert
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 11,
      repoId: 1100,
      fullName: "beta/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "beta-old",
      accountType: "Organization",
    })

    // Operator tunes the cap
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(7, 11).run()

    // Re-upsert with a renamed account login
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 11,
      repoId: 1100,
      fullName: "beta/repo",
      nowIso: "2026-06-01T00:00:00Z",
      accountLogin: "beta-new",
      accountType: "Organization",
    })

    const tenant = await db
      .prepare("SELECT account_login, concurrency_cap FROM tenant WHERE installation_id = ?")
      .bind(11)
      .first<{ account_login: string; concurrency_cap: number }>()
    // COALESCE upsert refreshes the login
    expect(tenant?.account_login).toBe("beta-new")
    // operator-tuned cap is preserved
    expect(tenant?.concurrency_cap).toBe(7)
  })

  it("re-upsert with undefined accountLogin does NOT overwrite stored login (COALESCE)", async () => {
    // First insert with a known login
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 12,
      repoId: 1200,
      fullName: "gamma/repo",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "gamma-org",
      accountType: "Organization",
    })

    // Re-upsert without accountLogin (e.g. from a stale-head requeue that omits it)
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 12,
      repoId: 1200,
      fullName: "gamma/repo",
      nowIso: "2026-06-01T00:00:00Z",
    })

    const tenant = await db
      .prepare("SELECT account_login FROM tenant WHERE installation_id = ?")
      .bind(12)
      .first<{ account_login: string }>()
    // COALESCE(NULL, existing) must preserve the existing login
    expect(tenant?.account_login).toBe("gamma-org")
  })
})

describe("readTenantConfig", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("returns {cap, dailyBudget} for a tenant with both fields set", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 3,
      repoId: 300,
      fullName: "acme/api",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await db
      .prepare("UPDATE tenant SET concurrency_cap = ?, daily_budget = ? WHERE installation_id = ?")
      .bind(8, 1000, 3)
      .run()

    const cfg = await readTenantConfig(makeEnv(db), 3)
    expect(cfg).toEqual({ cap: 8, dailyBudget: 1000 })
  })

  it("returns {cap: null, dailyBudget: null} for a freshly-registered tenant (columns are NULL)", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 4,
      repoId: 400,
      fullName: "acme/fresh",
      nowIso: "2026-01-01T00:00:00Z",
    })

    const cfg = await readTenantConfig(makeEnv(db), 4)
    expect(cfg).toEqual({ cap: null, dailyBudget: null })
  })

  it("returns null for an unknown (missing) tenant", async () => {
    const cfg = await readTenantConfig(makeEnv(db), 99999)
    expect(cfg).toBeNull()
  })

  it("binding absent — returns null without throwing", async () => {
    await expect(readTenantConfig(makeAbsentEnv(), 1)).resolves.toBeNull()
  })

  it("thrown query — returns null without throwing (fail-open)", async () => {
    await expect(readTenantConfig({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 1)).resolves.toBeNull()
  })
})

describe("upsertTenantTier", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("inserts a new tenant row with the tier", async () => {
    const res = await upsertTenantTier(makeEnv(db), 5, "pro", "2026-01-01T00:00:00Z")
    expect(res).toEqual({ ok: true })
    const row = await db.prepare("SELECT tier FROM tenant WHERE installation_id = ?").bind(5).first<{ tier: string }>()
    expect(row?.tier).toBe("pro")
  })

  it("updates the tier of an existing tenant, leaving other columns intact", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 6,
      repoId: 600,
      fullName: "acme/x",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "acme",
    })
    const res = await upsertTenantTier(makeEnv(db), 6, "max", "2026-02-02T00:00:00Z")
    expect(res).toEqual({ ok: true })
    const row = await db
      .prepare("SELECT tier, account_login FROM tenant WHERE installation_id = ?")
      .bind(6)
      .first<{ tier: string; account_login: string }>()
    expect(row).toEqual({ tier: "max", account_login: "acme" })
  })

  it("returns {ok:false} (never throws) on an absent binding", async () => {
    await expect(upsertTenantTier(makeAbsentEnv(), 7, "pro", "2026-01-01T00:00:00Z")).resolves.toEqual({ ok: false })
  })

  it("returns {ok:false} for a non-positive / non-integer installation id", async () => {
    await expect(upsertTenantTier(makeEnv(db), 0, "pro", "2026-01-01T00:00:00Z")).resolves.toEqual({ ok: false })
    await expect(upsertTenantTier(makeEnv(db), 1.5, "pro", "2026-01-01T00:00:00Z")).resolves.toEqual({ ok: false })
  })

  it("returns {ok:false} on a genuine D1 fault (so the caller can surface a retry)", async () => {
    await expect(
      upsertTenantTier({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 8, "pro", "2026-01-01T00:00:00Z"),
    ).resolves.toEqual({
      ok: false,
    })
  })

  // sig-trial-cap — subscription_status is co-written with the tier.
  it("writes the subscription_status alongside the tier (trialing)", async () => {
    const res = await upsertTenantTier(makeEnv(db), 90, "pro", "2026-01-01T00:00:00Z", "trialing")
    expect(res).toEqual({ ok: true })
    const row = await db
      .prepare("SELECT tier, subscription_status FROM tenant WHERE installation_id = ?")
      .bind(90)
      .first<{ tier: string; subscription_status: string }>()
    expect(row).toEqual({ tier: "pro", subscription_status: "trialing" })
  })

  it("a trial→active conversion overwrites subscription_status to 'active' (no lingering trialing)", async () => {
    await upsertTenantTier(makeEnv(db), 91, "max", "2026-01-01T00:00:00Z", "trialing")
    await upsertTenantTier(makeEnv(db), 91, "max", "2026-02-02T00:00:00Z", "active")
    const row = await db
      .prepare("SELECT tier, subscription_status FROM tenant WHERE installation_id = ?")
      .bind(91)
      .first<{ tier: string; subscription_status: string }>()
    expect(row).toEqual({ tier: "max", subscription_status: "active" })
  })

  it("omitting subscription_status writes NULL (default)", async () => {
    await upsertTenantTier(makeEnv(db), 92, "free", "2026-01-01T00:00:00Z")
    const row = await db
      .prepare("SELECT subscription_status FROM tenant WHERE installation_id = ?")
      .bind(92)
      .first<{ subscription_status: string | null }>()
    expect(row?.subscription_status).toBeNull()
  })

  // Enterprise (contract tier) protection: a Stripe event must NEVER downgrade a
  // manually-set `enterprise` tenant. The ON CONFLICT ... WHERE guard no-ops the UPDATE.
  it("NEVER overwrites a manually-set enterprise tenant (Stripe downgrade → free is a no-op)", async () => {
    await upsertTenantTier(makeEnv(db), 100, "enterprise", "2026-01-01T00:00:00Z", "active")
    // Simulate a stray/late Stripe event trying to drop the contract tenant to free.
    const res = await upsertTenantTier(makeEnv(db), 100, "free", "2026-03-03T00:00:00Z", null)
    expect(res).toEqual({ ok: true }) // a skipped no-op still succeeds → webhook acks 200
    const row = await db
      .prepare("SELECT tier, subscription_status FROM tenant WHERE installation_id = ?")
      .bind(100)
      .first<{ tier: string; subscription_status: string }>()
    // Unchanged: still enterprise + active (keeps all entitlements + the top cap).
    expect(row).toEqual({ tier: "enterprise", subscription_status: "active" })
  })

  it("the enterprise guard is case/space-insensitive (' Enterprise ' is protected too)", async () => {
    await upsertTenantTier(makeEnv(db), 101, " Enterprise ", "2026-01-01T00:00:00Z", "active")
    await upsertTenantTier(makeEnv(db), 101, "pro", "2026-03-03T00:00:00Z", "active")
    const row = await db
      .prepare("SELECT tier FROM tenant WHERE installation_id = ?")
      .bind(101)
      .first<{ tier: string }>()
    expect(row?.tier).toBe(" Enterprise ")
  })

  it("a brand-new Stripe tenant still inserts normally (guard only blocks overwriting enterprise)", async () => {
    const res = await upsertTenantTier(makeEnv(db), 102, "ultra", "2026-01-01T00:00:00Z", "active")
    expect(res).toEqual({ ok: true })
    const row = await db
      .prepare("SELECT tier FROM tenant WHERE installation_id = ?")
      .bind(102)
      .first<{ tier: string }>()
    expect(row?.tier).toBe("ultra")
  })

  it("a non-enterprise tenant is still updated normally (guard does not block pro→max, etc.)", async () => {
    await upsertTenantTier(makeEnv(db), 103, "pro", "2026-01-01T00:00:00Z", "active")
    await upsertTenantTier(makeEnv(db), 103, "max", "2026-02-02T00:00:00Z", "active")
    const row = await db
      .prepare("SELECT tier FROM tenant WHERE installation_id = ?")
      .bind(103)
      .first<{ tier: string }>()
    expect(row?.tier).toBe("max")
  })
})

describe("readTenantSubscriptionStatus", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("returns the stored status for a trialing tenant", async () => {
    await upsertTenantTier(makeEnv(db), 80, "pro", "2026-01-01T00:00:00Z", "trialing")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 80)).toBe("trialing")
  })

  it("returns 'active' after a trial converts", async () => {
    await upsertTenantTier(makeEnv(db), 81, "ultra", "2026-01-01T00:00:00Z", "active")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 81)).toBe("active")
  })

  it("returns null for a NULL column (pre-migration / never-billed row)", async () => {
    await upsertTenantTier(makeEnv(db), 82, "free", "2026-01-01T00:00:00Z")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 82)).toBeNull()
  })

  it("returns null for an unknown (missing) tenant", async () => {
    expect(await readTenantSubscriptionStatus(makeEnv(db), 99999)).toBeNull()
  })

  it("returns null (never throws) on an absent binding", async () => {
    await expect(readTenantSubscriptionStatus(makeAbsentEnv(), 1)).resolves.toBeNull()
  })

  it("returns null (never throws, fail-safe) for a non-positive / non-integer id", async () => {
    await expect(readTenantSubscriptionStatus(makeEnv(db), 0)).resolves.toBeNull()
    await expect(readTenantSubscriptionStatus(makeEnv(db), 1.5)).resolves.toBeNull()
  })

  it("returns null (never throws, fail-safe) on a genuine D1 fault", async () => {
    await expect(readTenantSubscriptionStatus({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 1)).resolves.toBeNull()
  })
})

// sig-github-marketplace-billing — billing_source co-write + the account-login resolver
// and billing-guard reader that the Marketplace webhook depends on.
describe("upsertTenantTier billing_source", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("writes billing_source when provided", async () => {
    await upsertTenantTier(makeEnv(db), 300, "pro", "2026-01-01T00:00:00Z", "active", "github_marketplace")
    const row = await db
      .prepare("SELECT billing_source FROM tenant WHERE installation_id = ?")
      .bind(300)
      .first<{ billing_source: string }>()
    expect(row?.billing_source).toBe("github_marketplace")
  })

  it("omitting billing_source (default null) PRESERVES an existing value via COALESCE", async () => {
    await upsertTenantTier(makeEnv(db), 301, "pro", "2026-01-01T00:00:00Z", "active", "stripe")
    // A later write that does NOT pass billing_source must not wipe it.
    await upsertTenantTier(makeEnv(db), 301, "max", "2026-02-01T00:00:00Z", "active")
    const row = await db
      .prepare("SELECT tier, billing_source FROM tenant WHERE installation_id = ?")
      .bind(301)
      .first<{ tier: string; billing_source: string }>()
    expect(row).toEqual({ tier: "max", billing_source: "stripe" })
  })
})

describe("upsertTenantAccount", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("seeds a new tenant row with account_login + account_type (tier at schema default)", async () => {
    await upsertTenantAccount(makeEnv(db), {
      installationId: 350,
      accountLogin: "acme",
      accountType: "Organization",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const row = await db
      .prepare("SELECT tier, account_login, account_type FROM tenant WHERE installation_id = ?")
      .bind(350)
      .first<{ tier: string; account_login: string; account_type: string }>()
    expect(row).toEqual({ tier: "default", account_login: "acme", account_type: "Organization" })
  })

  it("re-seed with COALESCE preserves tier/billing_source and does not overwrite login with null", async () => {
    await upsertTenantTier(makeEnv(db), 351, "ultra", "2026-01-01T00:00:00Z", "active", "github_marketplace")
    // Seed account identity on the paid row — must not disturb tier/subscription_status/source.
    await upsertTenantAccount(makeEnv(db), {
      installationId: 351,
      accountLogin: "acme",
      nowIso: "2026-02-01T00:00:00Z",
    })
    // A later seed WITHOUT a login must not wipe the stored login (COALESCE).
    await upsertTenantAccount(makeEnv(db), { installationId: 351, nowIso: "2026-03-01T00:00:00Z" })
    const row = await db
      .prepare("SELECT tier, account_login, subscription_status, billing_source FROM tenant WHERE installation_id = ?")
      .bind(351)
      .first<{ tier: string; account_login: string; subscription_status: string; billing_source: string }>()
    expect(row).toEqual({
      tier: "ultra",
      account_login: "acme",
      subscription_status: "active",
      billing_source: "github_marketplace",
    })
  })

  it("fails open (never throws) on an absent binding / non-positive id / broken db", async () => {
    await expect(
      upsertTenantAccount(makeAbsentEnv(), { installationId: 1, accountLogin: "x", nowIso: "t" }),
    ).resolves.toBeUndefined()
    await expect(
      upsertTenantAccount(makeEnv(db), { installationId: 0, accountLogin: "x", nowIso: "t" }),
    ).resolves.toBeUndefined()
    await expect(
      upsertTenantAccount(
        { SIGILIX_PLATFORM_DB: makeBrokenDb() },
        { installationId: 1, accountLogin: "x", nowIso: "t" },
      ),
    ).resolves.toBeUndefined()
  })
})

describe("resolveInstallationByAccountLogin", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("resolves the installation id by account login (case-insensitive)", async () => {
    await upsertTenantAndRepo(makeEnv(db), {
      installationId: 400,
      repoId: 4000,
      fullName: "acme/x",
      nowIso: "2026-01-01T00:00:00Z",
      accountLogin: "AcmeOrg",
    })
    expect(await resolveInstallationByAccountLogin(makeEnv(db), "acmeorg")).toBe(400)
    expect(await resolveInstallationByAccountLogin(makeEnv(db), "AcmeOrg")).toBe(400)
  })

  it("returns null for an unknown login / absent binding / broken db", async () => {
    expect(await resolveInstallationByAccountLogin(makeEnv(db), "ghost")).toBeNull()
    expect(await resolveInstallationByAccountLogin(makeAbsentEnv(), "x")).toBeNull()
    expect(await resolveInstallationByAccountLogin({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, "x")).toBeNull()
  })
})

describe("readTenantBillingGuard", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("returns tier + billing_source + subscription_status for an existing tenant", async () => {
    await upsertTenantTier(makeEnv(db), 500, "max", "2026-01-01T00:00:00Z", "active", "stripe")
    expect(await readTenantBillingGuard(makeEnv(db), 500)).toEqual({
      tier: "max",
      billingSource: "stripe",
      subscriptionStatus: "active",
    })
  })

  it("returns null for a missing tenant / absent binding / broken db (fail-open)", async () => {
    expect(await readTenantBillingGuard(makeEnv(db), 99999)).toBeNull()
    expect(await readTenantBillingGuard(makeAbsentEnv(), 1)).toBeNull()
    expect(await readTenantBillingGuard({ SIGILIX_PLATFORM_DB: makeBrokenDb() }, 1)).toBeNull()
  })
})

// sig-trial-cap — migration 0011 backfill: existing PAID tenants must become 'active'
// (keep full volume) while free/default rows stay NULL (fail-safe half). Applies 0001,
// seeds rows on the OLD schema, THEN applies 0011 to exercise the backfill UPDATE.
describe("migration 0011 subscription_status backfill", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0001_SQL)
    const seed = (installationId: number, tier: string) =>
      db
        .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (?, ?, ?, ?)")
        .bind(installationId, tier, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
        .run()
    await seed(201, "pro")
    await seed(202, "max")
    await seed(203, "ultra")
    await seed(204, "free")
    await seed(205, "default")
    await seed(206, "teams")
    // Contract (enterprise) + legacy + case/space variants that resolveRateLimitCap
    // gives a full cap — the backfill must reach these too, or they'd fall to NULL →
    // halved (regression). enterprise is the contract TOP tier (full cap 500).
    await seed(207, "enterprise")
    await seed(208, "pro_plus")
    await seed(209, "MAX")
    await seed(210, " Pro ")
    await seed(211, "oss")
    // Apply the new migration (ALTER + backfill UPDATE) over the seeded rows.
    await db.exec(MIGRATION_0011_SQL)
  })

  it("backfills paid tiers (pro/teams/max/ultra) to 'active' so they keep FULL volume", async () => {
    expect(await readTenantSubscriptionStatus(makeEnv(db), 201)).toBe("active")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 202)).toBe("active")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 203)).toBe("active")
    expect(await readTenantSubscriptionStatus(makeEnv(db), 206)).toBe("active")
  })

  it("backfills legacy + case/space-variant full-cap tiers too (mirrors the resolver's normalization)", async () => {
    expect(await readTenantSubscriptionStatus(makeEnv(db), 207)).toBe("active") // enterprise
    expect(await readTenantSubscriptionStatus(makeEnv(db), 208)).toBe("active") // pro_plus
    expect(await readTenantSubscriptionStatus(makeEnv(db), 209)).toBe("active") // "MAX"
    expect(await readTenantSubscriptionStatus(makeEnv(db), 210)).toBe("active") // " Pro "
  })

  it("leaves free/default/oss rows NULL (they resolve to the Free floor either way)", async () => {
    expect(await readTenantSubscriptionStatus(makeEnv(db), 204)).toBeNull() // free
    expect(await readTenantSubscriptionStatus(makeEnv(db), 205)).toBeNull() // default
    expect(await readTenantSubscriptionStatus(makeEnv(db), 211)).toBeNull() // oss (free-floor tier)
  })
})
