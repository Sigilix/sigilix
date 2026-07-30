// The history-ingest lease, through the real migration and a SQLite shim.
//
// This lease is the reason history ingestion cannot repeat the $85 incident OR the
// PR-backfill guard's permanent-loss bug. The load-bearing behaviours: atomic winner
// election, RESUME-from-cursor on takeover, fenced writes, and expire-keeps-cursor.

import { describe, it, expect, beforeEach } from "vitest"
import type { D1Database } from "@cloudflare/workers-types"
import { readFileSync } from "node:fs"

import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import {
  claimHistoryLease,
  advanceHistoryLease,
  expireHistoryLease,
  completeHistoryLease,
  renewHistoryLease,
  HISTORY_LEASE_MS,
} from "@/src/lib/history-ingest-lease"

const MIGRATION_SQL = readFileSync(
  new URL("../../migrations/0039_create_history_ingest_lease.sql", import.meta.url),
  "utf8",
)

const R = { owner: "Acme", repo: "Site", installationId: 7 }
const T0 = 1_000_000

describe("claimHistoryLease", () => {
  let db: D1Database
  const env = () => ({ SIGILIX_PLATFORM_DB: db })
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("fresh claim wins with cursor 0", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    expect(c.ok).toBe(true)
    if (!c.ok) return
    expect(c.cursor).toBe(0)
    expect(c.leaseToken).toMatch(/[0-9a-f-]{36}/)
  })

  it("a LIVE lease denies a second claimant (redelivery / duplicate enqueue)", async () => {
    await claimHistoryLease(env(), { ...R, nowMs: T0 })
    const second = await claimHistoryLease(env(), { ...R, nowMs: T0 + 60_000 })
    expect(second).toEqual({ ok: false, reason: "in-flight" })
  })

  it("an EXPIRED lease is taken over and RESUMES the dead shard's cursor", async () => {
    // The run-until-complete contract: a dead shard's progress is never thrown away.
    const first = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!first.ok) throw new Error("setup")
    await advanceHistoryLease(env(), {
      ...R,
      leaseToken: first.leaseToken,
      cursor: 50,
      docsDone: 400,
      nowMs: T0 + 1000,
    })

    const after = T0 + 1000 + HISTORY_LEASE_MS + 1000
    const takeover = await claimHistoryLease(env(), { ...R, nowMs: after })
    expect(takeover.ok).toBe(true)
    if (!takeover.ok) return
    expect(takeover.cursor).toBe(50) // RESUME, not restart
    expect(takeover.docsDone).toBe(400)
    expect(takeover.leaseToken).not.toBe(first.leaseToken)
  })

  it("a COMPLETE run denies re-claim (the once-ever contract)", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    await completeHistoryLease(env(), { ...R, leaseToken: c.leaseToken, docsDone: 10, nowMs: T0 + 5 })
    expect(await claimHistoryLease(env(), { ...R, nowMs: T0 + 10 })).toEqual({ ok: false, reason: "already-complete" })
  })

  it("an embedding-model migration RESTARTS a complete run from cursor 0", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    await completeHistoryLease(env(), { ...R, leaseToken: c.leaseToken, docsDone: 10, nowMs: T0 + 5 })
    // Simulate the stored run having used a different model.
    await db.prepare("UPDATE history_ingest_lease SET model_id = 'old/model', embedding_dim = 384").run()

    const migrated = await claimHistoryLease(env(), { ...R, nowMs: T0 + 10 })
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.cursor).toBe(0) // restart — old vectors are not interchangeable
  })

  it("force re-claims a complete run", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    await completeHistoryLease(env(), { ...R, leaseToken: c.leaseToken, docsDone: 10, nowMs: T0 + 5 })
    const forced = await claimHistoryLease(env(), { ...R, nowMs: T0 + 10, force: true })
    expect(forced.ok).toBe(true)
    if (!forced.ok) return
    expect(forced.cursor).toBe(0)
  })

  it("is case-insensitive on owner/repo", async () => {
    await claimHistoryLease(env(), { ...R, nowMs: T0 })
    expect((await claimHistoryLease(env(), { owner: "ACME", repo: "site", installationId: 7, nowMs: T0 + 1 })).ok).toBe(
      false,
    )
  })

  it("THROWS when D1 is unbound — an unreadable coordinator must stall, not spend", async () => {
    await expect(claimHistoryLease({}, { ...R, nowMs: T0 })).rejects.toThrow(/not bound/)
  })
})

describe("advance / expire / complete — fencing", () => {
  let db: D1Database
  const env = () => ({ SIGILIX_PLATFORM_DB: db })
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("advance persists cursor + renews; a WRONG token is rejected (lost lease)", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    const adv = await advanceHistoryLease(env(), {
      ...R,
      leaseToken: c.leaseToken,
      cursor: 25,
      docsDone: 200,
      nowMs: T0 + 100,
    })
    expect(adv.ok).toBe(true)
    // A usurped predecessor must not clobber the successor.
    expect(
      (await advanceHistoryLease(env(), { ...R, leaseToken: "stale-token", cursor: 999, docsDone: 1, nowMs: T0 + 200 }))
        .ok,
    ).toBe(false)
  })

  it("expire KEEPS the cursor so the immediate retry resumes — the permanent-loss fix", async () => {
    // Without this, a shard failure + instant queue retry sees a live lease, acks,
    // and the run is lost forever (the PR-backfill guard's exact bug, adapted).
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    const adv = await advanceHistoryLease(env(), {
      ...R,
      leaseToken: c.leaseToken,
      cursor: 75,
      docsDone: 600,
      nowMs: T0 + 100,
    })
    if (!adv.ok) throw new Error("setup")
    await expireHistoryLease(env(), { ...R, leaseToken: adv.nextToken })

    // The retry, SECONDS later (not 10 minutes), can claim — and resumes at 75.
    const retry = await claimHistoryLease(env(), { ...R, nowMs: T0 + 200 })
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.cursor).toBe(75)
  })

  it("a stale expire cannot kill the successor's live lease", async () => {
    const first = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!first.ok) throw new Error("setup")
    await expireHistoryLease(env(), { ...R, leaseToken: first.leaseToken })
    const second = await claimHistoryLease(env(), { ...R, nowMs: T0 + 10 })
    if (!second.ok) throw new Error("setup")
    // First shard's dying breath fires again — fenced out.
    await expireHistoryLease(env(), { ...R, leaseToken: first.leaseToken })
    expect(await claimHistoryLease(env(), { ...R, nowMs: T0 + 20 })).toEqual({ ok: false, reason: "in-flight" })
  })

  it("complete is fenced too", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    expect(await completeHistoryLease(env(), { ...R, leaseToken: "wrong", docsDone: 1, nowMs: T0 + 5 })).toBe(false)
    expect(await completeHistoryLease(env(), { ...R, leaseToken: c.leaseToken, docsDone: 1, nowMs: T0 + 5 })).toBe(true)
  })
})

describe("token rotation — the continuation-fork fix", () => {
  let db: D1Database
  const env = () => ({ SIGILIX_PLATFORM_DB: db })
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  it("advance ROTATES the token, so a redelivered continuation (old token) is fenced out", async () => {
    // Queues are at-least-once: without rotation, a duplicate continuation renews
    // the SAME live token, reprocesses the shard, and enqueues a second
    // continuation — forking the chain into ~2× embed spend for the whole run.
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    const adv = await advanceHistoryLease(env(), {
      ...R,
      leaseToken: c.leaseToken,
      cursor: 25,
      docsDone: 50,
      nowMs: T0 + 100,
    })
    if (!adv.ok) throw new Error("setup")
    expect(adv.nextToken).not.toBe(c.leaseToken)

    // The duplicate delivery carries the OLD token — its renew must fail...
    expect((await renewHistoryLease(env(), { ...R, leaseToken: c.leaseToken, nowMs: T0 + 200 })).ok).toBe(false)
    // ...while the legitimate continuation (new token) renews fine.
    const renewed = await renewHistoryLease(env(), { ...R, leaseToken: adv.nextToken, nowMs: T0 + 200 })
    expect(renewed.ok).toBe(true)
    if (!renewed.ok) return
    expect(renewed.cursor).toBe(25)
  })

  it("force does NOT usurp a LIVE run — in-flight progress is never discarded", async () => {
    const c = await claimHistoryLease(env(), { ...R, nowMs: T0 })
    if (!c.ok) throw new Error("setup")
    await advanceHistoryLease(env(), { ...R, leaseToken: c.leaseToken, cursor: 25, docsDone: 50, nowMs: T0 + 100 })
    // A force enqueue lands while the run is live: denied, run untouched.
    expect(await claimHistoryLease(env(), { ...R, nowMs: T0 + 200, force: true })).toEqual({
      ok: false,
      reason: "in-flight",
    })
    // Once complete, force works (the documented operator re-index path).
    const row = await db.prepare("SELECT lease_token FROM history_ingest_lease").first<{ lease_token: string }>()
    await completeHistoryLease(env(), { ...R, leaseToken: row!.lease_token, docsDone: 50, nowMs: T0 + 300 })
    expect((await claimHistoryLease(env(), { ...R, nowMs: T0 + 400, force: true })).ok).toBe(true)
  })
})
