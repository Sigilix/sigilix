// The single place the default-ON decision is encoded.
//
// ⚠️ ABSENCE MEANS ENABLED. This table is sparse — a row exists only once an admin
// has explicitly changed an app. Reading a missing row as "off" would switch off
// every existing customer's PR reviews the moment the migration landed, so the
// default lives here, once, rather than at each call site where someone could get
// it backwards.

import {
  ORG_APP_IDS,
  isOrgAppId,
  type OrgAppId,
  type OrgAppPolicy,
  type OrgAppPolicyRow,
  type OrgAppState,
} from "./types"

function defaultState(appId: OrgAppId): OrgAppState {
  return { appId, enabled: true, version: null, updatedBy: null, updatedAtMs: null }
}

/**
 * Project stored rows onto the full app set, defaulting anything absent to ON.
 *
 * Total: always returns all apps. Unknown/duplicate rows are ignored rather than
 * throwing — a policy read must never break the surface it governs.
 */
export function resolveOrgAppPolicy(rows: readonly OrgAppPolicyRow[]): OrgAppPolicy {
  const out = {} as OrgAppPolicy
  for (const appId of ORG_APP_IDS) out[appId] = defaultState(appId)
  for (const row of rows) {
    // `in` would be true for prototype keys ("constructor", "__proto__"), which would
    // add a 7th key / mutate the prototype and break the totality contract. Use the
    // real guard — this function is barrel-exported and a route handler feeding it
    // request-shaped rows is the obvious next caller.
    if (!isOrgAppId(row.appId)) continue
    out[row.appId] = {
      appId: row.appId,
      enabled: row.enabled,
      version: row.version,
      updatedBy: row.updatedBy,
      updatedAtMs: row.updatedAtMs,
    }
  }
  return out
}

/**
 * Is this app switched on for the org?
 *
 * ⚠️ This answers the CUSTOMER-CHOICE question only. It is NOT an authorization
 * check: callers must still apply the entitlement gate (tier) and, where relevant,
 * confirm the integration is connected. An app can be enabled here and still be
 * unavailable because the plan doesn't include it.
 */
export function isOrgAppEnabled(policy: OrgAppPolicy, appId: OrgAppId): boolean {
  // No `?? true` fallback: resolveOrgAppPolicy is TOTAL, so the default lives in
  // exactly one place (defaultState). A second encoding here would survive someone
  // changing that one and silently disagree with it.
  return policy[appId].enabled
}
