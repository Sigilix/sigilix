// src/features/tenancy/domain/fairness.ts
// Pure per-tenant concurrency math. No Env, no IO, no clock, no Math.random —
// the DO injects `nowMs` and `rand` so this is fully deterministic to test.

export const LEASE_TTL_MS = 35 * 60 * 1000 // > the MAX configured PrReviewRunDO watchdog (clamp permits 30m, src/do/config.ts) so an expired lease is a provably-dead run
export const DEFAULT_TENANT_CAP = 2
export const BASE_BACKOFF_MS = 15_000
export const MAX_BACKOFF_MS = 240_000
export const MAX_DEFERS = 20 // anti-starvation cap: beyond this the consumer bypasses admission

export interface Lease {
  leaseId: string
  acquiredAtMs: number
  expiresAtMs: number
}

export interface FairnessState {
  schemaVersion: 1
  leases: Lease[]
  denyCounts: Record<string, number>
}

export function emptyState(): FairnessState {
  return { schemaVersion: 1, leases: [], denyCounts: {} }
}

export interface AcquireArgs {
  state: FairnessState
  leaseId: string
  cap: number
  nowMs: number
  rand: number // [0,1) injected by the caller
}

export interface AcquireResult {
  granted: boolean
  state: FairnessState
  retryAfterMs: number
}

/** Exponential base (capped) with decorrelated jitter in [0.5x, 1.5x). denyCount starts at 1. */
export function computeBackoffMs(denyCount: number, rand: number): number {
  const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.max(0, denyCount - 1)), MAX_BACKOFF_MS)
  return Math.round(exp * (0.5 + rand))
}

export function decideAcquire(args: AcquireArgs): AcquireResult {
  const { state, leaseId, cap, nowMs, rand } = args
  // Idempotent: a re-presented lease (queue redelivery) is already counted.
  if (state.leases.some((l) => l.leaseId === leaseId)) {
    const denyCounts = { ...state.denyCounts }
    delete denyCounts[leaseId]
    return { granted: true, retryAfterMs: 0, state: { ...state, denyCounts } }
  }
  if (state.leases.length >= cap) {
    const next = (state.denyCounts[leaseId] ?? 0) + 1
    return {
      granted: false,
      retryAfterMs: computeBackoffMs(next, rand),
      state: { ...state, denyCounts: { ...state.denyCounts, [leaseId]: next } },
    }
  }
  const denyCounts = { ...state.denyCounts }
  delete denyCounts[leaseId]
  return {
    granted: true,
    retryAfterMs: 0,
    state: {
      ...state,
      leases: [...state.leases, { leaseId, acquiredAtMs: nowMs, expiresAtMs: nowMs + LEASE_TTL_MS }],
      denyCounts,
    },
  }
}

export function release(state: FairnessState, leaseId: string): FairnessState {
  const denyCounts = { ...state.denyCounts }
  delete denyCounts[leaseId]
  return { ...state, leases: state.leases.filter((l) => l.leaseId !== leaseId), denyCounts }
}

export function findExpiredLeaseIds(state: FairnessState, nowMs: number): string[] {
  return state.leases.filter((l) => nowMs > l.expiresAtMs).map((l) => l.leaseId)
}

export function extendLease(state: FairnessState, leaseId: string, nowMs: number): FairnessState {
  return {
    ...state,
    leases: state.leases.map((l) => (l.leaseId === leaseId ? { ...l, expiresAtMs: nowMs + LEASE_TTL_MS } : l)),
  }
}
