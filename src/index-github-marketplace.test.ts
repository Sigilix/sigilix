// sig-github-marketplace-billing — routing leaf wiring: a `marketplace_purchase` event is
// dispatched to the handler and its Response returned; `installation.created` triggers the
// purchase-before-install reconcile; every other event returns null.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { routeMarketplaceWebhook } from "@/src/index-github-marketplace"
import type { GitHubWebhookPayload } from "@/src/index-internals"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = [
  "0001_create_tenant_repo_usage.sql",
  "0011_add_tenant_subscription_status.sql",
  "0012_add_tenant_billing_source.sql",
  "0013_create_marketplace_subscription.sql",
]
  .map((f) => readFileSync(new URL(`./../migrations/${f}`, import.meta.url), "utf8"))
  .join("\n")

async function makeEnv(): Promise<{ env: Env; db: D1Database }> {
  const db = makeD1()
  await db.exec(MIGRATION_SQL)
  const env = { SIGILIX_PLATFORM_DB: db, GITHUB_MARKETPLACE_PLAN_MAP: "{}" } as unknown as Env
  return { env, db }
}

describe("routeMarketplaceWebhook", () => {
  let env: Env
  let db: D1Database
  beforeEach(async () => {
    ;({ env, db } = await makeEnv())
  })

  it("dispatches marketplace_purchase and returns the handler Response", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, account_login, created_at, updated_at) VALUES (?,?,?,?,?)")
      .bind(10, "free", "acme", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
      .run()
    const payload = {
      action: "purchased",
      marketplace_purchase: { account: { id: 1, login: "acme", type: "Organization" }, plan: { id: 5, name: "Pro" } },
    } as GitHubWebhookPayload
    const res = await routeMarketplaceWebhook({ event: "marketplace_purchase", payload, env })
    expect(res).not.toBeNull()
    expect(res?.status).toBe(200)
    const row = await db.prepare("SELECT tier FROM tenant WHERE installation_id = ?").bind(10).first<{ tier: string }>()
    expect(row?.tier).toBe("pro")
  })

  it("reconciles a pending subscription on installation.created and returns null", async () => {
    // Purchase-before-install: stash via the handler (no tenant yet).
    await routeMarketplaceWebhook({
      event: "marketplace_purchase",
      payload: {
        action: "purchased",
        marketplace_purchase: {
          account: { id: 2, login: "newco", type: "Organization" },
          plan: { id: 6, name: "Ultra" },
        },
      } as GitHubWebhookPayload,
      env,
    })
    // App installs → reconcile.
    const res = await routeMarketplaceWebhook({
      event: "installation",
      payload: { action: "created", installation: { id: 20, account: { login: "newco" } } } as GitHubWebhookPayload,
      env,
    })
    expect(res).toBeNull()
    const row = await db.prepare("SELECT tier FROM tenant WHERE installation_id = ?").bind(20).first<{ tier: string }>()
    expect(row?.tier).toBe("ultra")
  })

  it("returns null for a non-Marketplace event (e.g. pull_request)", async () => {
    const res = await routeMarketplaceWebhook({
      event: "pull_request",
      payload: { action: "opened" } as GitHubWebhookPayload,
      env,
    })
    expect(res).toBeNull()
  })

  it("returns null for installation.deleted (not a created reconcile trigger)", async () => {
    const res = await routeMarketplaceWebhook({
      event: "installation",
      payload: { action: "deleted", installation: { id: 30, account: { login: "x" } } } as GitHubWebhookPayload,
      env,
    })
    expect(res).toBeNull()
  })
})
