import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import {
  claimCheckoutAttempt,
  completeCheckoutAttempt,
  type CheckoutAttemptCandidate,
  type CheckoutAttemptLease,
} from "@/src/features/billing/adapters/checkout-attempt-store"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"

const INSTALLATION_ID = 555
const migration = (name: string) => readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), "utf8")

async function makeDb(options?: { status?: string | null; billingSource?: string | null }): Promise<D1Database> {
  const db = makeD1()
  for (const name of [
    "0001_create_tenant_repo_usage.sql",
    "0011_add_tenant_subscription_status.sql",
    "0012_add_tenant_billing_source.sql",
    "0027_create_billing_checkout_attempt.sql",
  ]) {
    await db.exec(migration(name))
  }
  await db
    .prepare(
      `INSERT INTO tenant
        (installation_id, tier, subscription_status, billing_source, created_at, updated_at)
       VALUES (?, 'free', ?, ?, 't', 't')`,
    )
    .bind(
      INSTALLATION_ID,
      options && "status" in options ? options.status : "canceled",
      options && "billingSource" in options ? options.billingSource : "stripe",
    )
    .run()
  return db
}

function candidate(
  suffix: string,
  nowMs = 1_000,
  overrides: Partial<CheckoutAttemptCandidate> = {},
): CheckoutAttemptCandidate {
  const stripeExpiresAtMs = Math.floor(nowMs / 1_000) * 1_000 + 3_600_000
  return {
    installationId: INSTALLATION_ID,
    attemptId: `attempt-${suffix}`,
    intentFingerprint: "a".repeat(64),
    requestBody: `mode=subscription&attempt=${suffix}`,
    idempotencyKey: `sigilix-checkout-attempt-${suffix}`,
    leaseToken: `lease-${suffix}`,
    nowMs,
    leaseExpiresAtMs: nowMs + 45_000,
    stripeExpiresAtMs,
    replaceAfterMs: stripeExpiresAtMs + 300_000,
    nowIso: new Date(nowMs).toISOString(),
    ...overrides,
  }
}

function acquiredLease(result: Awaited<ReturnType<typeof claimCheckoutAttempt>>): CheckoutAttemptLease {
  expect(result.kind).toBe("acquired")
  if (result.kind !== "acquired") throw new Error(`expected acquired, got ${result.kind}`)
  return result.lease
}

describe("checkout attempt D1 arbitration", () => {
  let db: D1Database

  beforeEach(async () => {
    db = await makeDb()
  })

  it("grants one lease for concurrent identical claims", async () => {
    const [left, right] = await Promise.all([
      claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("left")),
      claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("right")),
    ])

    expect([left.kind, right.kind].sort()).toEqual(["acquired", "busy"])
    const busy = left.kind === "busy" ? left : right
    expect(busy).toMatchObject({ kind: "busy", reason: "creating" })
  })

  it("reclaims an expired lease with the original body and idempotency key", async () => {
    const first = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("first")))
    const recoveryCandidate = candidate("recovery", first.leaseExpiresAtMs, {
      intentFingerprint: first.intentFingerprint,
    })

    const recovered = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, recoveryCandidate))

    expect(recovered).toMatchObject({
      attemptId: first.attemptId,
      requestBody: first.requestBody,
      idempotencyKey: first.idempotencyKey,
      intentFingerprint: first.intentFingerprint,
      generation: first.generation + 1,
      leaseToken: recoveryCandidate.leaseToken,
    })
  })

  it("lets a completion win after nominal lease expiry when no takeover occurred", async () => {
    const lease = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("slow")))
    const completed = await completeCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      {
        ...lease,
        sessionId: "cs_slow",
        url: "https://checkout.stripe.com/pay/cs_slow",
        nowMs: lease.leaseExpiresAtMs,
      },
    )

    expect(completed).toEqual({
      kind: "ready",
      sessionId: "cs_slow",
      url: "https://checkout.stripe.com/pay/cs_slow",
    })
  })

  it("fences a stale generation after a lease takeover", async () => {
    const original = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("original")))
    const current = acquiredLease(
      await claimCheckoutAttempt(
        { SIGILIX_PLATFORM_DB: db },
        candidate("takeover", original.leaseExpiresAtMs, { intentFingerprint: original.intentFingerprint }),
      ),
    )

    const stale = await completeCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      {
        ...original,
        sessionId: "cs_stale",
        url: "https://checkout.stripe.com/pay/cs_stale",
        nowMs: original.leaseExpiresAtMs + 1,
      },
    )
    const winner = await completeCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      {
        ...current,
        sessionId: "cs_current",
        url: "https://checkout.stripe.com/pay/cs_current",
        nowMs: original.leaseExpiresAtMs + 2,
      },
    )

    expect(stale).toEqual({ kind: "stale" })
    expect(winner).toMatchObject({ kind: "ready", sessionId: "cs_current" })
  })

  it("replays a current ready URL without granting another provider lease", async () => {
    const lease = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("ready")))
    await completeCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      {
        ...lease,
        sessionId: "cs_ready",
        url: "https://checkout.stripe.com/pay/cs_ready",
        nowMs: 2_000,
      },
    )

    const replay = await claimCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      candidate("retry", 3_000, { intentFingerprint: lease.intentFingerprint }),
    )

    expect(replay).toEqual({
      kind: "ready",
      sessionId: "cs_ready",
      url: "https://checkout.stripe.com/pay/cs_ready",
      stripeExpiresAtMs: lease.stripeExpiresAtMs,
    })
  })

  it("holds an expired Session through grace, then atomically replaces its intent and key", async () => {
    const first = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("old")))
    const duringGrace = await claimCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      candidate("grace", first.stripeExpiresAtMs, { intentFingerprint: "b".repeat(64) }),
    )
    expect(duringGrace).toMatchObject({ kind: "busy", reason: "expired_grace" })

    const replacementCandidate = candidate("new", first.replaceAfterMs, {
      intentFingerprint: "b".repeat(64),
    })
    const replacement = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, replacementCandidate))
    expect(replacement).toMatchObject({
      attemptId: replacementCandidate.attemptId,
      idempotencyKey: replacementCandidate.idempotencyKey,
      requestBody: replacementCandidate.requestBody,
      intentFingerprint: replacementCandidate.intentFingerprint,
      generation: first.generation + 1,
    })
  })

  it("fails closed when tenant liveness changes before claim or completion", async () => {
    const liveDb = await makeDb({ status: "active", billingSource: null })
    await expect(claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: liveDb }, candidate("blocked"))).resolves.toEqual({
      kind: "ineligible",
    })

    const lease = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("claimed")))
    await db
      .prepare(
        "UPDATE tenant SET subscription_status = 'trialing', billing_source = 'stripe' WHERE installation_id = ?",
      )
      .bind(INSTALLATION_ID)
      .run()
    await expect(
      completeCheckoutAttempt(
        { SIGILIX_PLATFORM_DB: db },
        {
          ...lease,
          sessionId: "cs_too_late",
          url: "https://checkout.stripe.com/pay/cs_too_late",
          nowMs: 2_000,
        },
      ),
    ).resolves.toEqual({ kind: "ineligible" })

    const replayDb = await makeDb()
    const readyLease = acquiredLease(
      await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: replayDb }, candidate("ready-then-live")),
    )
    await completeCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: replayDb },
      {
        ...readyLease,
        sessionId: "cs_ready_then_live",
        url: "https://checkout.stripe.com/pay/cs_ready_then_live",
        nowMs: 2_000,
      },
    )
    await replayDb
      .prepare("UPDATE tenant SET subscription_status = 'active', billing_source = 'stripe' WHERE installation_id = ?")
      .bind(INSTALLATION_ID)
      .run()
    await expect(
      claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: replayDb }, candidate("replay-after-live", 3_000)),
    ).resolves.toEqual({ kind: "ineligible" })
  })

  it("allows only the explicit legacy entitlement through an active-status claim", async () => {
    const legacyDb = await makeDb({ status: "active", billingSource: "legacy_entitlement" })
    const unknownDb = await makeDb({ status: "active", billingSource: "future_provider" })

    expect((await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: legacyDb }, candidate("legacy"))).kind).toBe("acquired")
    await expect(claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: unknownDb }, candidate("unknown"))).resolves.toEqual({
      kind: "ineligible",
    })
  })

  it("rejects completion at or after the persisted Stripe expiry", async () => {
    const lease = acquiredLease(await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("expired")))
    await expect(
      completeCheckoutAttempt(
        { SIGILIX_PLATFORM_DB: db },
        {
          ...lease,
          sessionId: "cs_expired",
          url: "https://checkout.stripe.com/pay/cs_expired",
          nowMs: lease.stripeExpiresAtMs,
        },
      ),
    ).resolves.toEqual({ kind: "stale" })
  })

  it("keeps attempt authority isolated by exact installation", async () => {
    await db
      .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (777, 'free', 't', 't')")
      .run()
    const first = await claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: db }, candidate("one"))
    const second = await claimCheckoutAttempt(
      { SIGILIX_PLATFORM_DB: db },
      candidate("two", 1_000, { installationId: 777 }),
    )

    expect(first.kind).toBe("acquired")
    expect(second.kind).toBe("acquired")
  })

  it("fails closed on missing persistence or invalid server-derived input", async () => {
    await expect(claimCheckoutAttempt({}, candidate("missing-db"))).resolves.toEqual({
      kind: "error",
      reason: "unavailable",
    })

    const unmigrated = makeD1()
    await unmigrated.exec(migration("0001_create_tenant_repo_usage.sql"))
    await expect(
      claimCheckoutAttempt({ SIGILIX_PLATFORM_DB: unmigrated }, candidate("missing-table")),
    ).resolves.toEqual({ kind: "error", reason: "unavailable" })

    await expect(
      claimCheckoutAttempt(
        { SIGILIX_PLATFORM_DB: db },
        candidate("invalid", 1_000, { intentFingerprint: "not-a-digest", requestBody: "" }),
      ),
    ).resolves.toEqual({ kind: "error", reason: "invalid_input" })
  })

  it("enforces creating and ready state shape at the schema boundary", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO stripe_checkout_attempt
            (installation_id, attempt_id, intent_fingerprint, request_body, idempotency_key,
             state, generation, lease_token, lease_expires_at_ms, stripe_expires_at_ms,
             replace_after_ms, stripe_session_id, checkout_url, created_at_ms, updated_at_ms,
             ready_at_ms)
           VALUES (?, 'invalid-ready', ?, 'mode=subscription', 'invalid-ready-key',
                   'ready', 1, NULL, NULL, 10000, 20000, NULL, NULL, 1, 2, 2)`,
        )
        .bind(INSTALLATION_ID, "f".repeat(64))
        .run(),
    ).rejects.toThrow()
  })
})
