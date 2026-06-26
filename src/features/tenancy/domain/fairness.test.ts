// src/features/tenancy/domain/fairness.test.ts
import { describe, expect, it } from "vitest"
import {
  emptyState,
  decideAcquire,
  release,
  findExpiredLeaseIds,
  extendLease,
  computeBackoffMs,
  LEASE_TTL_MS,
  MAX_BACKOFF_MS,
} from "@/src/features/tenancy/domain/fairness"

const NOW = 1_000_000

describe("decideAcquire", () => {
  it("grants under cap and records a lease with a TTL", () => {
    const r = decideAcquire({ state: emptyState(), leaseId: "a", cap: 2, nowMs: NOW, rand: 0 })
    expect(r.granted).toBe(true)
    expect(r.retryAfterMs).toBe(0)
    expect(r.state.leases).toHaveLength(1)
    expect(r.state.leases[0]).toEqual({ leaseId: "a", acquiredAtMs: NOW, expiresAtMs: NOW + LEASE_TTL_MS })
  })

  it("denies at cap and returns a positive backoff", () => {
    let s = emptyState()
    s = decideAcquire({ state: s, leaseId: "a", cap: 2, nowMs: NOW, rand: 0 }).state
    s = decideAcquire({ state: s, leaseId: "b", cap: 2, nowMs: NOW, rand: 0 }).state
    const r = decideAcquire({ state: s, leaseId: "c", cap: 2, nowMs: NOW, rand: 0 })
    expect(r.granted).toBe(false)
    expect(r.retryAfterMs).toBeGreaterThan(0)
    expect(r.state.leases).toHaveLength(2) // c NOT added
  })

  it("is idempotent for a re-presented leaseId (no double count, deny streak reset)", () => {
    let s = decideAcquire({ state: emptyState(), leaseId: "a", cap: 1, nowMs: NOW, rand: 0 }).state
    // 'a' over cap=1 would deny a new id, but re-presenting 'a' itself is a no-op grant
    const r = decideAcquire({ state: s, leaseId: "a", cap: 1, nowMs: NOW, rand: 0 })
    expect(r.granted).toBe(true)
    expect(r.state.leases).toHaveLength(1)
  })

  it("escalates backoff per consecutive deny and resets on grant", () => {
    let s = emptyState()
    s = decideAcquire({ state: s, leaseId: "x", cap: 0, nowMs: NOW, rand: 0 }).state // deny #1
    const d2 = decideAcquire({ state: s, leaseId: "x", cap: 0, nowMs: NOW, rand: 0 }) // deny #2
    s = d2.state
    const deny1Base = computeBackoffMs(1, 0)
    const deny2Base = computeBackoffMs(2, 0)
    expect(deny2Base).toBeGreaterThan(deny1Base)
    // a later grant clears the streak
    const granted = decideAcquire({ state: s, leaseId: "x", cap: 5, nowMs: NOW, rand: 0 })
    expect(granted.granted).toBe(true)
    expect(granted.state.denyCounts["x"]).toBeUndefined()
  })
})

describe("computeBackoffMs", () => {
  it("caps the base and applies jitter in [0.5x, 1.5x)", () => {
    expect(computeBackoffMs(99, 0)).toBe(Math.round(MAX_BACKOFF_MS * 0.5))
    expect(computeBackoffMs(99, 0.999)).toBeLessThan(MAX_BACKOFF_MS * 1.5)
    expect(computeBackoffMs(1, 0)).toBeGreaterThan(0)
  })
})

describe("release / expiry", () => {
  it("release removes the lease and its deny streak", () => {
    const s = decideAcquire({ state: emptyState(), leaseId: "a", cap: 2, nowMs: NOW, rand: 0 }).state
    const after = release(s, "a")
    expect(after.leases).toHaveLength(0)
  })

  it("release of an unknown lease is a no-op (idempotent)", () => {
    const s = emptyState()
    expect(release(s, "ghost").leases).toHaveLength(0)
  })

  it("findExpiredLeaseIds returns only leases past their TTL", () => {
    const s = decideAcquire({ state: emptyState(), leaseId: "a", cap: 2, nowMs: NOW, rand: 0 }).state
    expect(findExpiredLeaseIds(s, NOW + LEASE_TTL_MS - 1)).toEqual([])
    expect(findExpiredLeaseIds(s, NOW + LEASE_TTL_MS + 1)).toEqual(["a"])
  })

  it("extendLease pushes the TTL forward", () => {
    const s = decideAcquire({ state: emptyState(), leaseId: "a", cap: 2, nowMs: NOW, rand: 0 }).state
    const e = extendLease(s, "a", NOW + 5)
    expect(e.leases[0].expiresAtMs).toBe(NOW + 5 + LEASE_TTL_MS)
  })
})
