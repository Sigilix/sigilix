// sig-github-marketplace-billing: handle a GitHub Marketplace `marketplace_purchase`
// event → provision the right Sigilix tier. Mirrors stripe-webhook-route's shape (verify
// upstream, interpret pure, resolve tenant, upsert tier, fail-closed) but the signature
// is ALREADY verified by the GitHub webhook entry (x-hub-signature-256) before dispatch —
// Marketplace events ride the SAME POST /github/webhook endpoint — so this adapter takes
// the parsed, verified event and does NOT re-verify.
//
// Flow:
//   1. Interpret the event (pure). ignore/defer → 200 ack, no write.
//   2. Upsert the marketplace_subscription record (account-keyed source of record + the
//      purchase-before-install stash).
//   3. Resolve the installation by account login. Not installed yet → 200 ack (the stash
//      is reconciled on installation.created).
//   4. Guard: never downgrade an `enterprise` tenant; never clobber a tenant whose ACTIVE
//      paid subscription came from Stripe (log + skip, still 200).
//   5. Upsert tenant.tier with billing_source='github_marketplace'. A genuine D1 write
//      failure → 500 (GitHub redelivers); success → 200.
//
// Recall-safety: a paid tier is only ever written for a purchased/changed event whose
// plan mapped to a paid tier AND a resolved installation. cancelled downgrades to free.
// The enterprise guard and the Stripe-active guard both fail-open for the Marketplace
// write only when they cannot prove a conflicting state (an unresolved current state
// never blocks a legitimate provision).

import type { Env } from "@/src/shared/types/env"
import {
  interpretMarketplaceEvent,
  parseMarketplacePlanMap,
  type MarketplaceEvent,
} from "@/src/features/billing/domain/marketplace-plan"
import {
  upsertMarketplaceSubscription,
  readMarketplaceSubscriptionByLogin,
} from "@/src/features/billing/adapters/marketplace-subscription-store"
import {
  upsertTenantTier,
  upsertTenantAccount,
  resolveInstallationByAccountLogin,
  readTenantBillingGuard,
  type TenantBillingGuard,
} from "@/src/features/tenancy"

/** The billing_source value stamped on tenant rows written by the Marketplace path. */
export const MARKETPLACE_BILLING_SOURCE = "github_marketplace"

function ack(body: string): Response {
  return new Response(`${body}\n`, { status: 200 })
}

/**
 * True when a Marketplace write must be REFUSED because the tenant already holds a paid
 * position it must not clobber: an `enterprise` tenant (sales-assisted, never Marketplace),
 * or a tenant whose paying Stripe subscription is `active`/`trialing` (sig-trial-cap treats
 * trialing as a paying/half-cap state, so it is protected too). Fail-open: a null guard
 * (unknown current state) never blocks a legitimate provision.
 */
function marketplaceWriteBlockedBy(guard: TenantBillingGuard | null): "enterprise" | "stripe" | null {
  if (guard?.tier === "enterprise") return "enterprise"
  if (
    guard?.billingSource === "stripe" &&
    (guard.subscriptionStatus === "active" || guard.subscriptionStatus === "trialing")
  ) {
    return "stripe"
  }
  return null
}

/**
 * Handle a signature-VERIFIED, parsed `marketplace_purchase` event. Always returns 200 on
 * a well-formed event that needs no retry; returns 500 ONLY when a genuine D1 tier write
 * fails (so GitHub redelivers). Never throws.
 */
export async function handleMarketplacePurchaseEvent(event: MarketplaceEvent, env: Env): Promise<Response> {
  const planMap = parseMarketplacePlanMap(env.GITHUB_MARKETPLACE_PLAN_MAP)
  const interpretation = interpretMarketplaceEvent(event, planMap)

  if (interpretation.kind === "ignore") return ack("ignored")
  if (interpretation.kind === "defer") {
    console.log(JSON.stringify({ event: "marketplace-webhook-deferred", reason: interpretation.reason }))
    return ack("deferred")
  }

  const { action, accountId, accountLogin, tier, seats, subscriptionStatus } = interpretation
  const nowIso = new Date().toISOString()

  // Persist the account-keyed source of record + purchase-before-install stash. Fail-soft
  // (never blocks provisioning). Requires an account id (the table PK) and a login.
  if (accountId !== null && accountLogin !== null) {
    await upsertMarketplaceSubscription(
      env,
      { accountId, accountLogin, tier, seats, status: subscriptionStatus },
      nowIso,
    )
  } else {
    console.warn(
      JSON.stringify({
        event: "marketplace-webhook-account-incomplete",
        action,
        accountId,
        hasLogin: accountLogin !== null,
      }),
    )
  }

  // No login → we cannot resolve an installation. The stash (if any) is the record; ack.
  if (accountLogin === null) return ack("no account login")

  const installationId = await resolveInstallationByAccountLogin(env, accountLogin)
  if (installationId === null) {
    // Purchase-before-install: the App isn't installed for this account yet, so there is
    // no tenant to provision. The marketplace_subscription stash above is reconciled onto
    // the tenant when installation.created later fires. Ack (a redelivery won't help).
    console.log(JSON.stringify({ event: "marketplace-webhook-no-installation", action, accountLogin, tier }))
    return ack("no installation")
  }

  // Guards (read current tenant state before writing).
  const blocked = marketplaceWriteBlockedBy(await readTenantBillingGuard(env, installationId))
  if (blocked === "enterprise") {
    // Enterprise is sales-assisted only — a Marketplace event must NEVER downgrade it.
    console.warn(JSON.stringify({ event: "marketplace-webhook-enterprise-skip", action, installationId, tier }))
    return ack("enterprise not downgraded")
  }
  if (blocked === "stripe") {
    // Defensive: GitHub prevents a double-purchase per account, but never let a Marketplace
    // event clobber a tenant whose paying Stripe subscription is active/trialing.
    console.warn(JSON.stringify({ event: "marketplace-webhook-stripe-active-skip", action, installationId, tier }))
    return ack("stripe active not clobbered")
  }

  const result = await upsertTenantTier(
    env,
    installationId,
    tier,
    nowIso,
    subscriptionStatus,
    MARKETPLACE_BILLING_SOURCE,
  )
  if (!result.ok) {
    console.error(JSON.stringify({ event: "marketplace-webhook-tier-upsert-failed", action, installationId, tier }))
    return new Response("tier upsert failed\n", { status: 500 })
  }
  console.log(
    JSON.stringify({ event: "marketplace-webhook-tier-applied", action, installationId, tier, subscriptionStatus }),
  )
  return ack("ok")
}

/**
 * Called from the `installation.created` handler for a freshly-installed account. Does TWO
 * things:
 *   1. SEED the tenant's account identity (account_login + account_type) so that LATER
 *      `marketplace_purchase` events — which resolve the installation ONLY via
 *      tenant.account_login — can find this install even before its first PR (the "install
 *      free, purchase later" flow). Without this seed the resolve would miss and a paid
 *      purchase would never provision.
 *   2. RECONCILE any purchase-before-install stash: if a pending marketplace_subscription
 *      for this account names an ACTIVE paid plan, provision the tenant's tier via
 *      upsertTenantTier (billing_source='github_marketplace').
 *
 * Best-effort: logs + returns on any absence or failure — the install flow's own response
 * is never gated on it, and the marketplace_subscription row persists for a later event to
 * re-resolve. The same guards apply (never overwrite an enterprise tenant nor a paying
 * Stripe payer).
 */
export async function reconcileMarketplaceSubscriptionOnInstall(
  env: Env,
  args: {
    installationId: number
    accountLogin: string | null | undefined
    accountType?: string | null | undefined
    nowIso: string
  },
): Promise<void> {
  const { installationId, accountLogin, accountType, nowIso } = args
  if (typeof accountLogin !== "string" || accountLogin.length === 0) return
  if (!Number.isInteger(installationId) || installationId <= 0) return

  // 1. Seed account identity (ALWAYS — closes the install-first/purchase-later gap). This
  // is the ONLY write when there is no pending stash. Fail-soft (never throws).
  await upsertTenantAccount(env, {
    installationId,
    accountLogin,
    ...(typeof accountType === "string" && accountType.length > 0 ? { accountType } : {}),
    nowIso,
  })

  // 2. Reconcile any pending purchase-before-install subscription.
  const pending = await readMarketplaceSubscriptionByLogin(env, accountLogin)
  if (pending === null) return
  // Only provision a live, paid plan. A canceled record (or a free plan) leaves the fresh
  // tenant at its default free floor — nothing to apply.
  if (pending.status !== "active" || pending.tier === "free") {
    console.log(
      JSON.stringify({
        event: "marketplace-reconcile-noop",
        installationId,
        accountLogin,
        status: pending.status,
        tier: pending.tier,
      }),
    )
    return
  }

  const blocked = marketplaceWriteBlockedBy(await readTenantBillingGuard(env, installationId))
  if (blocked !== null) {
    console.warn(
      JSON.stringify({ event: "marketplace-reconcile-skip", reason: blocked, installationId, tier: pending.tier }),
    )
    return
  }

  const result = await upsertTenantTier(env, installationId, pending.tier, nowIso, "active", MARKETPLACE_BILLING_SOURCE)
  console.log(
    JSON.stringify({
      event: "marketplace-reconcile-applied",
      installationId,
      accountLogin,
      tier: pending.tier,
      ok: result.ok,
    }),
  )
}
