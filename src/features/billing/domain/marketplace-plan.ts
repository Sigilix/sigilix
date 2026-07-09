// sig-github-marketplace-billing: PURE interpretation of a GitHub Marketplace
// `marketplace_purchase` webhook event into a billing action against a Sigilix tenant.
// No IO — the caller (marketplace-webhook adapter) verifies the signature (reusing the
// GitHub webhook's existing x-hub-signature-256 check), resolves the account→installation
// link, persists the marketplace_subscription record, and upserts tenant.tier.
//
// Recall-safety, and the whole point of this file: a Marketplace plan resolves to a
// Sigilix tier ONLY via (1) an exact plan-id → tier match in the env override map, or
// (2) a case-insensitive plan-NAME heuristic. Anything unmappable falls closed to `free`.
// It NEVER returns `enterprise` — enterprise is sales-assisted only, never a Marketplace
// plan (the type makes it unrepresentable).
//
// We model only the handful of fields we read; GitHub's payloads are far larger.
// Everything is optional + defensively narrowed because a webhook body is untrusted
// (its signature is verified, but a malformed-but-signed body must not throw).

/** The Sigilix tiers a Marketplace plan can resolve to (NO enterprise — sales-only). */
export type MarketplaceTier = "free" | "pro" | "teams" | "max" | "ultra"

/** The valid Marketplace tiers, for validating an env-map value. Order = display only. */
const VALID_MARKETPLACE_TIERS: ReadonlySet<string> = new Set<MarketplaceTier>(["free", "pro", "teams", "max", "ultra"])

/** An exact plan-id → tier override map (parsed from GITHUB_MARKETPLACE_PLAN_MAP). */
export type MarketplacePlanMap = Readonly<Record<string, MarketplaceTier>>

/**
 * Parse the `GITHUB_MARKETPLACE_PLAN_MAP` env JSON — `{"<plan_id>":"pro", ...}` — into a
 * validated plan-id → tier map. Plan ids aren't known until the founder creates the
 * Marketplace plans, so this is how each plan is pinned to a tier later WITHOUT a code
 * change. FAIL-SOFT + FAIL-CLOSED: invalid JSON, a non-object, or any entry whose value
 * is not a valid Marketplace tier (including "enterprise") is dropped — a bad map can
 * never crash the webhook nor smuggle in an un-mappable/forbidden tier. Keys are the
 * plan-id STRING (GitHub numeric plan ids compared as strings).
 */
export function parseMarketplacePlanMap(raw: string | null | undefined): MarketplacePlanMap {
  if (!raw || raw.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, MarketplaceTier> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue
    if (typeof value !== "string") continue
    const tier = value.trim().toLowerCase()
    // Reject "enterprise" and any unknown value — only the five Marketplace tiers pass.
    if (VALID_MARKETPLACE_TIERS.has(tier)) out[key] = tier as MarketplaceTier
  }
  return out
}

/** True when `word` appears in `name` delimited by a non-letter (or string edge). */
function hasTierToken(name: string, word: string): boolean {
  return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(name)
}

/**
 * Resolve a Marketplace plan to a Sigilix tier. PRECEDENCE:
 *   1. Exact plan-id match in the env override map (the authoritative signal — the
 *      founder pastes each plan id → tier once the plans exist).
 *   2. Case-insensitive plan-NAME heuristic: a token match on `ultra`/`max`/`team`/`pro`/
 *      `free` (highest tier wins, so an "Ultra" plan never falls to a lower tier). Token
 *      match on non-letter boundaries so "team"/"teams" both hit `teams`, while a stray
 *      substring inside another word does not (e.g. "approved" does not match `pro`).
 *   3. Fall closed to `free` when nothing matches (unknown/blank plan).
 * NEVER returns `enterprise`.
 */
export function resolveMarketplaceTier(args: {
  planId: string | null | undefined
  planName: string | null | undefined
  planMap: MarketplacePlanMap
}): MarketplaceTier {
  const { planId, planName, planMap } = args
  if (typeof planId === "string" && planId.length > 0) {
    const mapped = planMap[planId]
    if (mapped) return mapped
  }
  const name = (planName ?? "").toLowerCase()
  if (name.length > 0) {
    if (hasTierToken(name, "ultra")) return "ultra"
    if (hasTierToken(name, "max")) return "max"
    if (hasTierToken(name, "teams?")) return "teams" // matches "team" and "teams"
    if (hasTierToken(name, "pro")) return "pro"
    if (hasTierToken(name, "free")) return "free"
  }
  return "free"
}

/**
 * Extract the seat count from a purchase's `unit_count` (relevant for the per-seat Teams
 * plan). Returns a positive integer, or null when absent/zero/malformed. Accepts a number
 * or a numeric string (GitHub sends a number; we narrow defensively).
 */
export function extractSeats(unitCount: unknown): number | null {
  if (typeof unitCount === "number" && Number.isInteger(unitCount) && unitCount > 0) return unitCount
  if (typeof unitCount === "string" && /^\d+$/.test(unitCount)) {
    const n = Number.parseInt(unitCount, 10)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

// ─── Minimal Marketplace wire shapes (only the fields we read) ───────────────

interface MarketplacePlan {
  id?: unknown
  name?: unknown
}

interface MarketplaceAccount {
  id?: unknown
  login?: unknown
  type?: unknown
}

interface MarketplacePurchase {
  account?: MarketplaceAccount
  unit_count?: unknown
  plan?: MarketplacePlan
}

/** A parsed `marketplace_purchase` event envelope — `action` + `marketplace_purchase`. */
export interface MarketplaceEvent {
  action?: unknown
  marketplace_purchase?: MarketplacePurchase
}

/** The outcome of interpreting a Marketplace event. */
export type MarketplaceInterpretation =
  | { kind: "ignore"; reason: string }
  // A pending_change / pending_change_cancelled: the effective change rides a later
  // `changed` event — ack now, touch nothing.
  | { kind: "defer"; reason: string }
  | {
      kind: "apply"
      /** 'purchased' | 'changed' | 'cancelled'. */
      action: "purchased" | "changed" | "cancelled"
      /** GitHub numeric account id (PK of marketplace_subscription), or null. */
      accountId: number | null
      /** The account login (used to resolve the installation), or null. */
      accountLogin: string | null
      /** 'Organization' | 'User', or null. */
      accountType: string | null
      /** The resolved Sigilix tier — the plan's tier (purchased/changed) or free (cancelled). */
      tier: MarketplaceTier
      /** unit_count, or null. Relevant for Teams (per-seat). */
      seats: number | null
      /** 'active' (purchased/changed) | 'canceled' (cancelled). */
      subscriptionStatus: "active" | "canceled"
    }

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function accountIdOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number.parseInt(v, 10)
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/** Normalize a plan id (GitHub sends a number; we accept a numeric string) to its string
 *  form for an exact env-map lookup. Non-numeric / absent → null. */
function planIdString(v: unknown): string | null {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v)
  return asString(v)
}

/**
 * Interpret a signature-verified `marketplace_purchase` event into a billing action.
 * Never throws on a malformed body — it degrades to `{kind:"ignore"}`. See the file
 * header for the recall-safety contract (unmappable plan → free; never enterprise).
 *
 *   • purchased / changed          → apply the plan's tier, status 'active'.
 *   • cancelled                    → apply tier 'free', status 'canceled'.
 *   • pending_change / _cancelled  → defer (the effective change arrives as a later
 *                                    `changed`); ack, no tier change.
 *   • anything else                → ignore.
 */
export function interpretMarketplaceEvent(
  event: MarketplaceEvent,
  planMap: MarketplacePlanMap,
): MarketplaceInterpretation {
  const action = asString(event.action)
  if (!action) return { kind: "ignore", reason: "missing-action" }

  if (action === "pending_change" || action === "pending_change_cancelled") {
    return { kind: "defer", reason: action }
  }
  if (action !== "purchased" && action !== "changed" && action !== "cancelled") {
    return { kind: "ignore", reason: `unhandled:${action}` }
  }

  const purchase = event.marketplace_purchase
  if (typeof purchase !== "object" || purchase === null) {
    return { kind: "ignore", reason: "missing-marketplace_purchase" }
  }
  const account = purchase.account
  const accountId = accountIdOf(account?.id)
  const accountLogin = asString(account?.login)
  const accountType = asString(account?.type)
  const seats = extractSeats(purchase.unit_count)

  if (action === "cancelled") {
    return {
      kind: "apply",
      action,
      accountId,
      accountLogin,
      accountType,
      tier: "free",
      seats,
      subscriptionStatus: "canceled",
    }
  }

  // purchased / changed
  const tier = resolveMarketplaceTier({
    planId: planIdString(purchase.plan?.id),
    planName: asString(purchase.plan?.name),
    planMap,
  })
  return {
    kind: "apply",
    action,
    accountId,
    accountLogin,
    accountType,
    tier,
    seats,
    subscriptionStatus: "active",
  }
}
