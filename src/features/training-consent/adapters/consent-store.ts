// sig-training-data-consent — D1 read/write of the data_learning_consent ledger.
//
// FAIL-CLOSED DEVIATION (deliberate): unlike the other tenancy adapters, which
// fail OPEN (a D1 fault returns null / a permissive default), reads here THROW on
// a genuine D1 error. That is load-bearing: the gate's resolveConsent() wraps
// this in try/catch and maps ANY throw to "denied", so a degraded platform DB can
// never be mistaken for "no explicit record → maybe granted-by-default". A
// MISSING ROW is not an error — it returns null (→ the caller applies the
// plan-based default, which is itself fail-closed).

import type { ConsentDecision, ConsentRecord, ConsentSource } from "@/src/features/training-consent/domain/types"
import type { Env } from "@/src/shared/types/env"

function isConsentDecision(v: unknown): v is ConsentDecision {
  return v === "granted" || v === "denied"
}

/**
 * Read the consent row for one installation. Returns null when the row does not
 * exist (no explicit choice yet). THROWS when the binding is missing or D1
 * errors — callers must treat a throw as fail-closed ("denied").
 */
export async function readConsentRecord(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  installationId: number,
): Promise<ConsentRecord | null> {
  if (!env.SIGILIX_PLATFORM_DB) {
    throw new Error("consent read: SIGILIX_PLATFORM_DB binding absent")
  }
  if (!Number.isInteger(installationId) || installationId <= 0) return null
  const row = await env.SIGILIX_PLATFORM_DB.prepare(
    "SELECT installation_id, consent, set_by, set_at, source, plan_at_grant" +
      " FROM data_learning_consent WHERE installation_id = ?",
  )
    .bind(installationId)
    .first<{
      installation_id: number
      consent: unknown
      set_by: unknown
      set_at: unknown
      source: unknown
      plan_at_grant: unknown
    }>()
  if (row == null) return null
  if (!isConsentDecision(row.consent)) {
    // A row that somehow holds a non-{granted,denied} value is treated as absent
    // of a valid choice — the caller falls to the fail-closed default.
    return null
  }
  return {
    installationId,
    consent: row.consent,
    setBy: typeof row.set_by === "string" ? row.set_by : "unknown",
    setAt: typeof row.set_at === "string" ? row.set_at : "",
    source: typeof row.source === "string" ? (row.source as ConsentSource) : "api",
    planAtGrant: typeof row.plan_at_grant === "string" ? row.plan_at_grant : null,
  }
}

/**
 * Upsert the consent row for one installation (one row per installation — the
 * PRIMARY KEY). Overwrites any prior decision (an org may revoke or re-grant).
 * THROWS on a missing binding or D1 error so the caller (the admin route) can
 * surface a 500 rather than silently claiming success.
 */
export async function upsertConsentRecord(
  env: Pick<Env, "SIGILIX_PLATFORM_DB">,
  args: {
    installationId: number
    consent: ConsentDecision
    setBy: string
    source: ConsentSource
    planAtGrant: string | null
    nowIso: string
  },
): Promise<void> {
  if (!env.SIGILIX_PLATFORM_DB) {
    throw new Error("consent write: SIGILIX_PLATFORM_DB binding absent")
  }
  if (!Number.isInteger(args.installationId) || args.installationId <= 0) {
    throw new Error("consent write: invalid installation id")
  }
  await env.SIGILIX_PLATFORM_DB.prepare(
    "INSERT INTO data_learning_consent (installation_id, consent, set_by, set_at, source, plan_at_grant)" +
      " VALUES (?, ?, ?, ?, ?, ?)" +
      " ON CONFLICT(installation_id) DO UPDATE SET" +
      " consent = excluded.consent, set_by = excluded.set_by, set_at = excluded.set_at," +
      " source = excluded.source, plan_at_grant = excluded.plan_at_grant",
  )
    .bind(args.installationId, args.consent, args.setBy, args.nowIso, args.source, args.planAtGrant)
    .run()
}
