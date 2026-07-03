// email-verification-store: single-use + expiry through the real D1 shim.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { consumeVerificationToken, mintVerificationToken } from "@/src/lib/email-verification-store"

const MIGRATION_0008 = readFileSync(
  new URL("../../migrations/0008_create_email_verification_token.sql", import.meta.url),
  "utf8",
)

describe("email-verification-store", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0008)
  })

  it("mints a token that consumes exactly once, returning the bound userId + email", async () => {
    const token = await mintVerificationToken(db, {
      userId: "u1",
      email: "a@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const first = await consumeVerificationToken(db, token, "2026-07-03T01:00:00.000Z")
    expect(first).toEqual({ ok: true, userId: "u1", email: "a@example.com" })

    // Second use of the SAME token fails closed (single-use).
    const second = await consumeVerificationToken(db, token, "2026-07-03T01:00:01.000Z")
    expect(second).toEqual({ ok: false, reason: "used" })
  })

  it("rejects an expired token (never consumes it)", async () => {
    const token = await mintVerificationToken(db, {
      userId: "u2",
      email: "b@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
      ttlHours: 24,
    })
    // 25h later → past the 24h expiry.
    const res = await consumeVerificationToken(db, token, "2026-07-04T01:00:00.000Z")
    expect(res).toEqual({ ok: false, reason: "expired" })
  })

  it("rejects an unknown / malformed token as not_found", async () => {
    expect(await consumeVerificationToken(db, "not-a-real-token", "2026-07-03T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "not_found",
    })
    expect(await consumeVerificationToken(db, "", "2026-07-03T00:00:00.000Z")).toEqual({
      ok: false,
      reason: "not_found",
    })
  })

  it("a resend invalidates the prior outstanding token (one live link per user)", async () => {
    const first = await mintVerificationToken(db, {
      userId: "u3",
      email: "c@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const second = await mintVerificationToken(db, {
      userId: "u3",
      email: "c@example.com",
      nowIso: "2026-07-03T00:05:00.000Z",
    })
    // The superseded first token is dead...
    expect(await consumeVerificationToken(db, first, "2026-07-03T00:10:00.000Z")).toEqual({
      ok: false,
      reason: "used",
    })
    // ...and the fresh token still works.
    expect(await consumeVerificationToken(db, second, "2026-07-03T00:10:00.000Z")).toEqual({
      ok: true,
      userId: "u3",
      email: "c@example.com",
    })
  })

  it("two concurrent consumes of the same token → exactly one succeeds", async () => {
    const token = await mintVerificationToken(db, {
      userId: "u4",
      email: "d@example.com",
      nowIso: "2026-07-03T00:00:00.000Z",
    })
    const [a, b] = await Promise.all([
      consumeVerificationToken(db, token, "2026-07-03T00:01:00.000Z"),
      consumeVerificationToken(db, token, "2026-07-03T00:01:00.000Z"),
    ])
    const successes = [a, b].filter((r) => r.ok)
    expect(successes).toHaveLength(1)
  })
})
