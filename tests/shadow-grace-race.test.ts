// tests/shadow-grace-race.test.ts
//
// ARC-283 Phase B1b review pass — exercises the shadow-tail grace race
// helper that caps how long `handlePrReviewEnsemble`'s finally block
// can wait on a shadow promise before emitting `shadow-cut-short` and
// moving on. Pure unit-level: the helper has no env / I/O surface, so
// we don't need to spin up the full orchestrator.
import { describe, expect, it } from "vitest"

import {
  raceWithShadowGrace,
  SHADOW_GRACE_EXPIRED,
  SHADOW_FINALIZE_GRACE_MS,
} from "../src/lib/triage-pr-review-ensemble"

describe("raceWithShadowGrace", () => {
  it("resolves to the underlying promise value when it settles before the deadline", async () => {
    const deadline = Date.now() + 1_000
    const result = await raceWithShadowGrace(
      Promise.resolve({ ok: true }),
      deadline,
      new AbortController().signal,
    )
    expect(result).toEqual({ ok: true })
  })

  it("resolves to SHADOW_GRACE_EXPIRED when the deadline fires before the promise settles", async () => {
    const deadline = Date.now() + 20 // 20ms grace
    const neverSettles = new Promise<unknown>(() => undefined)
    const result = await raceWithShadowGrace(
      neverSettles,
      deadline,
      new AbortController().signal,
    )
    expect(result).toBe(SHADOW_GRACE_EXPIRED)
  })

  it("returns SHADOW_GRACE_EXPIRED synchronously when the signal is already aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const neverSettles = new Promise<unknown>(() => undefined)
    const result = await raceWithShadowGrace(
      neverSettles,
      Date.now() + 60_000,
      ac.signal,
    )
    expect(result).toBe(SHADOW_GRACE_EXPIRED)
  })

  it("returns SHADOW_GRACE_EXPIRED when the signal aborts mid-race", async () => {
    const ac = new AbortController()
    const neverSettles = new Promise<unknown>(() => undefined)
    setTimeout(() => ac.abort(), 10)
    const result = await raceWithShadowGrace(
      neverSettles,
      Date.now() + 60_000,
      ac.signal,
    )
    expect(result).toBe(SHADOW_GRACE_EXPIRED)
  })

  it("treats a rejected promise as expired (defensive — shadow runners catch internally)", async () => {
    const result = await raceWithShadowGrace(
      Promise.reject(new Error("shadow crashed")),
      Date.now() + 1_000,
      new AbortController().signal,
    )
    expect(result).toBe(SHADOW_GRACE_EXPIRED)
  })
})

describe("SHADOW_FINALIZE_GRACE_MS budget invariant", () => {
  it("is small enough that ORCHESTRATOR_TIMEOUT + SHADOW_GRACE stays inside the CF Queues 900s ceiling", () => {
    // 5_000ms is the value chosen at module load — bump this expectation
    // if the budget changes, but never silently raise it past
    // (CF_QUEUE_CONSUMER_CEILING_MS - ORCHESTRATOR_TIMEOUT_MS).
    expect(SHADOW_FINALIZE_GRACE_MS).toBeGreaterThan(0)
    expect(SHADOW_FINALIZE_GRACE_MS).toBeLessThanOrEqual(5_000)
  })
})
