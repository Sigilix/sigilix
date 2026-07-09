// sig-github-marketplace-billing — POST /github/webhook (marketplace_purchase) end-to-end.
// Exercises the real interpret → marketplace_subscription stash → account→installation
// resolve → tenant.tier UPSERT path through the shim D1 (migrations 0001/0011/0012/0013).
// The signature is verified by the GitHub webhook entry BEFORE this handler runs, so the
// handler takes the already-parsed event — no signing here.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  handleMarketplacePurchaseEvent,
  reconcileMarketplaceSubscriptionOnInstall,
} from "@/src/features/billing/adapters/marketplace-webhook"
import type { MarketplaceEvent } from "@/src/features/billing/domain/marketplace-plan"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = [
  "0001_create_tenant_repo_usage.sql",
  "0011_add_tenant_subscription_status.sql",
  "0012_add_tenant_billing_source.sql",
  "0013_create_marketplace_subscription.sql",
]
  .map((f) => readFileSync(new URL(`../../../../migrations/${f}`, import.meta.url), "utf8"))
  .join("\n")

async function makeEnv(extra: Partial<Env> = {}): Promise<{ env: Env; db: D1Database }> {
  const db = makeD1()
  await db.exec(MIGRATION_SQL)
  const env = {
    SIGILIX_PLATFORM_DB: db,
    // Pin plan 700 → teams so exact-id precedence is exercised too.
    GITHUB_MARKETPLACE_PLAN_MAP: '{"700":"teams"}',
    ...extra,
  } as unknown as Env
  return { env, db }
}

async function seedTenant(
  db: D1Database,
  args: { installationId: number; login: string; tier?: string; billingSource?: string | null; status?: string | null },
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO tenant (installation_id, tier, account_login, subscription_status, billing_source, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      args.installationId,
      args.tier ?? "free",
      args.login,
      args.status ?? null,
      args.billingSource ?? null,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    )
    .run()
}

async function readTenant(
  db: D1Database,
  installationId: number,
): Promise<{ tier: string | null; subscription_status: string | null; billing_source: string | null } | null> {
  const row = await db
    .prepare("SELECT tier, subscription_status, billing_source FROM tenant WHERE installation_id = ?")
    .bind(installationId)
    .first<{ tier: string; subscription_status: string | null; billing_source: string | null }>()
  return row ?? null
}

function purchase(
  action: string,
  opts: { id?: number; login?: string; type?: string; planId?: number; planName?: string; units?: number } = {},
): MarketplaceEvent {
  return {
    action,
    marketplace_purchase: {
      account: { id: opts.id ?? 1000, login: opts.login ?? "acme", type: opts.type ?? "Organization" },
      ...(opts.units !== undefined ? { unit_count: opts.units } : {}),
      plan: { id: opts.planId ?? 9999, name: opts.planName ?? "Whatever" },
    },
  }
}

describe("handleMarketplacePurchaseEvent", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    ;({ env, db } = await makeEnv())
  })

  it("purchased on an installed tenant → tier applied via account→installation resolve, source=github_marketplace", async () => {
    await seedTenant(db, { installationId: 50, login: "acme" })
    const res = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Ultra" }), env)
    expect(res.status).toBe(200)
    expect(await readTenant(db, 50)).toEqual({
      tier: "ultra",
      subscription_status: "active",
      billing_source: "github_marketplace",
    })
  })

  it("account→installation resolution is case-insensitive", async () => {
    await seedTenant(db, { installationId: 51, login: "AcMe" })
    const res = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Pro" }), env)
    expect(res.status).toBe(200)
    expect((await readTenant(db, 51))?.tier).toBe("pro")
  })

  it("exact plan-id map wins over the name heuristic", async () => {
    await seedTenant(db, { installationId: 52, login: "acme" })
    // plan 700 is mapped → teams, even though the name says "Pro".
    await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planId: 700, planName: "Pro" }), env)
    expect((await readTenant(db, 52))?.tier).toBe("teams")
  })

  it("changed → new tier applied", async () => {
    await seedTenant(db, {
      installationId: 53,
      login: "acme",
      tier: "pro",
      status: "active",
      billingSource: "github_marketplace",
    })
    await handleMarketplacePurchaseEvent(purchase("changed", { login: "acme", planName: "Max" }), env)
    expect((await readTenant(db, 53))?.tier).toBe("max")
  })

  it("cancelled → downgrade to free / canceled", async () => {
    await seedTenant(db, {
      installationId: 54,
      login: "acme",
      tier: "ultra",
      status: "active",
      billingSource: "github_marketplace",
    })
    const res = await handleMarketplacePurchaseEvent(purchase("cancelled", { login: "acme", planName: "Ultra" }), env)
    expect(res.status).toBe(200)
    expect(await readTenant(db, 54)).toEqual({
      tier: "free",
      subscription_status: "canceled",
      billing_source: "github_marketplace",
    })
  })

  it("purchase-before-install → 200 ack, stashed in marketplace_subscription, no tenant touched", async () => {
    const res = await handleMarketplacePurchaseEvent(
      purchase("purchased", { id: 2000, login: "newco", planName: "Teams", units: 12 }),
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("no installation")
    // no tenant row created
    const n = await db.prepare("SELECT COUNT(*) AS n FROM tenant").first<{ n: number }>()
    expect(n?.n).toBe(0)
    // stashed for reconcile
    const stash = await db
      .prepare("SELECT tier, seats, status FROM marketplace_subscription WHERE account_id = ?")
      .bind(2000)
      .first<{ tier: string; seats: number; status: string }>()
    expect(stash).toEqual({ tier: "teams", seats: 12, status: "active" })
  })

  it("pending_change → 200 deferred, no tier change", async () => {
    await seedTenant(db, {
      installationId: 55,
      login: "acme",
      tier: "pro",
      status: "active",
      billingSource: "github_marketplace",
    })
    const res = await handleMarketplacePurchaseEvent({ action: "pending_change" }, env)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("deferred")
    expect((await readTenant(db, 55))?.tier).toBe("pro")
  })

  it("enterprise tenant is NEVER downgraded by a Marketplace event", async () => {
    await seedTenant(db, { installationId: 56, login: "bigco", tier: "enterprise", status: "active" })
    const res = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "bigco", planName: "Pro" }), env)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("enterprise not downgraded")
    expect((await readTenant(db, 56))?.tier).toBe("enterprise")
  })

  it("an ACTIVE Stripe tenant is NOT clobbered by a Marketplace event", async () => {
    await seedTenant(db, {
      installationId: 57,
      login: "stripeco",
      tier: "max",
      status: "active",
      billingSource: "stripe",
    })
    const res = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "stripeco", planName: "Pro" }), env)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("stripe active not clobbered")
    expect(await readTenant(db, 57)).toMatchObject({ tier: "max", billing_source: "stripe" })
  })

  it("a TRIALING Stripe tenant is NOT clobbered (sig-trial-cap treats trialing as paying)", async () => {
    await seedTenant(db, {
      installationId: 62,
      login: "trialco",
      tier: "pro",
      status: "trialing",
      billingSource: "stripe",
    })
    const res = await handleMarketplacePurchaseEvent(
      purchase("purchased", { login: "trialco", planName: "Ultra" }),
      env,
    )
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("stripe active not clobbered")
    expect(await readTenant(db, 62)).toMatchObject({ tier: "pro", billing_source: "stripe" })
  })

  it("a NON-active Stripe tenant (e.g. canceled) CAN be provisioned via Marketplace", async () => {
    await seedTenant(db, {
      installationId: 58,
      login: "switchco",
      tier: "free",
      status: "canceled",
      billingSource: "stripe",
    })
    await handleMarketplacePurchaseEvent(purchase("purchased", { login: "switchco", planName: "Pro" }), env)
    expect(await readTenant(db, 58)).toMatchObject({ tier: "pro", billing_source: "github_marketplace" })
  })

  it("idempotent: applying the same purchased event twice yields the same state, 200 both times", async () => {
    await seedTenant(db, { installationId: 59, login: "acme" })
    const first = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Pro" }), env)
    const second = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Pro" }), env)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await readTenant(db, 59))?.tier).toBe("pro")
  })

  it("unmappable plan falls closed to free (never a random paid grant)", async () => {
    await seedTenant(db, { installationId: 60, login: "acme" })
    await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Mystery Bundle" }), env)
    expect((await readTenant(db, 60))?.tier).toBe("free")
  })

  it("ignores an unknown action → 200 no-op", async () => {
    const res = await handleMarketplacePurchaseEvent({ action: "exploded" }, env)
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe("ignored")
  })

  it("500 on a genuine D1 tier write failure (GitHub redelivers)", async () => {
    // Resolve succeeds (real read), then the tier UPSERT throws.
    await seedTenant(db, { installationId: 61, login: "acme" })
    let call = 0
    const flaky = {
      prepare(sql: string) {
        // Let reads through; make the tenant UPSERT throw.
        if (sql.includes("INSERT INTO tenant")) {
          throw new Error("simulated D1 error")
        }
        call++
        return db.prepare(sql)
      },
    } as unknown as D1Database
    const env2 = { ...env, SIGILIX_PLATFORM_DB: flaky } as Env
    const res = await handleMarketplacePurchaseEvent(purchase("purchased", { login: "acme", planName: "Pro" }), env2)
    expect(res.status).toBe(500)
    expect(call).toBeGreaterThan(0)
  })
})

describe("reconcileMarketplaceSubscriptionOnInstall", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    ;({ env, db } = await makeEnv())
  })

  it("applies a pending purchase-before-install subscription onto the newly-installed tenant", async () => {
    // Purchase arrives first (no install) → stashed.
    await handleMarketplacePurchaseEvent(purchase("purchased", { id: 3000, login: "newco", planName: "Ultra" }), env)
    expect(await readTenant(db, 70)).toBeNull()
    // App installs → reconcile provisions the tier.
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId: 70,
      accountLogin: "newco",
      nowIso: "2026-03-01T00:00:00Z",
    })
    expect(await readTenant(db, 70)).toEqual({
      tier: "ultra",
      subscription_status: "active",
      billing_source: "github_marketplace",
    })
  })

  it("no pending sub → still SEEDS account identity (so a later purchase resolves) but applies no paid tier", async () => {
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId: 71,
      accountLogin: "nobody",
      accountType: "Organization",
      nowIso: "2026-03-01T00:00:00Z",
    })
    // A tenant row now exists with the seeded login at the default (free-floor) tier.
    const row = await db
      .prepare("SELECT tier, account_login, billing_source FROM tenant WHERE installation_id = ?")
      .bind(71)
      .first<{ tier: string; account_login: string; billing_source: string | null }>()
    expect(row?.account_login).toBe("nobody")
    expect(row?.billing_source).toBeNull() // no paid provision, no source stamped
    expect(["default", "free"]).toContain(row?.tier) // schema default, never a paid tier
  })

  it("install-first then purchase-later: seeded login lets the subsequent purchase resolve + provision (P1 regression)", async () => {
    // App installs FIRST (no purchase yet) → seed identity only.
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId: 75,
      accountLogin: "laterco",
      accountType: "Organization",
      nowIso: "2026-03-01T00:00:00Z",
    })
    // Purchase arrives AFTER install → must now resolve installation 75 by login and provision.
    const res = await handleMarketplacePurchaseEvent(
      purchase("purchased", { login: "laterco", planName: "Ultra" }),
      env,
    )
    expect(res.status).toBe(200)
    expect((await readTenant(db, 75))?.tier).toBe("ultra")
  })

  it("canceled pending record → seeds identity but leaves the tenant at its free floor", async () => {
    await handleMarketplacePurchaseEvent(purchase("cancelled", { id: 3001, login: "goneco", planName: "Pro" }), env)
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId: 72,
      accountLogin: "goneco",
      nowIso: "2026-03-01T00:00:00Z",
    })
    const row = await db
      .prepare("SELECT tier, account_login, billing_source FROM tenant WHERE installation_id = ?")
      .bind(72)
      .first<{ tier: string; account_login: string; billing_source: string | null }>()
    expect(row?.account_login).toBe("goneco")
    expect(row?.billing_source).toBeNull()
    expect(["default", "free"]).toContain(row?.tier)
  })

  it("does not overwrite an enterprise tenant on reconcile", async () => {
    await handleMarketplacePurchaseEvent(purchase("purchased", { id: 3002, login: "bigco", planName: "Pro" }), env)
    await seedTenant(db, { installationId: 73, login: "bigco", tier: "enterprise", status: "active" })
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId: 73,
      accountLogin: "bigco",
      nowIso: "2026-03-01T00:00:00Z",
    })
    expect((await readTenant(db, 73))?.tier).toBe("enterprise")
  })

  it("ignores a blank / missing account login", async () => {
    await expect(
      reconcileMarketplaceSubscriptionOnInstall(env, { installationId: 74, accountLogin: undefined, nowIso: "x" }),
    ).resolves.toBeUndefined()
    await expect(
      reconcileMarketplaceSubscriptionOnInstall(env, { installationId: 74, accountLogin: "", nowIso: "x" }),
    ).resolves.toBeUndefined()
  })
})
