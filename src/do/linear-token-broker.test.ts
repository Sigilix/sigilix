// SIG-144 (Linear unification slice 1) — LinearTokenBroker DO tests.
//
// The DO is constructed in-process with a hand-built DurableObjectState stub
// (Map-backed get/put + alarm tracking), mirroring the PrReviewRunDO alarm tests.
// The token-exchange POST is stubbed via vi.spyOn(globalThis, "fetch") (same as
// linear-agent-oauth.test.ts). Public methods are called directly (RPC style, like
// RepoGraphDO) — no HTTP fetch into the DO.
//
// NOTE (honesty): these tests exercise the DO's logic in Node with a storage stub.
// They do NOT run a real Cloudflare alarm end-to-end (that needs miniflare /
// workers-pool) — alarm() is invoked directly and the stub records setAlarm.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { LinearTokenBroker } from "@/src/do/linear-token-broker"
import type { Env } from "@/src/shared/types/env"
import type { LinearAgentTokenRecord } from "@/src/lib/linear-agent-oauth"

// Must match TOKEN_KEY in linear-token-broker.ts (the storage key the DO writes).
const TOKEN_KEY = "linear-agent-token"
const PENDING_TOKEN_KEY = "linear-agent-token-pending"

interface AlarmState {
  at: number | null
}
interface PutCtl {
  failPut: boolean
  failSetAlarm: boolean
}

function makeDoState(): {
  ctx: DurableObjectState
  store: Map<string, unknown>
  alarms: AlarmState
  ctl: PutCtl
} {
  const store = new Map<string, unknown>()
  const alarms: AlarmState = { at: null }
  const ctl: PutCtl = { failPut: false, failSetAlarm: false }
  const ctx = {
    storage: {
      async get<T>(k: string): Promise<T | undefined> {
        return store.get(k) as T | undefined
      },
      async put<T>(k: string, v: T): Promise<void> {
        if (ctl.failPut) throw new Error("storage put failed (test)")
        store.set(k, v)
      },
      async delete(k: string): Promise<boolean> {
        return store.delete(k)
      },
      async setAlarm(t: number): Promise<void> {
        if (ctl.failSetAlarm) throw new Error("storage setAlarm failed (test)")
        alarms.at = t
      },
      async getAlarm(): Promise<number | null> {
        return alarms.at
      },
      async deleteAlarm(): Promise<void> {
        alarms.at = null
      },
      async transaction<T>(callback: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
        const draft = new Map(store)
        let draftAlarm = alarms.at
        const txn = {
          async get<TValue>(key: string): Promise<TValue | undefined> {
            return draft.get(key) as TValue | undefined
          },
          async put<TValue>(key: string, value: TValue): Promise<void> {
            if (ctl.failPut) throw new Error("storage put failed (test)")
            draft.set(key, value)
          },
          async delete(key: string): Promise<boolean> {
            return draft.delete(key)
          },
          async getAlarm(): Promise<number | null> {
            return draftAlarm
          },
          async setAlarm(t: number | Date): Promise<void> {
            if (ctl.failSetAlarm) throw new Error("storage setAlarm failed (test)")
            draftAlarm = t instanceof Date ? t.getTime() : t
          },
          async deleteAlarm(): Promise<void> {
            draftAlarm = null
          },
        } as unknown as DurableObjectTransaction
        const result = await callback(txn)
        store.clear()
        for (const [key, value] of draft) store.set(key, value)
        alarms.at = draftAlarm
        return result
      },
    },
    id: { toString: () => "linear-agent", name: "linear-agent" },
  } as unknown as DurableObjectState
  return { ctx, store, alarms, ctl }
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    LINEAR_OAUTH_CLIENT_ID: "client-id-123",
    LINEAR_OAUTH_CLIENT_SECRET: "client-secret-shh",
    ...extra,
  } as unknown as Env
}

/** Stub the token endpoint with a JSON body. Persistent (mockResolvedValue) so a
 *  test asserting a call count drives the assertion, not the mock arity. */
function mockTokenFetch(body: unknown, status = 200): MockInstance {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/** A record comfortably inside the refresh buffer (no proactive refresh needed). */
function freshRecord(over: Partial<LinearAgentTokenRecord> = {}): LinearAgentTokenRecord {
  return {
    accessToken: "tok-1",
    refreshToken: "ref-1",
    scope: "app:assignable",
    expiresAt: Date.now() + HOUR_MS,
    installedAt: 1,
    ...over,
  }
}

/** A record at/near expiry (within REFRESH_BUFFER_MS) — a mutating read refreshes. */
function nearExpiryRecord(over: Partial<LinearAgentTokenRecord> = {}): LinearAgentTokenRecord {
  return {
    accessToken: "tok-1",
    refreshToken: "ref-1",
    scope: "app:assignable",
    expiresAt: Date.now() + 60_000,
    installedAt: 1,
    ...over,
  }
}

function storedRecord(store: Map<string, unknown>): LinearAgentTokenRecord | undefined {
  return store.get(TOKEN_KEY) as LinearAgentTokenRecord | undefined
}

beforeEach(() => {
  vi.restoreAllMocks()
  // Silence the DO's neutral telemetry by default; specific tests re-spy to assert.
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("LinearTokenBroker.install + getValidToken (no refresh)", () => {
  it("install then getValidToken returns the stored access token without a POST", async () => {
    const { ctx } = makeDoState()
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    const broker = new LinearTokenBroker(ctx, makeEnv())

    await broker.install(freshRecord())
    const result = await broker.getValidToken({ readOnly: false })

    expect(result).toEqual({ ok: true, accessToken: "tok-1" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("install arms the proactive-refresh alarm at expiresAt - buffer", async () => {
    const { ctx, alarms } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    const expiresAt = Date.now() + HOUR_MS
    await broker.install(freshRecord({ expiresAt }))
    // 10-min buffer → alarm well before expiry, but in the future.
    expect(alarms.at).not.toBeNull()
    expect(alarms.at!).toBeGreaterThan(Date.now())
    expect(alarms.at!).toBeLessThanOrEqual(expiresAt)
  })

  it("readOnly returns the in-buffer (near-expiry) token WITHOUT a refresh POST", async () => {
    const { ctx } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord())
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    const result = await broker.getValidToken({ readOnly: true })

    expect(result).toEqual({ ok: true, accessToken: "tok-1" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("rejects tenant metadata on the deprecated singleton install seam", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())

    await expect(
      broker.install(
        freshRecord({ organizationId: "org-a", installationId: 11, actorType: "app", appUserId: "app-a" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "tenant-metadata-present" })
    expect(storedRecord(store)).toBeUndefined()
  })
})

describe("LinearTokenBroker.uninstallTenant", () => {
  it("deletes only an exact tenant record and clears its alarm", async () => {
    const { ctx, store, alarms } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    const scope = { organizationId: "org-a", installationId: 11 }
    await broker.installTenant(freshRecord({ ...scope, actorType: "app", appUserId: "app-a" }), scope)

    await expect(broker.uninstallTenant({ organizationId: "org-b", installationId: 11 })).resolves.toEqual({
      ok: false,
      reason: "tenant-mismatch",
    })
    expect(storedRecord(store)?.accessToken).toBe("tok-1")

    await expect(broker.uninstallTenant(scope)).resolves.toEqual({ ok: true, removed: true })
    expect(storedRecord(store)).toBeUndefined()
    expect(alarms.at).toBeNull()
  })

  it("waits for an in-flight refresh and leaves no token record behind", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    const scope = { organizationId: "org-a", installationId: 11 }
    await broker.installTenant(nearExpiryRecord({ ...scope, actorType: "app" }), scope)
    let resolveFetch!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )

    const refresh = broker.forceRefreshTenant(scope)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    const uninstall = broker.uninstallTenant(scope)
    resolveFetch(
      new Response(JSON.stringify({ access_token: "tok-rotated", refresh_token: "ref-rotated", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(refresh).resolves.toEqual({ ok: true, accessToken: "tok-rotated" })
    await expect(uninstall).resolves.toEqual({ ok: true, removed: true })
    expect(storedRecord(store)).toBeUndefined()
  })
})

describe("LinearTokenBroker.installTenant", () => {
  const scope = { organizationId: "org-a", installationId: 11 }

  it("returns a structured tenant-conflict result for mismatched metadata", async () => {
    const { ctx } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())

    await expect(
      broker.installTenant(freshRecord({ organizationId: "org-b", installationId: 11, actorType: "app" }), scope),
    ).resolves.toEqual({ ok: false, reason: "tenant-conflict" })
  })

  it("returns a structured tenant-conflict result when the shard holds another tenant", async () => {
    const { ctx } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    const otherScope = { organizationId: "org-b", installationId: 22 }
    await broker.installTenant(freshRecord({ ...otherScope, actorType: "app" }), otherScope)

    await expect(broker.installTenant(freshRecord({ ...scope, actorType: "app" }), scope)).resolves.toEqual({
      ok: false,
      reason: "tenant-conflict",
    })
  })
})

describe("LinearTokenBroker tenant install staging", () => {
  const scope = { organizationId: "org-a", installationId: 11 }
  const tenantRecord = (accessToken: string): LinearAgentTokenRecord =>
    freshRecord({ accessToken, ...scope, actorType: "app", appUserId: "app-a" })

  it("atomically rejects an alarm failure without replacing the active token or leaving a pending credential", async () => {
    const { ctx, store, ctl } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.installTenant(tenantRecord("tok-old"), scope)
    ctl.failSetAlarm = true

    await expect(broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")).rejects.toThrow(/setAlarm/)

    expect(storedRecord(store)?.accessToken).toBe("tok-old")
    expect(store.has(PENDING_TOKEN_KEY)).toBe(false)
  })

  it("rolls back only the matching generation and preserves the prior active token and alarm", async () => {
    const { ctx, store, alarms } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.installTenant(tenantRecord("tok-old"), scope)
    const priorAlarm = alarms.at
    await expect(broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")).resolves.toEqual({
      ok: true,
    })

    await expect(broker.rollbackTenantInstall(scope, "generation-b")).resolves.toEqual({
      ok: false,
      reason: "generation-mismatch",
    })
    expect(storedRecord(store)?.accessToken).toBe("tok-old")
    expect(store.has(PENDING_TOKEN_KEY)).toBe(true)

    await expect(broker.rollbackTenantInstall(scope, "generation-a")).resolves.toEqual({
      ok: true,
      removed: true,
    })
    expect(storedRecord(store)?.accessToken).toBe("tok-old")
    expect(store.has(PENDING_TOKEN_KEY)).toBe(false)
    expect(alarms.at).toBe(priorAlarm)
  })

  it("commits exactly one generation and makes a lost-response retry idempotent", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.installTenant(tenantRecord("tok-old"), scope)
    await broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")

    await expect(broker.commitTenantInstall(scope, "generation-a")).resolves.toEqual({
      ok: true,
      committed: true,
    })
    expect(storedRecord(store)).toMatchObject({ accessToken: "tok-new", installGeneration: "generation-a" })
    expect(store.has(PENDING_TOKEN_KEY)).toBe(false)
    await expect(broker.commitTenantInstall(scope, "generation-a")).resolves.toEqual({
      ok: true,
      committed: false,
    })
  })

  it("does not let an old in-flight refresh overwrite a newly committed generation", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.installTenant(nearExpiryRecord({ accessToken: "tok-old", ...scope, actorType: "app" }), scope)
    let resolveFetch!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )

    const refresh = broker.forceRefreshTenant(scope)
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce())
    await broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")
    await broker.commitTenantInstall(scope, "generation-a")
    resolveFetch(
      new Response(JSON.stringify({ access_token: "tok-old-rotated", refresh_token: "ref-old-rotated" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )

    await expect(refresh).resolves.toEqual({ ok: true, accessToken: "tok-new" })
    expect(storedRecord(store)).toMatchObject({ accessToken: "tok-new", installGeneration: "generation-a" })
  })

  it("retries an unknown D1 outcome but deletes the inaccessible pending credential at its hard ceiling", async () => {
    const { ctx, store, alarms } = makeDoState()
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error("D1 unavailable")
          },
        }),
      }),
    } as unknown as D1Database
    const broker = new LinearTokenBroker(ctx, makeEnv({ SIGILIX_PLATFORM_DB: db }))
    await broker.installTenant(tenantRecord("tok-old"), scope)
    await broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")
    const pending = store.get(PENDING_TOKEN_KEY) as {
      generation: string
      record: LinearAgentTokenRecord
      reconcileAt: number
      expiresAt: number
    }
    store.set(PENDING_TOKEN_KEY, { ...pending, reconcileAt: Date.now() - 1 })

    await broker.alarm()
    const deferred = store.get(PENDING_TOKEN_KEY) as { reconcileAt: number; expiresAt: number }
    expect(deferred.reconcileAt).toBeGreaterThan(Date.now())
    expect(alarms.at).toBe(deferred.reconcileAt)
    expect(storedRecord(store)?.accessToken).toBe("tok-old")

    store.set(PENDING_TOKEN_KEY, {
      ...deferred,
      record: pending.record,
      generation: pending.generation,
      reconcileAt: 0,
      expiresAt: 0,
    })
    await broker.alarm()
    expect(store.has(PENDING_TOKEN_KEY)).toBe(false)
    expect(storedRecord(store)?.accessToken).toBe("tok-old")
  })

  it("emits a structured alert when alarm reconciliation cannot roll back the pending generation", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.installTenant(tenantRecord("tok-old"), scope)
    await broker.stageTenantInstall(tenantRecord("tok-new"), scope, "generation-a")
    const pending = store.get(PENDING_TOKEN_KEY) as {
      generation: string
      record: LinearAgentTokenRecord
      reconcileAt: number
      expiresAt: number
    }
    store.set(PENDING_TOKEN_KEY, { ...pending, reconcileAt: 0, expiresAt: 0 })
    vi.spyOn(broker, "rollbackTenantInstall").mockResolvedValue({
      ok: false,
      reason: "generation-mismatch",
    })
    const error = vi.spyOn(console, "error")

    await broker.alarm()

    expect(error.mock.calls.flat().map(String).join("\n")).toContain("linear-token-broker-install-reconcile-failed")
    expect(error.mock.calls.flat().map(String).join("\n")).toContain('"action":"rollback"')
    expect(error.mock.calls.flat().map(String).join("\n")).toContain('"reason":"generation-mismatch"')
  })
})

describe("LinearTokenBroker.getValidToken (refresh on near-expiry)", () => {
  it("near-expiry getValidToken refreshes, rotates, and persists the NEW refresh token", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord({ installedAt: 42 }))
    const fetchSpy = mockTokenFetch({
      access_token: "tok-2",
      refresh_token: "ref-2",
      expires_in: 86400,
      scope: "app:assignable,app:mentionable",
    })

    const result = await broker.getValidToken({ readOnly: false })

    expect(result).toEqual({ ok: true, accessToken: "tok-2" })
    expect(fetchSpy).toHaveBeenCalledOnce()
    // grant_type=refresh_token with the OLD refresh token + creds.
    const [endpoint, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(endpoint).toBe("https://api.linear.app/oauth/token")
    const form = new URLSearchParams(init.body as string)
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe("ref-1")
    // Rotation persisted to DO storage: both tokens replaced, installedAt preserved.
    const stored = storedRecord(store)
    expect(stored?.accessToken).toBe("tok-2")
    expect(stored?.refreshToken).toBe("ref-2")
    expect(stored?.scope).toBe("app:assignable,app:mentionable")
    expect(stored?.installedAt).toBe(42)
    expect(stored?.expiresAt).toBeGreaterThan(Date.now() + DAY_MS - 60_000)
  })

  it("falls back to the OLD refresh token when the response omits a new one", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord())
    mockTokenFetch({ access_token: "tok-2", expires_in: 86400 }) // no refresh_token

    const result = await broker.getValidToken({ readOnly: false })

    expect(result).toEqual({ ok: true, accessToken: "tok-2" })
    expect(storedRecord(store)?.refreshToken).toBe("ref-1")
  })

  it("two concurrent near-expiry getValidToken calls issue EXACTLY ONE refresh POST (single-flight)", async () => {
    const { ctx } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord())
    const fetchSpy = mockTokenFetch({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 86400 })

    const [a, b] = await Promise.all([
      broker.getValidToken({ readOnly: false }),
      broker.getValidToken({ readOnly: false }),
    ])

    expect(a).toEqual({ ok: true, accessToken: "tok-2" })
    expect(b).toEqual({ ok: true, accessToken: "tok-2" })
    expect(fetchSpy).toHaveBeenCalledOnce() // deduped to one POST
  })
})

describe("LinearTokenBroker — failure handling (no corruption, no token leakage)", () => {
  it("persist-fail AFTER a successful POST returns the OLD valid token, logs the alert, and does NOT corrupt storage", async () => {
    const { ctx, store, ctl } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord()) // succeeds (failPut still false)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    mockTokenFetch({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 86400 })
    ctl.failPut = true // every persist after this throws

    const result = await broker.getValidToken({ readOnly: false })

    // Old token is still valid (near expiry, not hard-expired) → fail-safe.
    expect(result).toEqual({ ok: true, accessToken: "tok-1" })
    // Loud neutral alert, with NO token material in any log line.
    const allLogs = JSON.stringify(errSpy.mock.calls) + JSON.stringify(logSpy.mock.calls)
    expect(allLogs).toContain("linear-token-broker-persist-failed")
    expect(allLogs).not.toContain("tok-2")
    expect(allLogs).not.toContain("ref-2")
    // Stored record is the ORIGINAL — never half-written.
    const stored = storedRecord(store)
    expect(stored?.accessToken).toBe("tok-1")
    expect(stored?.refreshToken).toBe("ref-1")
  })

  it("POST failure (non-2xx) returns the OLD valid token and does NOT corrupt storage", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(nearExpiryRecord())
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    )

    const result = await broker.getValidToken({ readOnly: false })

    expect(result).toEqual({ ok: true, accessToken: "tok-1" })
    expect(storedRecord(store)?.accessToken).toBe("tok-1")
    expect(storedRecord(store)?.refreshToken).toBe("ref-1")
  })

  it("cold start (empty storage) getValidToken returns a structured not-installed signal (never null)", async () => {
    const { ctx } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    const fetchSpy = vi.spyOn(globalThis, "fetch")

    expect(await broker.getValidToken({ readOnly: false })).toEqual({ ok: false, reason: "not-installed" })
    expect(await broker.getValidToken({ readOnly: true })).toEqual({ ok: false, reason: "not-installed" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("LinearTokenBroker.forceRefresh", () => {
  it("always refreshes — even when the stored token is comfortably fresh", async () => {
    const { ctx, store } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(freshRecord()) // far from expiry — getValidToken would NOT refresh
    const fetchSpy = mockTokenFetch({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 86400 })

    const result = await broker.forceRefresh()

    expect(result).toEqual({ ok: true, accessToken: "tok-2" })
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(storedRecord(store)?.accessToken).toBe("tok-2")
    expect(storedRecord(store)?.refreshToken).toBe("ref-2")
  })
})

describe("LinearTokenBroker.alarm", () => {
  it("alarm() performs a proactive refresh and re-arms the alarm to the NEW expiry", async () => {
    const { ctx, store, alarms } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(freshRecord({ expiresAt: Date.now() + HOUR_MS })) // 1h
    alarms.at = null // prove alarm() re-sets it
    const fetchSpy = mockTokenFetch({ access_token: "tok-2", refresh_token: "ref-2", expires_in: 86400 }) // 24h

    await broker.alarm()

    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(storedRecord(store)?.accessToken).toBe("tok-2")
    // Re-armed to the NEW 24h expiry - buffer (well past the old 1h horizon).
    expect(alarms.at).not.toBeNull()
    expect(alarms.at!).toBeGreaterThan(Date.now() + 4 * HOUR_MS)
  })

  it("alarm() re-arms a short retry when the refresh fails (record still present)", async () => {
    const { ctx, alarms } = makeDoState()
    const broker = new LinearTokenBroker(ctx, makeEnv())
    await broker.install(freshRecord())
    alarms.at = null
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"))

    await broker.alarm()

    // A retry alarm is armed in the near future so we try again before hard expiry.
    expect(alarms.at).not.toBeNull()
    expect(alarms.at!).toBeGreaterThan(Date.now())
    expect(alarms.at!).toBeLessThan(Date.now() + HOUR_MS)
  })
})
