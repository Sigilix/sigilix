// Durable arbitration for Stripe Checkout Session creation. One current row per
// exact GitHub installation owns the provider request body + idempotency key, so
// concurrent/retried upgrade requests cannot mint independent subscriptions.

import type { Env } from "@/src/shared/types/env"

const ATTEMPT_ID = /^[A-Za-z0-9_-]{1,128}$/
const FINGERPRINT = /^[0-9a-f]{64}$/
const MAX_IDEMPOTENCY_KEY_CHARS = 255
const MAX_REQUEST_BODY_CHARS = 65_536

type DbEnv = Pick<Env, "SIGILIX_PLATFORM_DB">

interface CheckoutAttemptRow {
  installation_id: unknown
  attempt_id: unknown
  intent_fingerprint: unknown
  request_body: unknown
  idempotency_key: unknown
  state: unknown
  generation: unknown
  lease_token: unknown
  lease_expires_at_ms: unknown
  stripe_expires_at_ms: unknown
  replace_after_ms: unknown
  stripe_session_id: unknown
  checkout_url: unknown
  created_at_ms: unknown
  updated_at_ms: unknown
  ready_at_ms: unknown
}

const ATTEMPT_COLUMNS = `installation_id, attempt_id, intent_fingerprint, request_body, idempotency_key,
  state, generation, lease_token, lease_expires_at_ms, stripe_expires_at_ms,
  replace_after_ms, stripe_session_id, checkout_url, created_at_ms, updated_at_ms, ready_at_ms`

export interface CheckoutAttemptLease {
  installationId: number
  attemptId: string
  intentFingerprint: string
  requestBody: string
  idempotencyKey: string
  generation: number
  leaseToken: string
  leaseExpiresAtMs: number
  stripeExpiresAtMs: number
  replaceAfterMs: number
}

export type CheckoutAttemptClaimResult =
  | { kind: "acquired"; lease: CheckoutAttemptLease }
  | { kind: "ready"; sessionId: string; url: string; stripeExpiresAtMs: number }
  | { kind: "busy"; reason: "creating" | "intent_conflict" | "expired_grace"; retryAfterSeconds: number }
  | { kind: "ineligible" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }

export type CheckoutAttemptCompleteResult =
  | { kind: "ready"; sessionId: string; url: string }
  | { kind: "ineligible" }
  | { kind: "stale" }
  | { kind: "error"; reason: "invalid_input" | "invalid_row" | "unavailable" }

export interface CheckoutAttemptCandidate {
  installationId: number
  attemptId: string
  intentFingerprint: string
  requestBody: string
  idempotencyKey: string
  leaseToken: string
  nowMs: number
  leaseExpiresAtMs: number
  stripeExpiresAtMs: number
  replaceAfterMs: number
  nowIso: string
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function validCandidate(value: CheckoutAttemptCandidate): boolean {
  return (
    positiveSafeInteger(value.installationId) &&
    ATTEMPT_ID.test(value.attemptId) &&
    FINGERPRINT.test(value.intentFingerprint) &&
    nonEmpty(value.requestBody) &&
    value.requestBody.length <= MAX_REQUEST_BODY_CHARS &&
    nonEmpty(value.idempotencyKey) &&
    value.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_CHARS &&
    ATTEMPT_ID.test(value.leaseToken) &&
    nonNegativeSafeInteger(value.nowMs) &&
    positiveSafeInteger(value.leaseExpiresAtMs) &&
    positiveSafeInteger(value.stripeExpiresAtMs) &&
    positiveSafeInteger(value.replaceAfterMs) &&
    value.leaseExpiresAtMs > value.nowMs &&
    value.stripeExpiresAtMs > value.leaseExpiresAtMs &&
    value.replaceAfterMs > value.stripeExpiresAtMs &&
    value.nowIso.trim().length > 0
  )
}

function validHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:"
  } catch {
    return false
  }
}

function decodeCreatingLease(row: CheckoutAttemptRow): CheckoutAttemptLease | null {
  if (
    !positiveSafeInteger(row.installation_id) ||
    !nonEmpty(row.attempt_id) ||
    !ATTEMPT_ID.test(row.attempt_id) ||
    !nonEmpty(row.intent_fingerprint) ||
    !FINGERPRINT.test(row.intent_fingerprint) ||
    !nonEmpty(row.request_body) ||
    row.request_body.length > MAX_REQUEST_BODY_CHARS ||
    !nonEmpty(row.idempotency_key) ||
    row.idempotency_key.length > MAX_IDEMPOTENCY_KEY_CHARS ||
    row.state !== "creating" ||
    !positiveSafeInteger(row.generation) ||
    !nonEmpty(row.lease_token) ||
    !ATTEMPT_ID.test(row.lease_token) ||
    !positiveSafeInteger(row.lease_expires_at_ms) ||
    !positiveSafeInteger(row.stripe_expires_at_ms) ||
    !positiveSafeInteger(row.replace_after_ms) ||
    !nonNegativeSafeInteger(row.created_at_ms) ||
    !nonNegativeSafeInteger(row.updated_at_ms) ||
    row.updated_at_ms < row.created_at_ms ||
    row.lease_expires_at_ms <= row.updated_at_ms ||
    row.stripe_expires_at_ms <= row.updated_at_ms ||
    row.replace_after_ms <= row.stripe_expires_at_ms ||
    row.stripe_session_id !== null ||
    row.checkout_url !== null ||
    row.ready_at_ms !== null
  ) {
    return null
  }
  return {
    installationId: row.installation_id,
    attemptId: row.attempt_id,
    intentFingerprint: row.intent_fingerprint,
    requestBody: row.request_body,
    idempotencyKey: row.idempotency_key,
    generation: row.generation,
    leaseToken: row.lease_token,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    stripeExpiresAtMs: row.stripe_expires_at_ms,
    replaceAfterMs: row.replace_after_ms,
  }
}

function decodeReady(row: CheckoutAttemptRow): { sessionId: string; url: string; stripeExpiresAtMs: number } | null {
  if (
    row.state !== "ready" ||
    !positiveSafeInteger(row.installation_id) ||
    !nonEmpty(row.attempt_id) ||
    !ATTEMPT_ID.test(row.attempt_id) ||
    !nonEmpty(row.intent_fingerprint) ||
    !FINGERPRINT.test(row.intent_fingerprint) ||
    !nonEmpty(row.request_body) ||
    row.request_body.length > MAX_REQUEST_BODY_CHARS ||
    !nonEmpty(row.idempotency_key) ||
    row.idempotency_key.length > MAX_IDEMPOTENCY_KEY_CHARS ||
    !positiveSafeInteger(row.generation) ||
    row.lease_token !== null ||
    row.lease_expires_at_ms !== null ||
    !positiveSafeInteger(row.stripe_expires_at_ms) ||
    !positiveSafeInteger(row.replace_after_ms) ||
    row.replace_after_ms <= row.stripe_expires_at_ms ||
    !nonEmpty(row.stripe_session_id) ||
    !nonEmpty(row.checkout_url) ||
    !validHttpsUrl(row.checkout_url) ||
    !nonNegativeSafeInteger(row.created_at_ms) ||
    !nonNegativeSafeInteger(row.updated_at_ms) ||
    !nonNegativeSafeInteger(row.ready_at_ms) ||
    row.updated_at_ms < row.created_at_ms ||
    row.ready_at_ms < row.created_at_ms ||
    row.ready_at_ms > row.updated_at_ms ||
    row.ready_at_ms >= row.stripe_expires_at_ms
  ) {
    return null
  }
  return { sessionId: row.stripe_session_id, url: row.checkout_url, stripeExpiresAtMs: row.stripe_expires_at_ms }
}

function retryAfterSeconds(nowMs: number, deadlineMs: number): number {
  return Math.max(1, Math.min(60, Math.ceil((deadlineMs - nowMs) / 1_000)))
}

/**
 * Atomically claim, take over, or replace one installation's current Checkout
 * operation. The tenant insert and claim run in one D1 transaction; the claim's
 * predicate repeats subscription liveness so a concurrent billing webhook wins
 * before any new provider request can be issued.
 */
export async function claimCheckoutAttempt(
  env: DbEnv,
  candidate: CheckoutAttemptCandidate,
): Promise<CheckoutAttemptClaimResult> {
  if (!validCandidate(candidate)) return { kind: "error", reason: "invalid_input" }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }

  try {
    const session = env.SIGILIX_PLATFORM_DB.withSession("first-primary")
    const ensureTenant = session
      .prepare(
        `INSERT OR IGNORE INTO tenant (installation_id, tier, created_at, updated_at)
         VALUES (?, 'free', ?, ?)`,
      )
      .bind(candidate.installationId, candidate.nowIso, candidate.nowIso)
    const claim = session
      .prepare(
        `INSERT INTO stripe_checkout_attempt
          (installation_id, attempt_id, intent_fingerprint, request_body, idempotency_key,
           state, generation, lease_token, lease_expires_at_ms, stripe_expires_at_ms,
           replace_after_ms, stripe_session_id, checkout_url, created_at_ms, updated_at_ms,
           ready_at_ms)
         SELECT ?, ?, ?, ?, ?, 'creating', 1, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL
          WHERE EXISTS (
            SELECT 1 FROM tenant
             WHERE installation_id = ?
               AND (
                 lower(trim(COALESCE(subscription_status, ''))) NOT IN ('active', 'trialing')
                 OR billing_source = 'legacy_entitlement'
               )
          )
         ON CONFLICT(installation_id) DO UPDATE SET
           attempt_id = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.attempt_id
             ELSE stripe_checkout_attempt.attempt_id END,
           intent_fingerprint = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.intent_fingerprint
             ELSE stripe_checkout_attempt.intent_fingerprint END,
           request_body = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.request_body
             ELSE stripe_checkout_attempt.request_body END,
           idempotency_key = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.idempotency_key
             ELSE stripe_checkout_attempt.idempotency_key END,
           state = 'creating',
           generation = stripe_checkout_attempt.generation + 1,
           lease_token = excluded.lease_token,
           lease_expires_at_ms = excluded.lease_expires_at_ms,
           stripe_expires_at_ms = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.stripe_expires_at_ms
             ELSE stripe_checkout_attempt.stripe_expires_at_ms END,
           replace_after_ms = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.replace_after_ms
             ELSE stripe_checkout_attempt.replace_after_ms END,
           stripe_session_id = NULL,
           checkout_url = NULL,
           created_at_ms = CASE
             WHEN stripe_checkout_attempt.replace_after_ms <= ? THEN excluded.created_at_ms
             ELSE stripe_checkout_attempt.created_at_ms END,
           updated_at_ms = excluded.updated_at_ms,
           ready_at_ms = NULL
         WHERE EXISTS (
           SELECT 1 FROM tenant
            WHERE installation_id = stripe_checkout_attempt.installation_id
              AND (
                lower(trim(COALESCE(subscription_status, ''))) NOT IN ('active', 'trialing')
                OR billing_source = 'legacy_entitlement'
              )
         ) AND (
           stripe_checkout_attempt.generation < 9007199254740991
           AND (
           stripe_checkout_attempt.replace_after_ms <= ?
           OR (
             stripe_checkout_attempt.intent_fingerprint = excluded.intent_fingerprint
             AND stripe_checkout_attempt.state = 'creating'
             AND stripe_checkout_attempt.lease_expires_at_ms <= ?
             AND stripe_checkout_attempt.stripe_expires_at_ms > ?
           )
           )
         )`,
      )
      .bind(
        candidate.installationId,
        candidate.attemptId,
        candidate.intentFingerprint,
        candidate.requestBody,
        candidate.idempotencyKey,
        candidate.leaseToken,
        candidate.leaseExpiresAtMs,
        candidate.stripeExpiresAtMs,
        candidate.replaceAfterMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.installationId,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
        candidate.nowMs,
      )

    const liveness = session
      .prepare(
        `SELECT CASE
           WHEN lower(trim(COALESCE(subscription_status, ''))) IN ('active', 'trialing')
            AND COALESCE(billing_source, '') <> 'legacy_entitlement'
           THEN 0 ELSE 1 END AS checkout_eligible
         FROM tenant WHERE installation_id = ?`,
      )
      .bind(candidate.installationId)
    const attempt = session
      .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM stripe_checkout_attempt WHERE installation_id = ?`)
      .bind(candidate.installationId)

    const results = await session.batch<Record<string, unknown>>([ensureTenant, claim, liveness, attempt])
    const livenessRow = results[2]?.results[0]
    if (livenessRow?.checkout_eligible !== 0 && livenessRow?.checkout_eligible !== 1) {
      return { kind: "error", reason: "invalid_row" }
    }
    if (livenessRow.checkout_eligible === 0) return { kind: "ineligible" }
    const row = (results[3]?.results[0] as CheckoutAttemptRow | undefined) ?? null
    if (row === null) return { kind: "error", reason: "invalid_row" }

    if (row.state === "ready") {
      const ready = decodeReady(row)
      if (!ready) return { kind: "error", reason: "invalid_row" }
      if (candidate.nowMs >= Number(row.replace_after_ms)) return { kind: "error", reason: "invalid_row" }
      if (row.intent_fingerprint === candidate.intentFingerprint && candidate.nowMs < ready.stripeExpiresAtMs) {
        return { kind: "ready", ...ready }
      }
      const reason =
        candidate.nowMs >= ready.stripeExpiresAtMs && candidate.nowMs < Number(row.replace_after_ms)
          ? "expired_grace"
          : "intent_conflict"
      return {
        kind: "busy",
        reason,
        retryAfterSeconds: retryAfterSeconds(candidate.nowMs, Number(row.replace_after_ms)),
      }
    }

    const lease = decodeCreatingLease(row)
    if (!lease) return { kind: "error", reason: "invalid_row" }
    if (lease.leaseToken === candidate.leaseToken) return { kind: "acquired", lease }
    if (candidate.nowMs >= lease.replaceAfterMs) return { kind: "error", reason: "invalid_row" }

    if (candidate.nowMs >= lease.stripeExpiresAtMs && candidate.nowMs < lease.replaceAfterMs) {
      return {
        kind: "busy",
        reason: "expired_grace",
        retryAfterSeconds: retryAfterSeconds(candidate.nowMs, lease.replaceAfterMs),
      }
    }
    if (lease.intentFingerprint !== candidate.intentFingerprint) {
      return {
        kind: "busy",
        reason: "intent_conflict",
        retryAfterSeconds: retryAfterSeconds(candidate.nowMs, lease.replaceAfterMs),
      }
    }
    if (lease.leaseExpiresAtMs <= candidate.nowMs) return { kind: "error", reason: "invalid_row" }
    return {
      kind: "busy",
      reason: "creating",
      retryAfterSeconds: retryAfterSeconds(candidate.nowMs, lease.leaseExpiresAtMs),
    }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}

/** Fence a provider success to the exact lease generation that issued it. */
export async function completeCheckoutAttempt(
  env: DbEnv,
  args: CheckoutAttemptLease & { sessionId: string; url: string; nowMs: number },
): Promise<CheckoutAttemptCompleteResult> {
  if (
    !positiveSafeInteger(args.installationId) ||
    !ATTEMPT_ID.test(args.attemptId) ||
    !FINGERPRINT.test(args.intentFingerprint) ||
    !ATTEMPT_ID.test(args.leaseToken) ||
    !positiveSafeInteger(args.generation) ||
    !nonEmpty(args.sessionId) ||
    !nonEmpty(args.url) ||
    !validHttpsUrl(args.url) ||
    !nonNegativeSafeInteger(args.nowMs)
  ) {
    return { kind: "error", reason: "invalid_input" }
  }
  if (!env.SIGILIX_PLATFORM_DB) return { kind: "error", reason: "unavailable" }

  try {
    const session = env.SIGILIX_PLATFORM_DB.withSession("first-primary")
    const update = session
      .prepare(
        `UPDATE stripe_checkout_attempt
            SET state = 'ready', lease_token = NULL, lease_expires_at_ms = NULL,
                stripe_session_id = ?, checkout_url = ?, updated_at_ms = ?, ready_at_ms = ?
          WHERE installation_id = ? AND attempt_id = ? AND intent_fingerprint = ?
            AND state = 'creating' AND generation = ? AND lease_token = ?
            AND stripe_expires_at_ms > ?
            AND EXISTS (
              SELECT 1 FROM tenant
               WHERE installation_id = stripe_checkout_attempt.installation_id
                 AND (
                   lower(trim(COALESCE(subscription_status, ''))) NOT IN ('active', 'trialing')
                   OR billing_source = 'legacy_entitlement'
                 )
            )`,
      )
      .bind(
        args.sessionId,
        args.url,
        args.nowMs,
        args.nowMs,
        args.installationId,
        args.attemptId,
        args.intentFingerprint,
        args.generation,
        args.leaseToken,
        args.nowMs,
      )
    const liveness = session
      .prepare(
        `SELECT CASE
           WHEN lower(trim(COALESCE(subscription_status, ''))) IN ('active', 'trialing')
            AND COALESCE(billing_source, '') <> 'legacy_entitlement'
           THEN 0 ELSE 1 END AS checkout_eligible
         FROM tenant WHERE installation_id = ?`,
      )
      .bind(args.installationId)
    const attempt = session
      .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM stripe_checkout_attempt WHERE installation_id = ?`)
      .bind(args.installationId)
    const results = await session.batch<Record<string, unknown>>([update, liveness, attempt])
    const livenessRow = results[1]?.results[0]
    if (livenessRow?.checkout_eligible !== 0 && livenessRow?.checkout_eligible !== 1) {
      return { kind: "error", reason: "invalid_row" }
    }
    if (livenessRow.checkout_eligible === 0) return { kind: "ineligible" }
    if (Number(results[0]?.meta.changes ?? 0) === 1) {
      return { kind: "ready", sessionId: args.sessionId, url: args.url }
    }

    const row = (results[2]?.results[0] as CheckoutAttemptRow | undefined) ?? null
    if (row === null) return { kind: "stale" }
    if (row.state !== "ready") {
      return decodeCreatingLease(row) ? { kind: "stale" } : { kind: "error", reason: "invalid_row" }
    }
    const ready = decodeReady(row)
    if (!ready) return { kind: "error", reason: "invalid_row" }
    if (args.nowMs >= ready.stripeExpiresAtMs) return { kind: "stale" }
    return row.attempt_id === args.attemptId &&
      row.intent_fingerprint === args.intentFingerprint &&
      ready.sessionId === args.sessionId &&
      ready.url === args.url
      ? { kind: "ready", sessionId: ready.sessionId, url: ready.url }
      : { kind: "stale" }
  } catch {
    return { kind: "error", reason: "unavailable" }
  }
}
