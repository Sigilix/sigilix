import { cancelSubscription, listCustomerSubscriptions, listSubscriptionItems } from "./stripe-api"
import {
  resolveStripeSeatTarget,
  type StripeSeatTarget,
  type StripeSeatTargetBlockReason,
} from "@/src/features/billing/domain/stripe-seat-target"
import type { PriceTierConfig } from "@/src/features/billing/domain/stripe-events"
import type { SubscriptionSummary } from "@/src/features/billing/domain/subscription-dedupe"

/** The exact subscription-status subset that is entitled and safe to resize. */
type LiveSubscriptionStatus = "active" | "trialing"

export interface DiscoveredStripeSeatTarget extends StripeSeatTarget {
  subscriptionId: string
  subscriptionStatus: LiveSubscriptionStatus
}

export type StripeSeatDiscoveryBlockReason =
  | Exclude<StripeSeatTargetBlockReason, "no_matching_subscription_item">
  | "duplicate_subscription_cancel_failed"
  | "too_many_active_subscriptions"

export type StripeSeatDiscoveryResult =
  | {
      kind: "ready"
      target: DiscoveredStripeSeatTarget
      duplicateSubscriptionIds: string[]
      canceledSubscriptionIds: string[]
    }
  | { kind: "not_applicable" }
  | { kind: "blocked"; reason: StripeSeatDiscoveryBlockReason; subscriptionId: string }
  | { kind: "error"; error: string; status: number }

export interface DiscoverStripeSeatSubscriptionArgs {
  secret: string
  customerId: string
  priceConfig: PriceTierConfig
  /**
   * Defaults to true. False performs the same deterministic survivor lookup without
   * provider writes and reports every newer valid candidate in duplicateSubscriptionIds.
   */
  cancelDuplicates?: boolean
  /** Shared deadline for list, item-pagination, and duplicate-cancel calls. */
  signal?: AbortSignal
}

const MAX_ACTIVE_SUBSCRIPTIONS = 20

interface LiveSubscription extends SubscriptionSummary {
  status: LiveSubscriptionStatus
}

interface Candidate {
  subscription: LiveSubscription
  target: StripeSeatTarget
}

function isLive(subscription: SubscriptionSummary): subscription is LiveSubscription {
  return subscription.status === "active" || subscription.status === "trialing"
}

function byCreatedThenId(a: SubscriptionSummary, b: SubscriptionSummary): number {
  if (a.created !== b.created) return a.created - b.created
  // Relational string comparison uses specification-defined UTF-16 code-unit ordering;
  // localeCompare without a fixed locale would make this tie-breaker environment-dependent.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Discover the one product-aware Stripe subscription item Sigilix may resize.
 *
 * Only subscriptions with one exact configured Sigilix price are candidates. Live
 * subscriptions containing unrelated products are ignored, while any ambiguity or invalid
 * configured item blocks the whole discovery before a cancellation is attempted. When
 * several valid Sigilix subscriptions remain, the oldest deterministically survives and
 * only the newer valid Sigilix candidates are canceled.
 */
export async function discoverStripeSeatSubscription(
  args: DiscoverStripeSeatSubscriptionArgs,
): Promise<StripeSeatDiscoveryResult> {
  const listed = await listCustomerSubscriptions(args.secret, args.customerId, args.signal)
  if (!listed.ok) return { kind: "error", error: listed.error, status: listed.status }

  const liveSubscriptions = listed.subscriptions.filter(isLive).sort(byCreatedThenId)
  if (liveSubscriptions.length === 0) return { kind: "not_applicable" }
  if (liveSubscriptions.length > MAX_ACTIVE_SUBSCRIPTIONS) {
    return {
      kind: "blocked",
      reason: "too_many_active_subscriptions",
      subscriptionId: liveSubscriptions[0]?.id ?? "unknown",
    }
  }

  // Resolve every live subscription before making any destructive call. A later invalid
  // Sigilix target must not be discovered only after an earlier duplicate was canceled.
  const itemResults: Array<{
    subscription: LiveSubscription
    listed: Awaited<ReturnType<typeof listSubscriptionItems>>
  }> = []
  for (const subscription of liveSubscriptions) {
    itemResults.push({
      subscription,
      listed: await listSubscriptionItems(args.secret, subscription.id, args.signal),
    })
  }

  const candidates: Candidate[] = []
  for (const result of itemResults) {
    if (!result.listed.ok) {
      return { kind: "error", error: result.listed.error, status: result.listed.status }
    }
    const resolution = resolveStripeSeatTarget({
      subscriptionStatus: result.subscription.status,
      priceConfig: args.priceConfig,
      items: result.listed.items,
    })
    if (resolution.kind === "resolved") {
      candidates.push({ subscription: result.subscription, target: resolution.target })
      continue
    }
    // A live subscription with no configured Sigilix price is an unrelated product, not
    // evidence that the customer's actual Sigilix subscription is malformed.
    if (resolution.reason === "no_matching_subscription_item") continue
    return {
      kind: "blocked",
      reason: resolution.reason,
      subscriptionId: result.subscription.id,
    }
  }

  if (candidates.length === 0) return { kind: "not_applicable" }

  // liveSubscriptions (and therefore candidates) are already ordered by created then id.
  const survivor = candidates[0]!
  const duplicates = candidates.slice(1)
  const duplicateSubscriptionIds = duplicates.map((candidate) => candidate.subscription.id)
  const canceledSubscriptionIds: string[] = []

  if (args.cancelDuplicates !== false) {
    let firstFailedSubscriptionId: string | null = null
    for (const duplicate of duplicates) {
      const canceled = await cancelSubscription(args.secret, duplicate.subscription.id, args.signal)
      if (canceled.ok) {
        canceledSubscriptionIds.push(duplicate.subscription.id)
      } else {
        firstFailedSubscriptionId ??= duplicate.subscription.id
        console.error(
          JSON.stringify({
            event: "stripe-seat-duplicate-cancel-failed",
            subscriptionId: duplicate.subscription.id,
            status: canceled.status,
          }),
        )
      }
    }
    if (firstFailedSubscriptionId !== null) {
      return {
        kind: "blocked",
        reason: "duplicate_subscription_cancel_failed",
        subscriptionId: firstFailedSubscriptionId,
      }
    }
  }

  return {
    kind: "ready",
    target: {
      subscriptionId: survivor.subscription.id,
      subscriptionStatus: survivor.subscription.status,
      ...survivor.target,
    },
    duplicateSubscriptionIds,
    canceledSubscriptionIds,
  }
}
