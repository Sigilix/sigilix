// sig-github-marketplace-billing: GitHub Marketplace webhook routing leaf. GitHub delivers
// `marketplace_purchase` events to the SAME POST /github/webhook endpoint, already
// signature-verified (x-hub-signature-256) by the entry module before this runs. This leaf
// owns the two Marketplace touchpoints so the entry module stays within its size budget:
//   1. `marketplace_purchase` → provision the tenant's tier (returns the ack Response).
//   2. `installation` (created) → reconcile a purchase-before-install Marketplace
//      subscription onto the now-existing tenant (best-effort side-effect; returns null so
//      the entry module continues its normal install-onboarding routing).
// Any other event returns null (not a Marketplace concern).

import type { Env } from "@/src/shared/types/env"
import type { GitHubWebhookPayload } from "@/src/index-internals"
import { handleMarketplacePurchaseEvent, reconcileMarketplaceSubscriptionOnInstall } from "@/src/features/billing"

/**
 * Route a (verified, parsed) GitHub webhook event through the Marketplace billing path.
 * Returns a Response to send when the event is a `marketplace_purchase` (the caller returns
 * it verbatim); returns null otherwise (the caller continues its own routing). Never throws.
 */
export async function routeMarketplaceWebhook(args: {
  event: string
  payload: GitHubWebhookPayload
  env: Env
}): Promise<Response | null> {
  const { event, payload, env } = args

  if (event === "marketplace_purchase") {
    return handleMarketplacePurchaseEvent(payload, env)
  }

  // On a fresh install, SEED the tenant's account identity (so later marketplace_purchase
  // events resolve this install by login) and reconcile any purchase-before-install stash.
  // Runs REGARDLESS of the indexer flag (billing must work even when indexing is off) and
  // is best-effort — it returns null so the entry module's install-onboarding routing
  // (index fanout, etc.) proceeds unchanged.
  const installationId = payload.installation?.id
  if (event === "installation" && payload.action === "created" && typeof installationId === "number") {
    await reconcileMarketplaceSubscriptionOnInstall(env, {
      installationId,
      accountLogin: payload.installation?.account?.login,
      accountType: payload.installation?.account?.type,
      nowIso: new Date().toISOString(),
    })
  }
  return null
}
