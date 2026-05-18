// tests/shadow-grace-race.test.ts
//
// ARC-283 Phase B1b review pass — exercises the shadow-tail grace race
// helper that caps how long `handlePrReviewEnsemble`'s finally block
// can wait on a shadow promise before emitting `shadow-cut-short` and
// moving on. Pure unit-level: the helper has no env / I/O surface, so
// we don't need to spin up the full orchestrator.
import { describe, expect, it } from "vitest"

import {
  composeSignals,
  isShadowRunFailed,
  raceWithShadowGrace,
  SHADOW_GRACE_EXPIRED,
  SHADOW_RUN_FAILED,
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

  // ARC-283 Phase B1b CR-1: rejection used to collapse to
  // SHADOW_GRACE_EXPIRED, which made the finally block emit
  // `shadow-cut-short` on a runner crash — hiding real failure
  // signal in the cut-short bucket. The race now resolves to the
  // FAILED sentinel-wrapper so the consumer can emit the dedicated
  // `shadow-run-failed` event.
  it("resolves to a SHADOW_RUN_FAILED wrapper (NOT SHADOW_GRACE_EXPIRED) when the shadow promise rejects", async () => {
    const result = await raceWithShadowGrace(
      Promise.reject(new Error("shadow crashed")),
      Date.now() + 1_000,
      new AbortController().signal,
    )
    expect(result).not.toBe(SHADOW_GRACE_EXPIRED)
    expect(isShadowRunFailed(result)).toBe(true)
    if (isShadowRunFailed(result)) {
      expect(result.__shadowRunFailed).toBe(SHADOW_RUN_FAILED)
      expect(result.message).toBe("shadow crashed")
    }
  })

  it("stringifies a non-Error rejection into the FAILED wrapper's message field", async () => {
    const result = await raceWithShadowGrace(
      Promise.reject("plain-string failure"),
      Date.now() + 1_000,
      new AbortController().signal,
    )
    expect(isShadowRunFailed(result)).toBe(true)
    if (isShadowRunFailed(result)) {
      expect(result.message).toBe("plain-string failure")
    }
  })
})

describe("composeSignals", () => {
  it("aborts when any input signal aborts", () => {
    const a = new AbortController()
    const b = new AbortController()
    const composed = composeSignals(a.signal, b.signal)
    expect(composed.aborted).toBe(false)
    a.abort("test-reason")
    expect(composed.aborted).toBe(true)
  })

  it("returns an already-aborted signal when any input is pre-aborted", () => {
    const a = new AbortController()
    a.abort("pre-aborted")
    const b = new AbortController()
    const composed = composeSignals(a.signal, b.signal)
    expect(composed.aborted).toBe(true)
  })
})

describe("ARC-283 Phase B1b CR-2: aborting in-flight shadows when the grace expires", () => {
  // Models the orchestrator's per-shadow AbortController. The
  // finally block detects SHADOW_GRACE_EXPIRED and calls .abort(reason)
  // on the controller; we assert the call lands so the underlying HTTP
  // request stops consuming provider capacity.
  it("calling .abort('grace_deadline') on the per-shadow controller fires the composed signal", async () => {
    const orchCtrl = new AbortController()
    const shadowCtrl = new AbortController()
    const composed = composeSignals(orchCtrl.signal, shadowCtrl.signal)
    expect(composed.aborted).toBe(false)
    shadowCtrl.abort("grace_deadline")
    expect(composed.aborted).toBe(true)
  })

  it("a never-settling shadow surfaces SHADOW_GRACE_EXPIRED and the consumer can abort its controller", async () => {
    const orchCtrl = new AbortController()
    const shadowCtrl = new AbortController()
    const composed = composeSignals(orchCtrl.signal, shadowCtrl.signal)
    // Promise that respects the composed signal — emulates the real
    // shadow runner's behavior, which aborts the underlying fetch on
    // abort. Resolves to a sentinel string when the signal aborts so
    // we can confirm the cancellation propagated all the way through.
    const shadowPromise = new Promise<string>((resolve) => {
      composed.addEventListener("abort", () => resolve("shadow-cancelled"), { once: true })
    })

    // Simulate the finally block's behavior: race against a 20ms grace
    // deadline; on SHADOW_GRACE_EXPIRED, abort the shadow controller.
    const race = raceWithShadowGrace(shadowPromise, Date.now() + 20, orchCtrl.signal)
    const winner = await race
    expect(winner).toBe(SHADOW_GRACE_EXPIRED)

    // Now mimic the finally consumer: abort the per-shadow controller.
    expect(shadowCtrl.signal.aborted).toBe(false)
    shadowCtrl.abort("grace_deadline")
    expect(shadowCtrl.signal.aborted).toBe(true)
    // The underlying shadow promise should now resolve (because the
    // composed signal it listens on has aborted), proving the
    // cancellation reached the in-flight request.
    expect(await shadowPromise).toBe("shadow-cancelled")
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
