// sig-training-data-consent — the org data-learning consent API.
//
//   GET  /v1/org/:installationId/data-consent   → read the effective consent
//   POST /v1/org/:installationId/data-consent   → set consent (admin-only)
//
// This is the human control surface over whether Sigilix may retain the org's
// data for MODEL TRAINING. It is SEPARATE from the operational learnings/review
// pipeline — setting consent here only writes the data_learning_consent ledger
// (and, on revocation, purges the training partition); it never touches review
// behavior.
//
// AUTH — SESSION-ONLY, admin-gated, PER-INSTALLATION (mirrors org-seat-route.ts).
// A portal SESSION cookie is required (a consent change is legally load-bearing +
// keys off a real GitHub identity; a service api-key has none). The caller must
// be an admin of THIS installation via isAdminOfInstallation (NOT the aggregate
// resolveUserRole) — this both enforces the admin gate AND tenant isolation (an
// installation the caller's token can't see is never one they're an admin of, so
// a cross-tenant target 403s and no row is written / read).
//
// FAIL-CLOSED overall: no session → 401; wrong content-type on POST → 415;
// missing encryption key → 503; decrypt failure → 500; not an admin of this
// installation → 403; malformed body → 400. A write only happens once every gate
// has passed. The GET is admin-gated too (consent state is org-governance data).

import { requireSession } from "@/src/lib/auth-middleware"
import { decryptAccessToken } from "@/src/lib/auth-session"
import { isAdminOfInstallation } from "@/src/lib/resolve-user-role"
import { hasJsonContentType } from "@/src/lib/portal-cors"
import {
  purgeTrainingData,
  readConsentRecord,
  readPlanForInstallation,
  resolveConsent,
  resolveDefaultConsent,
  upsertConsentRecord,
  type ConsentDecision,
} from "@/src/features/training-consent"
import type { Env } from "@/src/shared/types/env"

export interface ConsentStateResponse {
  installationId: number
  /** The effective decision the gate would use right now. */
  consent: ConsentDecision
  /** True when there is NO explicit row — `consent` came from the plan default. */
  isDefault: boolean
  /** The plan-derived default (what applies with no explicit choice). */
  planDefault: ConsentDecision
  setBy: string | null
  setAt: string | null
  source: string | null
  planAtGrant: string | null
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

/** Parse the `{ consent: "granted" | "denied" }` body. Null on any malformed input. */
async function parseConsent(request: Request): Promise<ConsentDecision | null> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return null
  }
  if (typeof body !== "object" || body === null) return null
  const consent = (body as { consent?: unknown }).consent
  return consent === "granted" || consent === "denied" ? consent : null
}

/** Resolve the session's access token, or return an error Response to send. */
async function authAdmin(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<{ ok: true; callerLogin: string } | { ok: false; response: Response }> {
  const session = await requireSession(request, env, ctx)
  if (!session) return { ok: false, response: json({ error: "unauthorized" }, 401) }
  if (!env.OPENCLAW_SESSION_ENCRYPTION_KEY) {
    console.error(JSON.stringify({ event: "data-consent-encryption-key-missing" }))
    return { ok: false, response: json({ error: "misconfigured" }, 503) }
  }
  let accessToken: string
  try {
    accessToken = await decryptAccessToken(
      { encryptedAccessToken: session.record.encryptedAccessToken, iv: session.record.iv },
      session.sessionId,
      env.OPENCLAW_SESSION_ENCRYPTION_KEY,
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "data-consent-decrypt-failed",
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return { ok: false, response: json({ error: "consent_failed" }, 500) }
  }
  const callerLogin = session.record.login
  const isAdmin = await isAdminOfInstallation(accessToken, callerLogin, installationId)
  if (!isAdmin) return { ok: false, response: json({ error: "forbidden" }, 403) }
  return { ok: true, callerLogin }
}

/** GET — the effective consent + provenance for one installation. Admin-only. */
export async function handleGetDataConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  const auth = await authAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  let record: Awaited<ReturnType<typeof readConsentRecord>> = null
  let planDefault: ConsentDecision = "denied"
  try {
    record = await readConsentRecord(env, installationId)
    const plan = await readPlanForInstallation(env, installationId)
    planDefault = resolveDefaultConsent(plan)
  } catch (error) {
    // Read fault → present the fail-closed effective decision. resolveConsent is
    // itself fail-closed, so we surface a coherent (denied-leaning) state at 200
    // rather than 500 — the panel still renders.
    console.warn(
      JSON.stringify({
        event: "data-consent-read-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  const effective = record ? record.consent : await resolveConsent(env, installationId)
  const body: ConsentStateResponse = {
    installationId,
    consent: effective,
    isDefault: record === null,
    planDefault,
    setBy: record?.setBy ?? null,
    setAt: record?.setAt ?? null,
    source: record?.source ?? null,
    planAtGrant: record?.planAtGrant ?? null,
  }
  return json(body, 200)
}

/** POST — set consent for one installation. Admin-only. Revocation purges. */
export async function handleSetDataConsent(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  installationId: number,
): Promise<Response> {
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return json({ error: "invalid installation id" }, 400)
  }
  // CSRF guard (SameSite=None session cookie) — force a preflight before the body.
  if (!hasJsonContentType(request)) return json({ error: "content-type must be application/json" }, 415)

  const consent = await parseConsent(request)
  if (consent === null) return json({ error: 'body must be { consent: "granted" | "denied" }' }, 400)

  const auth = await authAdmin(request, env, ctx, installationId)
  if (!auth.ok) return auth.response

  // Snapshot the plan at grant time (audit; best-effort — a lookup fault records null).
  let planAtGrant: string | null = null
  try {
    planAtGrant = await readPlanForInstallation(env, installationId)
  } catch {
    planAtGrant = null
  }

  const nowIso = new Date().toISOString()
  try {
    await upsertConsentRecord(env, {
      installationId,
      consent,
      setBy: auth.callerLogin,
      source: "portal-admin",
      planAtGrant,
      nowIso,
    })
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "data-consent-write-failed",
        installationId,
        err: error instanceof Error ? error.message : String(error),
      }),
    )
    return json({ error: "consent_failed" }, 500)
  }

  // RIGHT-TO-FORGET on revocation: a denial purges any already-retained partition
  // (a no-op today — the store binding is absent at launch). Best-effort; never
  // blocks the 200 the write earned.
  let purged = 0
  if (consent === "denied") {
    purged = await purgeTrainingData(env, installationId)
  }

  return json({ installationId, consent, setBy: auth.callerLogin, setAt: nowIso, purged }, 200)
}
