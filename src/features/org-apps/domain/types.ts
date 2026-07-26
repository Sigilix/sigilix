// Per-org APP on/off policy — which Sigilix surfaces an org chooses to run.
//
// The founder's model: apps are OPTIONAL per org; what you pay for is capacity and
// breadth, never which surfaces you're allowed to connect. This is the storage of
// that choice.

/** The product-facing surfaces an org can switch on or off. */
export const ORG_APP_IDS = ["pr_review", "slack", "linear", "cli", "chat", "ci_triage"] as const

export type OrgAppId = (typeof ORG_APP_IDS)[number]

export function isOrgAppId(v: unknown): v is OrgAppId {
  return typeof v === "string" && (ORG_APP_IDS as readonly string[]).includes(v)
}

/** A stored row. Rows are SPARSE — one exists only after an explicit change. */
export interface OrgAppPolicyRow {
  appId: OrgAppId
  enabled: boolean
  version: number
  updatedBy: string
  updatedAtMs: number
}

/**
 * The resolved state of one app, as the UI and the enforcement points should read it.
 *
 * `enabled` is the CUSTOMER's choice only. It deliberately says nothing about whether
 * the app is entitled on their tier, or whether it's connected — those are separate
 * axes owned by features/entitlements and the per-integration connection tables. A
 * surface is live only when all three agree, and the UI needs to distinguish them so
 * a greyed-out control can explain WHY it's greyed.
 */
export interface OrgAppState {
  appId: OrgAppId
  enabled: boolean
  /** Absent when the org has never changed this app — i.e. it is on by default. */
  version: number | null
  updatedBy: string | null
  updatedAtMs: number | null
}

/** Every app, defaulted. The read side is total: callers always get all six. */
export type OrgAppPolicy = Record<OrgAppId, OrgAppState>
