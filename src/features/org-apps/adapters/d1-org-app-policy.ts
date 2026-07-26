// org_app_policy read/write. Schema DDL is owned by migration 0038.
//
// READ FAILS OPEN — deliberately, and this is the load-bearing choice in the file.
// A transient D1 error means "we couldn't read your preference", not "you turned
// everything off". Failing closed would let one D1 blip silently stop every
// customer's PR reviews with no error anywhere the customer can see. So a failed
// read returns the all-defaults (all-ON) policy, exactly as an org that never
// touched a toggle. The cost of that choice is the honest one: an org that DID
// switch an app off may briefly see it run during an outage.
//
// WRITE IS STRICT — it reports failure to the caller, because an admin who clicks
// "off" and gets a success toast while nothing was written is worse than an error.

import type { Env } from "@/src/shared/types/env"
import { resolveOrgAppPolicy } from "@/src/features/org-apps/domain/resolve"
import {
  isOrgAppId,
  type OrgAppId,
  type OrgAppPolicy,
  type OrgAppPolicyRow,
} from "@/src/features/org-apps/domain/types"

/** Read every stored app row for an org and project it onto the full app set. */
export async function readOrgAppPolicy(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<OrgAppPolicy> {
  if (!env.SIGILIX_PLATFORM_DB || !Number.isFinite(installationId) || installationId <= 0) {
    return resolveOrgAppPolicy([])
  }
  try {
    const { results } = await env.SIGILIX_PLATFORM_DB.prepare(
      "SELECT app_id, enabled, version, updated_by, updated_at_ms FROM org_app_policy WHERE installation_id = ?",
    )
      .bind(Math.trunc(installationId))
      .all<{ app_id: unknown; enabled: unknown; version: unknown; updated_by: unknown; updated_at_ms: unknown }>()
    const rows: OrgAppPolicyRow[] = []
    for (const r of results) {
      if (!isOrgAppId(r.app_id)) continue
      rows.push({
        appId: r.app_id,
        enabled: Number(r.enabled) === 1,
        version: Number(r.version) || 1,
        updatedBy: typeof r.updated_by === "string" ? r.updated_by : "",
        updatedAtMs: Number(r.updated_at_ms) || 0,
      })
    }
    return resolveOrgAppPolicy(rows)
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-org-app-policy-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    // Fail OPEN — see the header. Never silently disable a customer's apps.
    return resolveOrgAppPolicy([])
  }
}

export type WriteOrgAppPolicyResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict" | "unavailable" | "error" }

/**
 * Upsert one app's state with optimistic concurrency.
 *
 * `expectedVersion` is what the caller read: `null` means "there was no row".
 * A mismatch returns `conflict` rather than clobbering a concurrent admin's change.
 */
export async function writeOrgAppPolicy(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    installationId: number
    appId: OrgAppId
    enabled: boolean
    expectedVersion: number | null
    updatedBy: string
    nowMs: number
  },
): Promise<WriteOrgAppPolicyResult> {
  if (!env.SIGILIX_PLATFORM_DB) return { ok: false, reason: "unavailable" }
  const db = env.SIGILIX_PLATFORM_DB
  const installationId = Math.trunc(args.installationId)
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { ok: false, reason: "error" }
  // ⚠️ `null` is the ONLY create sentinel here. The sibling skill-policy store uses
  // `0` for that, so passing 0 is a live mistake — and it would take the UPDATE
  // branch with `version = 0`, which `CHECK (version > 0)` guarantees can never
  // match. The admin would get "conflict" forever, unrecoverable by reloading.
  // Reject it loudly instead of returning a lie.
  const { expectedVersion } = args
  if (expectedVersion !== null && !(Number.isSafeInteger(expectedVersion) && expectedVersion > 0)) {
    return { ok: false, reason: "error" }
  }
  const nowMs = Number.isSafeInteger(args.nowMs) && args.nowMs >= 0 ? args.nowMs : 0
  // Bounded: this lands in an audit column the portal renders.
  const updatedBy = args.updatedBy.slice(0, 160)
  const nextVersion = (expectedVersion ?? 0) + 1
  try {
    if (expectedVersion === null) {
      // First write for this app: succeed only if no row appeared meanwhile.
      const res = await db
        .prepare(
          "INSERT INTO org_app_policy (installation_id, app_id, enabled, version, updated_by, updated_at_ms)" +
            " VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (installation_id, app_id) DO NOTHING",
        )
        .bind(installationId, args.appId, args.enabled ? 1 : 0, updatedBy, nowMs)
        .run()
      return res.meta.changes === 1 ? { ok: true, version: 1 } : { ok: false, reason: "conflict" }
    }
    const res = await db
      .prepare(
        "UPDATE org_app_policy SET enabled = ?, version = ?, updated_by = ?, updated_at_ms = ?" +
          " WHERE installation_id = ? AND app_id = ? AND version = ?",
      )
      .bind(args.enabled ? 1 : 0, nextVersion, updatedBy, nowMs, installationId, args.appId, expectedVersion)
      .run()
    return res.meta.changes === 1 ? { ok: true, version: nextVersion } : { ok: false, reason: "conflict" }
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "d1-org-app-policy-write-failed",
        installationId,
        appId: args.appId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, reason: "error" }
  }
}
