# PR A — Tenant Fairness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a single tenant's PR burst from starving or degrading other tenants' reviews, by gating ensemble admission through a per-tenant concurrency semaphore — wired identically into the webhook queue path and the hosted `/v1/review` CLI path.

**Architecture:** A new `TenantConcurrencyDO` (one instance per tenant, keyed `tenant:<id>`) holds in-flight **leases** with a cap. A pure `domain/fairness.ts` owns all the acquire/release/backoff/lease math (unit-tested with an injected clock + rand). A thin `admitTenant()` client is called at two sites: the queue consumer (`src/index.ts queue()`, before `dispatchJob`) and the `/v1/review` route. On the async webhook path a denial re-arms the per-PR DO via a new `PrReviewRunDO./defer` route (which re-sends a fresh job — **never** `message.retry()`); on the sync `/v1/review` path a denial returns `429 + Retry-After`. Everything **fails open**: any fault GRANTs. No D1 in this PR.

**Tech Stack:** TypeScript (strict), Cloudflare Workers + Durable Objects, Cloudflare Queues, vitest with the repo's DO/SQLite test shims.

## Global Constraints

- Clean architecture (COMPLIANCE.md): imports point inward only; `domain/` is pure (no `Env`/IO/clock); features imported via their barrel `index.ts`; every cross-dir import is `@/...`; ≤1000 lines/file.
- **Fail-open:** any error in `admitTenant()` or `/defer` → proceed (GRANT). A review is never blocked or dropped by this feature.
- **Re-send, never `message.retry()`** on a fairness denial (retry burns `max_retries=3` → Cloudflare drops the review).
- **Recall-safety:** a deferred/denied review must never read as a clean pass; it is re-queued or 429'd, never silently dropped.
- Shadow-first: `SIGILIX_FAIRNESS_MODE` defaults to `shadow` (measure, always proceed). `enforce` honors denials.
- **No D1** in PR A. Per-tenant cap comes from `SIGILIX_TENANT_CONCURRENCY_CAP` env (default 2).
- Migrations forward-only (COMPLIANCE.md §8): the new DO gets a sequential `[[migrations]]` tag and is exported from `src/index.ts`.
- `npm run build` green (tsc + eslint + vitest); run `npx prettier --write` on every touched non-`*.md` file before committing.
- Don't rename `OPENCLAW_*` vars; new flags use the `SIGILIX_` prefix (matches the spec).
- Spec of record: `docs/superpowers/specs/2026-06-25-multi-tenant-fairness-design.md` (SIG-455).

---

## File Structure

| Path | Responsibility | New/Modified |
|------|----------------|--------------|
| `src/features/tenancy/domain/fairness.ts` | Pure acquire/release/backoff/lease math | Create |
| `src/features/tenancy/domain/fairness.test.ts` | Unit tests for the pure logic | Create |
| `src/features/tenancy/adapters/concurrency-client.ts` | `admitTenant()` / `releaseTenant()` over the DO (fail-open) | Create |
| `src/features/tenancy/adapters/concurrency-client.test.ts` | Client tests incl. fail-open | Create |
| `src/features/tenancy/index.ts` | Barrel (public surface) | Create |
| `src/do/tenant-concurrency.ts` | `TenantConcurrencyDO` (thin; delegates to domain) | Create |
| `src/do/tenant-concurrency.test.ts` | DO route + reaper tests | Create |
| `src/shared/types/env.ts` | Add `TENANT_CONCURRENCY` binding + 2 flags | Modify |
| `src/shared/types/job.ts` | Add optional `deferCount` to the `pr-review` JobMessage | Modify |
| `wrangler.toml` | DO binding + migration tag (appended **last**); flag vars. **No `[[queues.consumers]]` block** (CF 11004) | Modify |
| `src/do/pr-review-run-defer.ts` | Extracted `/defer` + defer-alarm logic (keeps `pr-review-run.ts` ≤1000 lines) | Create |
| `src/index.ts` | Export the DO; admission in `queue()` | Modify |
| `src/do/pr-review-run.ts` | New `/defer` route + `handleDeferAlarm` | Modify |
| `src/lib/api-review-route.ts` | Admission in `/v1/review` (keep daily ceiling) | Modify |

---

## Task 1: Pure fairness domain logic

**Files:**
- Create: `src/features/tenancy/domain/fairness.ts`
- Test: `src/features/tenancy/domain/fairness.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `FairnessState`, `emptyState()`, `decideAcquire(args)→{granted,state,retryAfterMs}`, `release(state,leaseId)→state`, `findExpiredLeaseIds(state,nowMs)→string[]`, `extendLease(state,leaseId,nowMs)→state`, `computeBackoffMs(denyCount,rand)→number`, and the constants `LEASE_TTL_MS`, `DEFAULT_TENANT_CAP`, `BASE_BACKOFF_MS`, `MAX_BACKOFF_MS`, `MAX_DEFERS`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/features/tenancy/domain/fairness.test.ts`
Expected: FAIL — cannot resolve `@/src/features/tenancy/domain/fairness`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/features/tenancy/domain/fairness.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/features/tenancy/domain/fairness.ts src/features/tenancy/domain/fairness.test.ts
git add src/features/tenancy/domain/fairness.ts src/features/tenancy/domain/fairness.test.ts
git commit -m "feat(SIG-455): pure per-tenant fairness domain (lease semaphore + jittered backoff)"
```

---

## Task 2: TenantConcurrencyDO

**Files:**
- Create: `src/do/tenant-concurrency.ts`
- Test: `src/do/tenant-concurrency.test.ts`

**Interfaces:**
- Consumes: Task 1's `domain/fairness.ts`.
- Produces: a DO with routes `POST /acquire` (`{leaseId, cap}` → `{granted, retryAfterMs}`), `POST /release` (`{leaseId}` → `{ok:true}`), and an `alarm()` reaper. Storage key `"fairness"`.

**Reaper note:** the reaper reclaims expired leases on **TTL alone**. `LEASE_TTL_MS` (35m) exceeds the **maximum configured** per-PR DO watchdog (the clamp permits up to 30m — `src/do/config.ts`), so an expired lease provably belongs to a run that's already terminal — no `/status` round-trip needed. (Codex flagged the original "25m > 20m" premise as stale; 35m > 30m-max is the correct margin. If the watchdog clamp is ever raised, raise this TTL too, or switch to the spec's `/status` reconciliation.)

- [ ] **Step 1: Write the failing test**

```ts
// src/do/tenant-concurrency.test.ts
import { describe, it, expect } from "vitest"
import { TenantConcurrencyDO } from "@/src/do/tenant-concurrency"
import type { Env } from "@/src/shared/types/env"

function makeState() {
  const store = new Map<string, unknown>()
  let alarmAt: number | null = null
  const ctx = {
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
      setAlarm: async (t: number) => void (alarmAt = t),
      getAlarm: async () => alarmAt,
      deleteAlarm: async () => void (alarmAt = null),
    },
    id: { toString: () => "tenant:42" },
  }
  return { ctx, getAlarm: () => alarmAt }
}

function post(path: string, body: unknown): Request {
  return new Request(`https://do.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("TenantConcurrencyDO", () => {
  it("grants up to cap, then denies with a backoff", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    const a = await (await do_.fetch(post("/acquire", { leaseId: "a", cap: 2 }))).json()
    const b = await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 2 }))).json()
    const c = await (await do_.fetch(post("/acquire", { leaseId: "c", cap: 2 }))).json()
    expect(a.granted).toBe(true)
    expect(b.granted).toBe(true)
    expect(c.granted).toBe(false)
    expect(c.retryAfterMs).toBeGreaterThan(0)
  })

  it("release frees a slot", async () => {
    const { ctx } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/acquire", { leaseId: "a", cap: 1 }))
    const denied = await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 1 }))).json()
    expect(denied.granted).toBe(false)
    await do_.fetch(post("/release", { leaseId: "a" }))
    const granted = await (await do_.fetch(post("/acquire", { leaseId: "b", cap: 1 }))).json()
    expect(granted.granted).toBe(true)
  })

  it("arms a reaper alarm while leases are held", async () => {
    const { ctx, getAlarm } = makeState()
    const do_ = new TenantConcurrencyDO(ctx as unknown as DurableObjectState, {} as Env)
    await do_.fetch(post("/acquire", { leaseId: "a", cap: 2 }))
    expect(getAlarm()).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/do/tenant-concurrency.test.ts`
Expected: FAIL — `TenantConcurrencyDO` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/do/tenant-concurrency.ts
import { DurableObject } from "cloudflare:workers"
import type { Env } from "@/src/shared/types/env"
import {
  emptyState,
  decideAcquire,
  release,
  findExpiredLeaseIds,
  type FairnessState,
} from "@/src/features/tenancy"

const STATE_KEY = "fairness"
const REAP_INTERVAL_MS = 60_000

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export class TenantConcurrencyDO extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/acquire") return this.handleAcquire(request)
    if (request.method === "POST" && url.pathname === "/release") return this.handleRelease(request)
    return json(404, { error: "unknown route" })
  }

  private async load(): Promise<FairnessState> {
    return (await this.ctx.storage.get<FairnessState>(STATE_KEY)) ?? emptyState()
  }

  private async handleAcquire(request: Request): Promise<Response> {
    const { leaseId, cap } = (await request.json()) as { leaseId: string; cap: number }
    const result = decideAcquire({ state: await this.load(), leaseId, cap, nowMs: Date.now(), rand: Math.random() })
    await this.ctx.storage.put(STATE_KEY, result.state)
    if (result.state.leases.length > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REAP_INTERVAL_MS)
    }
    return json(200, { granted: result.granted, retryAfterMs: result.retryAfterMs })
  }

  private async handleRelease(request: Request): Promise<Response> {
    const { leaseId } = (await request.json()) as { leaseId: string }
    await this.ctx.storage.put(STATE_KEY, release(await this.load(), leaseId))
    return json(200, { ok: true })
  }

  override async alarm(): Promise<void> {
    let state = await this.load()
    for (const leaseId of findExpiredLeaseIds(state, Date.now())) {
      state = release(state, leaseId)
      console.log(JSON.stringify({ event: "fairness-lease-reclaimed", leaseId, tenant: this.ctx.id.toString() }))
    }
    await this.ctx.storage.put(STATE_KEY, state)
    if (state.leases.length > 0) await this.ctx.storage.setAlarm(Date.now() + REAP_INTERVAL_MS)
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/do/tenant-concurrency.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/do/tenant-concurrency.ts src/do/tenant-concurrency.test.ts
git add src/do/tenant-concurrency.ts src/do/tenant-concurrency.test.ts
git commit -m "feat(SIG-455): TenantConcurrencyDO (per-tenant lease semaphore + TTL reaper)"
```

---

## Task 3: Bindings, flags, barrel, DO export

**Files:**
- Modify: `src/shared/types/env.ts`, `src/shared/types/job.ts`, `wrangler.toml`, `src/index.ts`
- Create: `src/features/tenancy/index.ts`

**Interfaces:**
- Produces: the `TENANT_CONCURRENCY` DO binding on `Env`; `SIGILIX_FAIRNESS_MODE` + `SIGILIX_TENANT_CONCURRENCY_CAP` env flags; optional `deferCount` on the `pr-review` `JobMessage`; the `@/src/features/tenancy` barrel.

- [ ] **Step 1: Create the barrel**

```ts
// src/features/tenancy/index.ts
export {
  emptyState,
  decideAcquire,
  release,
  findExpiredLeaseIds,
  extendLease,
  computeBackoffMs,
  LEASE_TTL_MS,
  DEFAULT_TENANT_CAP,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_DEFERS,
  type FairnessState,
  type Lease,
  type AcquireResult,
} from "./domain/fairness"
export { admitTenant, releaseTenant, type AdmitResult } from "./adapters/concurrency-client"
```

- [ ] **Step 2: Add the Env binding + flags**

In `src/shared/types/env.ts`, in the Durable Object group add:
```ts
  TENANT_CONCURRENCY: DurableObjectNamespace
```
and in the feature-flag group add:
```ts
  SIGILIX_FAIRNESS_MODE?: string // "off" | "shadow" | "enforce" (default "shadow")
  SIGILIX_TENANT_CONCURRENCY_CAP?: string // integer, default 2
```

- [ ] **Step 3: Add `deferCount` to the pr-review JobMessage**

In `src/shared/types/job.ts`, on the `pr-review` variant add (next to `attempt?`):
```ts
  /** SIG-455: number of fairness defers so far. The consumer bypasses admission once this hits MAX_DEFERS (anti-starvation). */
  deferCount?: number
```

- [ ] **Step 4: Export the DO + add wrangler binding/migration + pin concurrency + flags**

In `src/index.ts`, beside the other DO exports add:
```ts
export { TenantConcurrencyDO } from "@/src/do/tenant-concurrency"
```

In `wrangler.toml`:
```toml
[[durable_objects.bindings]]
name = "TENANT_CONCURRENCY"
class_name = "TenantConcurrencyDO"

[[migrations]]
tag = "sig-455-tenant-concurrency-v1"
new_classes = ["TenantConcurrencyDO"]
```
> **Append the `[[migrations]]` tag AFTER all existing tags** — never mid-list (GLM: out-of-order tags break DO state routing).
>
> **Do NOT add a `[[queues.consumers]]` block in this PR.** Both reviewers flagged it: the consumer is dashboard-registered, and re-declaring it in `wrangler.toml` breaks `wrangler deploy` with **Cloudflare error 11004** (intentionally commented at `wrangler.toml:1049`). The global review cap stays the dashboard `max_concurrency=5`; the per-tenant DO cap (2) operates within it. Pinning the consumer in code is a *separate, deploy-verified* ops change (delete the dashboard consumer first) — out of scope for PR A.
Add the flags under `[vars]`:
```toml
SIGILIX_FAIRNESS_MODE = "shadow"
SIGILIX_TENANT_CONCURRENCY_CAP = "2"
```

- [ ] **Step 5: Verify it compiles + record the migration in the ledger**

Run: `npm run typecheck`
Expected: PASS (exit 0).
Update the spec's migration ledger row for `sig-455-tenant-concurrency-v1` if its status notes change (already listed in §7.3).

- [ ] **Step 6: Commit**

```bash
npx prettier --write src/shared/types/env.ts src/shared/types/job.ts src/index.ts src/features/tenancy/index.ts
git add src/shared/types/env.ts src/shared/types/job.ts src/index.ts src/features/tenancy/index.ts wrangler.toml
git commit -m "feat(SIG-455): wire TenantConcurrencyDO binding + fairness flags + pin queue concurrency"
```

---

## Task 4: `admitTenant()` / `releaseTenant()` client (the shared primitive)

**Files:**
- Create: `src/features/tenancy/adapters/concurrency-client.ts`
- Test: `src/features/tenancy/adapters/concurrency-client.test.ts`

**Interfaces:**
- Consumes: the `TENANT_CONCURRENCY` binding from `Env`.
- Produces: `admitTenant({env, tenantId, leaseId, cap})→Promise<AdmitResult>` and `releaseTenant(env, tenantId, leaseId)→Promise<void>`, where `AdmitResult = { granted: boolean; retryAfterMs: number }`. **Both fail open** (any throw/non-200 → granted/no-op).

- [ ] **Step 1: Write the failing test**

```ts
// src/features/tenancy/adapters/concurrency-client.test.ts
import { describe, it, expect } from "vitest"
import { admitTenant, releaseTenant } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

function envWith(fetchImpl: (req: Request) => Promise<Response>): Env {
  return {
    TENANT_CONCURRENCY: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({ fetch: (req: Request) => fetchImpl(req) }),
    },
  } as unknown as Env
}

describe("admitTenant", () => {
  it("returns the DO verdict", async () => {
    const env = envWith(async () => new Response(JSON.stringify({ granted: false, retryAfterMs: 1234 }), { status: 200 }))
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r).toEqual({ granted: false, retryAfterMs: 1234 })
  })

  it("FAILS OPEN on a DO error (granted=true)", async () => {
    const env = envWith(async () => {
      throw new Error("DO down")
    })
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r).toEqual({ granted: true, retryAfterMs: 0 })
  })

  it("FAILS OPEN on a non-200 (granted=true)", async () => {
    const env = envWith(async () => new Response("nope", { status: 500 }))
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r.granted).toBe(true)
  })

  it("releaseTenant never throws", async () => {
    const env = envWith(async () => {
      throw new Error("boom")
    })
    await expect(releaseTenant(env, "42", "l1")).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/features/tenancy/adapters/concurrency-client.test.ts`
Expected: FAIL — `admitTenant` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/tenancy/adapters/concurrency-client.ts
import type { Env } from "@/src/shared/types/env"

export interface AdmitResult {
  granted: boolean
  retryAfterMs: number
}

export interface AdmitArgs {
  env: Env
  tenantId: string
  leaseId: string
  cap: number
}

function tenantStub(env: Env, tenantId: string): DurableObjectStub {
  return env.TENANT_CONCURRENCY.get(env.TENANT_CONCURRENCY.idFromName(`tenant:${tenantId}`))
}

/** Acquire a per-tenant slot. FAILS OPEN — any error grants, so fairness never blocks a review. */
export async function admitTenant(args: AdmitArgs): Promise<AdmitResult> {
  try {
    const res = await tenantStub(args.env, args.tenantId).fetch("https://do.internal/acquire", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId: args.leaseId, cap: args.cap }),
    })
    if (!res.ok) return { granted: true, retryAfterMs: 0 }
    const body = (await res.json()) as { granted?: unknown; retryAfterMs?: unknown }
    return {
      granted: body.granted !== false, // default-grant on a malformed body
      retryAfterMs: typeof body.retryAfterMs === "number" ? body.retryAfterMs : 0,
    }
  } catch {
    return { granted: true, retryAfterMs: 0 }
  }
}

/** Release a slot. Best-effort — the DO's TTL reaper reclaims a leak if this never lands. */
export async function releaseTenant(env: Env, tenantId: string, leaseId: string): Promise<void> {
  try {
    await tenantStub(env, tenantId).fetch("https://do.internal/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    })
  } catch {
    // swallow — TTL reaper is the safety net
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/features/tenancy/adapters/concurrency-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/features/tenancy/adapters/concurrency-client.ts src/features/tenancy/adapters/concurrency-client.test.ts
git add src/features/tenancy/adapters/concurrency-client.ts src/features/tenancy/adapters/concurrency-client.test.ts
git commit -m "feat(SIG-455): admitTenant/releaseTenant client (fail-open over TenantConcurrencyDO)"
```

---

## Task 5: Webhook admission in `queue()` + `PrReviewRunDO./defer`

This is the load-bearing integration. A denial on the async path must (a) NOT call `/pickup`, (b) NOT consume queue retries, and (c) NOT let the per-PR watchdog false-fail the waiting run. We do that by calling a new `/defer` route on the per-PR DO, which re-arms the watchdog and schedules a `defer` alarm that re-sends a fresh job.

**Files:**
- Modify: `src/do/pr-review-run.ts` (new `/defer` route + `handleDeferAlarm`)
- Modify: `src/index.ts` (`queue()` admission)
- Test: `src/do/pr-review-run.defer.test.ts`, `src/index.queue-fairness.test.ts`

**Interfaces:**
- Consumes: `admitTenant`/`releaseTenant` (Task 4); `JobMessage.deferCount` (Task 3); `MAX_DEFERS` (Task 1).
- Produces: `PrReviewRunDO` route `POST /defer` (`{runId, backoffMs}` → `{ok:true}`); admission behavior in `queue()`.

- [ ] **Step 1: Write the failing `/defer` test**

```ts
// src/do/pr-review-run.defer.test.ts  — uses the existing DO test harness pattern (see do-pr-review-run-routes.test.ts)
import { describe, it, expect } from "vitest"
// (import the repo's existing makeDoState helper + PrReviewRunDO; mirror do-pr-review-run-routes.test.ts setup)
```
The test must assert, against a `queued` RunState:
1. `POST /defer {runId, backoffMs: 30000}` returns 200, sets `alarmKind = "defer"`, and an alarm ~`now+30000`.
2. Triggering that alarm re-sends ONE `pr-review` queue message (capture via a fake `env.OPENCLAW_JOBS.send`) with `deferCount` incremented and `attempt` UNCHANGED, then re-arms a `watchdog` alarm.
3. `/defer` on a **non-`queued`** RunState (`running`/`done`/`failed`) is a 200 no-op — state unchanged, **no send** (Codex: running-state preservation — a duplicate denied after `/pickup` must not regress the active run).
4. After `deferCount` exceeds `MAX_DEFERS`, the re-sent message carries `deferCount >= MAX_DEFERS` (the consumer will bypass).

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/do/pr-review-run.defer.test.ts`
Expected: FAIL — `/defer` route returns 404.

- [ ] **Step 3: Implement `/defer` + `handleDeferAlarm` in `pr-review-run.ts`**

Add the route in `fetch()` (beside the others, ~`pr-review-run.ts:81`):
```ts
    if (request.method === "POST" && url.pathname === "/defer") {
      return this.handleDefer(request)
    }
```
Add `"defer"` to the `alarmKind` union in `RunState` (`src/do/types.ts`), and a `deferCount?: number` field.

**File-budget (Codex blocker): `pr-review-run.ts` is already at 996/1000 lines** (eslint `max-lines`). Put the defer logic in the new sibling `src/do/pr-review-run-defer.ts` (mirroring `pr-review-run-internals.ts`) as `handleDeferRequest(ctx, env, body)` + `runDeferAlarm(ctx, env, state)`; the DO's `/defer` route and the `"defer"` alarm branch are one-line delegations to them. Verify `pr-review-run.ts` stays ≤1000 via `npm run lint`.

Add the handler + alarm (model the send on `handleRetryAlarm`, `pr-review-run.ts:698`, but DO NOT increment `attempts`):
```ts
  private async handleDefer(request: Request): Promise<Response> {
    const { runId, backoffMs } = (await request.json()) as { runId: string; backoffMs: number }
    const state = await this.ctx.storage.get<RunState>(STATE_KEY)
    // Codex blocker: queued-ONLY. A duplicate delivery denied while the run is already `running`
    // (after /pickup) must NOT be regressed back to `queued`. Any non-queued state → no-op.
    if (!state || state.runId !== runId || state.state !== "queued") {
      return jsonResponse(200, { ok: true, noop: true })
    }
    const config = resolveDoConfig(this.env)
    const deferCount = (state.deferCount ?? 0) + 1
    const fireAt = Date.now() + Math.max(0, backoffMs)
    const updated: RunState = {
      ...state,
      state: "queued",
      deferCount,
      lastActivityAt: nowIso(),
      alarmTargetRunId: runId,
      alarmKind: "defer",
      // re-arm the watchdog ceiling so a deferred run is never failed for waiting
      watchdogDeadlineAt: new Date(Date.now() + config.watchdogMs).toISOString(),
    }
    await this.ctx.storage.put(STATE_KEY, updated)
    await this.ctx.storage.setAlarm(fireAt)
    emit("do-review-deferred", { owner: state.owner, repo: state.repo, prNumber: state.prNumber, runId, deferCount, backoffMs })
    return jsonResponse(200, { ok: true })
  }

  private async handleDeferAlarm(state: RunState): Promise<void> {
    if (state.state === "done" || state.state === "failed") return
    const config = resolveDoConfig(this.env)
    await this.env.OPENCLAW_JOBS.send({
      type: "pr-review",
      owner: state.owner,
      repo: state.repo,
      prNumber: state.prNumber,
      headSha: state.headSha,
      installationId: state.installationId,
      runId: state.runId,
      enqueuedAtMs: Date.now(),
      attempt: state.attempts, // UNCHANGED — a defer is not a retry
      deferCount: state.deferCount ?? 1,
      ...(state.staleHeadRequeueDepth !== undefined ? { staleHeadRequeueDepth: state.staleHeadRequeueDepth } : {}),
      ...(state.checkRunId !== undefined ? { checkRunId: state.checkRunId } : {}),
      ...(normalizeRepoId(state.repoId) !== undefined ? { repoId: normalizeRepoId(state.repoId)! } : {}),
    })
    const updated: RunState = { ...state, alarmTargetRunId: state.runId, alarmKind: "watchdog" }
    await this.ctx.storage.put(STATE_KEY, updated)
    await this.ctx.storage.setAlarm(Date.now() + config.watchdogMs)
  }
```
Wire the dispatch in the alarm router (beside the `kind === "retry"` branch, ~`pr-review-run.ts:690`):
```ts
    } else if (kind === "defer") {
      await this.handleDeferAlarm(state)
    }
```

- [ ] **Step 4: Run the `/defer` test, verify it passes**

Run: `npx vitest run src/do/pr-review-run.defer.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing `queue()` admission test**

```ts
// src/index.queue-fairness.test.ts
// Build a pr-review MessageBatch and a fake Env whose TENANT_CONCURRENCY + PR_REVIEW_RUN
// stubs record calls. Assert per SIGILIX_FAIRNESS_MODE:
//   enforce + denied  -> /defer called on PR_REVIEW_RUN, dispatch NOT run, message.ack()
//   enforce + granted -> dispatch runs, releaseTenant called afterward
//   shadow + denied   -> dispatch STILL runs (measure only), /defer NOT called
//   acquire throws     -> dispatch runs (fail-open)
//   deferCount>=MAX_DEFERS -> admission bypassed, dispatch runs
```

- [ ] **Step 6: Run it, verify it fails**

Run: `npx vitest run src/index.queue-fairness.test.ts`
Expected: FAIL — admission not implemented.

- [ ] **Step 7: Implement admission in `queue()` (`src/index.ts:443`)**

Extract a helper `admitPrReview(message, env)` and use it inside the loop, BEFORE `dispatchJob`:
```ts
import { admitTenant, releaseTenant, MAX_DEFERS } from "@/src/features/tenancy"
// ...
async queue(batch, env, ctx) {
  const MAX_RETRIES = 3
  const mode = env.SIGILIX_FAIRNESS_MODE === "enforce" ? "enforce" : env.SIGILIX_FAIRNESS_MODE === "shadow" ? "shadow" : "off"
  const cap = Number.parseInt(env.SIGILIX_TENANT_CONCURRENCY_CAP ?? "", 10) || 2
  for (const message of batch.messages) {
    const job = message.body
    const fairnessEligible =
      mode !== "off" &&
      job.type === "pr-review" &&
      typeof job.installationId === "number" &&
      typeof job.runId === "string" // Codex: slash reruns (no runId) bypass fairness — don't even acquire
    let lease: { tenantId: string; leaseId: string } | undefined
    if (fairnessEligible) {
      const bypass = typeof job.deferCount === "number" && job.deferCount >= MAX_DEFERS
      if (!bypass) {
        const tenantId = String(job.installationId)
        const leaseId = crypto.randomUUID()
        const res = await admitTenant({ env, tenantId, leaseId, cap })
        console.log(JSON.stringify({ event: "fairness-decision", tenantId, leaseId, desired: res.granted ? "GRANT" : "DENY", mode }))
        if (!res.granted && mode === "enforce") {
          // re-arm the per-PR DO + schedule a fresh re-send (NEVER message.retry — that burns the
          // retry budget so Cloudflare drops the review). runId is guaranteed by fairnessEligible.
          try {
            const id = env.PR_REVIEW_RUN.idFromName(`${job.owner}/${job.repo}#${job.prNumber}`)
            const deferRes = await env.PR_REVIEW_RUN.get(id).fetch("https://do.internal/defer", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ runId: job.runId, backoffMs: res.retryAfterMs }),
            })
            if (deferRes.ok) {
              message.ack()
              continue
            }
            // Codex: /defer non-2xx → FAIL-OPEN. Fall through and run the review — never ack-and-drop.
          } catch {
            // /defer threw → FAIL-OPEN: fall through and run the review.
          }
        }
        if (res.granted) lease = { tenantId, leaseId }
      }
    }
    try {
      await dispatchJob(job, env, (promise) => ctx.waitUntil(promise))
      message.ack()
    } catch (error) {
      const isFinalAttempt = message.attempts > MAX_RETRIES
      console.error(isFinalAttempt ? "queue job dropped (max retries)" : "queue job failed (will retry)", {
        type: job.type, attempts: message.attempts, maxRetries: MAX_RETRIES, error: String(error),
      })
      if (isFinalAttempt) message.ack()
      else message.retry()
    } finally {
      if (lease) await releaseTenant(env, lease.tenantId, lease.leaseId)
    }
  }
}
```

- [ ] **Step 8: Run both tests + the full suite slice, verify pass**

Run: `npx vitest run src/index.queue-fairness.test.ts src/do/pr-review-run.defer.test.ts`
Expected: PASS.

- [ ] **Step 9: Format + commit**

```bash
npx prettier --write src/do/pr-review-run.ts src/do/types.ts src/index.ts src/do/pr-review-run.defer.test.ts src/index.queue-fairness.test.ts
git add src/do/pr-review-run.ts src/do/types.ts src/index.ts src/do/pr-review-run.defer.test.ts src/index.queue-fairness.test.ts
git commit -m "feat(SIG-455): webhook fairness admission + PrReviewRunDO /defer (re-send, never retry)"
```

---

## Task 6: `/v1/review` admission (CLI surface)

Wire the SAME `admitTenant()` primitive into the hosted review route. The synchronous path can't re-send, so a denial returns `429 + Retry-After`. Keep `admitUnderDailyCeiling` as the complementary cost guard.

**Files:**
- Modify: `src/lib/api-review-route.ts`
- Test: `src/lib/api-review-route.fairness.test.ts`

**Interfaces:**
- Consumes: `admitTenant`/`releaseTenant` (Task 4). `tenantId` = the resolved `installationId` in Mode B; the asserted `owner/repo` (`owner__repo`) in Mode A.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/api-review-route.fairness.test.ts
// With SIGILIX_FAIRNESS_MODE=enforce and a TENANT_CONCURRENCY stub that DENIES:
//   - the route returns 429 with a Retry-After header, and does NOT run the ensemble
// With the stub that GRANTS:
//   - the ensemble runs and releaseTenant is called afterward (finally)
// With mode=shadow + deny: the ensemble STILL runs (measure only)
// admitUnderDailyCeiling still applies independently (a daily-limit 429 is unchanged)
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/api-review-route.fairness.test.ts`
Expected: FAIL — no fairness gate in the route.

- [ ] **Step 3: Implement admission in the route**

After the existing `admitUnderDailyCeiling` check and AFTER the tenant/installation is known (Mode B: the resolved installationId; Mode A: `${owner}__${repo}`), add:
```ts
import { admitTenant, releaseTenant } from "@/src/features/tenancy"
// ...
const mode = env.SIGILIX_FAIRNESS_MODE === "enforce" ? "enforce" : env.SIGILIX_FAIRNESS_MODE === "shadow" ? "shadow" : "off"
const cap = Number.parseInt(env.SIGILIX_TENANT_CONCURRENCY_CAP ?? "", 10) || 2
let lease: { tenantId: string; leaseId: string } | undefined
if (mode !== "off") {
  const leaseId = crypto.randomUUID()
  const admit = await admitTenant({ env, tenantId, leaseId, cap })
  console.log(JSON.stringify({ event: "fairness-decision", surface: "v1review", tenantId, desired: admit.granted ? "GRANT" : "DENY", mode }))
  if (!admit.granted && mode === "enforce") {
    return new Response(JSON.stringify({ error: "tenant_busy" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(Math.ceil(admit.retryAfterMs / 1000)) },
    })
  }
  if (admit.granted) lease = { tenantId, leaseId }
}
try {
  // ... existing handlePrReviewEnsemble(...) call ...
} finally {
  if (lease) await releaseTenant(env, lease.tenantId, lease.leaseId)
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/api-review-route.fairness.test.ts`
Expected: PASS.

- [ ] **Step 5: Format + commit**

```bash
npx prettier --write src/lib/api-review-route.ts src/lib/api-review-route.fairness.test.ts
git add src/lib/api-review-route.ts src/lib/api-review-route.fairness.test.ts
git commit -m "feat(SIG-455): /v1/review shares the tenant fairness semaphore (429+Retry-After on deny)"
```

---

## Task 7: Full gate + internal review

- [ ] **Step 1: Run the whole build**

Run: `npm run build` (then `echo "REAL_BUILD_EXIT=$?"` — verify the EXIT CODE, not just the absence of a FAIL line; the `&&`-chain fails fast before vitest).
Expected: `REAL_BUILD_EXIT=0` — tsc + eslint + full vitest all green.

- [ ] **Step 2: End-to-end behavior test through the real path**

Confirm the e2e/queue test added in Task 5 exercises deny→`/defer`→re-send (not `message.retry`) and that the per-PR DO is never `/pickup`'d on denial. Confirm it would FAIL if the admission block were reverted.

- [ ] **Step 3: Internal code-reviewer pass (mandatory, CLAUDE.md)**

Launch a `code-reviewer` subagent on the full diff. Fix valid findings. (A Codex second pass is welcome.)

- [ ] **Step 4: Open the PR (do not merge)**

Branch `sig-455-tenant-fairness`. PR body: what / why / how-verified; `Part of SIG-455` (PR B closes it); include `@sigilix ignore` + `@coderabbitai ignore`. Confirm Sigilix + CodeRabbit + CI fire. The repo owner merges.

---

## Self-Review (run before handing off)

**Spec coverage:** PR A items in spec §10 — `TenantConcurrencyDO` ✅ T2, lease/reaper ✅ T1/T2, shared `admitTenant()` ✅ T4, two call sites ✅ T5 (webhook) + T6 (`/v1/review`), `/defer` + re-send ✅ T5, cap-from-env ✅ T3, `SIGILIX_FAIRNESS_MODE` shadow default ✅ T3/T5/T6, global cap stays dashboard `max_concurrency` (pinning deferred — CF 11004) ✅ T3, no D1 ✅ (no D1 anywhere), fail-open ✅ T4/T5/T6 (+ `/defer` non-2xx → dispatch), deferred-not-watchdog-failed ✅ T5 (`/defer` re-arms watchdog, queued-only guard), lease idempotency ✅ T1, reaper reclaim ✅ T2.

**Placeholder scan:** none — every code step shows complete code; the two integration tasks (T5/T6) show the exact inserted blocks and cite the existing file:line they sit in. Tasks 5/6 test *bodies* describe assertions rather than full harness boilerplate because they reuse the repo's existing DO/route test harnesses (`do-pr-review-run-routes.test.ts`) — the implementer copies that setup.

**Type consistency:** `AdmitResult {granted, retryAfterMs}` is produced in T4 and consumed identically in T5/T6; `FairnessState`/`Lease` defined in T1 used in T2; `deferCount` added in T3 is read in T5; `MAX_DEFERS` from T1 used in T5.

**Risks flagged at review (all resolved in-plan after Codex + GLM 5.2 sign-off):**
- TTL-only reaper is safe because `LEASE_TTL_MS (35m) > max watchdog clamp (30m)` — re-confirm if the clamp is raised.
- `/defer` is **queued-only** (cannot regress a `running` run); covered by a running-state-preservation test.
- `pr-review-run.ts` defer logic is extracted to a sibling to stay under the 1000-line eslint budget.
- **No `[[queues.consumers]]` block** in this PR (CF 11004); the global cap stays the dashboard setting.
- `/defer` non-2xx and any DO error both **fail open** to dispatch — a review is never ack-and-dropped.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-25-pr-a-tenant-fairness.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Which approach?
