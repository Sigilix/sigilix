// SIG-455 Task 5 — queue() per-tenant fairness admission tests.
//
// Exercises the REAL worker `queue()` consumer with a fake Env whose
// TENANT_CONCURRENCY + PR_REVIEW_RUN DO namespaces record calls, and a mocked
// `dispatchJob` so we can assert whether the review actually ran. The matrix
// covers every SIGILIX_FAIRNESS_MODE branch + the fail-open guarantees.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"
import { MAX_DEFERS } from "@/src/features/tenancy"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { upsertTenantAndRepo } from "@/src/features/tenancy/adapters/d1-tenant-store"

const MIGRATION_SQL = readFileSync(new URL("../migrations/0001_create_tenant_repo_usage.sql", import.meta.url), "utf8")

// Mock the dispatcher so the consumer's "did the review run?" decision is
// observable without executing the real (heavy) review pipeline. index.ts also
// re-exports `prMetaIsClosedOrMerged` from this module, so it must be present.
const { dispatchJobMock } = vi.hoisted(() => ({ dispatchJobMock: vi.fn(async () => {}) }))
vi.mock("@/src/index-dispatch", () => ({
  dispatchJob: dispatchJobMock,
  prMetaIsClosedOrMerged: vi.fn(),
}))

import worker from "@/src/index"

// ─── fakes ────────────────────────────────────────────────────

function makeNamespaceStub(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchSpy = vi.fn(fetchImpl)
  const namespace = {
    idFromName: vi.fn((name: string) => ({ toString: () => name, name })),
    get: vi.fn(() => ({ fetch: fetchSpy })),
  }
  return { namespace, fetchSpy }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

interface BuildEnvOpts {
  mode: "off" | "shadow" | "enforce"
  acquire: () => Promise<Response>
  defer?: () => Promise<Response>
  cap?: string
}

function buildEnv(opts: BuildEnvOpts) {
  const tenant = makeNamespaceStub(async (url) => {
    if (url.includes("/acquire")) return opts.acquire()
    return jsonResponse(200, { ok: true }) // /release
  })
  const prRun = makeNamespaceStub(async () => (opts.defer ? opts.defer() : jsonResponse(200, { ok: true })))
  const env = {
    SIGILIX_FAIRNESS_MODE: opts.mode,
    SIGILIX_TENANT_CONCURRENCY_CAP: opts.cap ?? "2",
    TENANT_CONCURRENCY: tenant.namespace,
    PR_REVIEW_RUN: prRun.namespace,
  } as unknown as Env
  return { env, tenant, prRun }
}

function makeJob(over: Partial<Extract<JobMessage, { type: "pr-review" }>> = {}): JobMessage {
  return {
    type: "pr-review",
    owner: "Sigilix",
    repo: "sigilix",
    prNumber: 7,
    headSha: "a".repeat(40),
    installationId: 42,
    runId: "run-1",
    ...over,
  } as JobMessage
}

function makeMessage(job: JobMessage) {
  return { body: job, attempts: 1, id: "m1", timestamp: new Date(), ack: vi.fn(), retry: vi.fn() }
}

function runQueue(env: Env, message: ReturnType<typeof makeMessage>) {
  const batch = { queue: "q", messages: [message] } as unknown as MessageBatch<JobMessage>
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
  return worker.queue(batch, env, ctx)
}

function calledWith(spy: ReturnType<typeof vi.fn>, substr: string): boolean {
  return spy.mock.calls.some((c) => typeof c[0] === "string" && (c[0] as string).includes(substr))
}

const granted = () => Promise.resolve(jsonResponse(200, { granted: true, retryAfterMs: 0 }))
const denied = () => Promise.resolve(jsonResponse(200, { granted: false, retryAfterMs: 30_000 }))

beforeEach(() => {
  dispatchJobMock.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

// ─── matrix ───────────────────────────────────────────────────

describe("queue() fairness admission", () => {
  it("enforce + denied → /defer called, dispatch NOT run, message.ack(), no retry", async () => {
    const { env, tenant, prRun } = buildEnv({ mode: "enforce", acquire: denied })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(calledWith(tenant.fetchSpy, "/acquire")).toBe(true)
    expect(calledWith(prRun.fetchSpy, "/defer")).toBe(true)
    expect(dispatchJobMock).not.toHaveBeenCalled()
    expect(message.ack).toHaveBeenCalledTimes(1)
    expect(message.retry).not.toHaveBeenCalled()
  })

  it("enforce + granted → dispatch runs, lease released afterward, message.ack()", async () => {
    const { env, tenant } = buildEnv({ mode: "enforce", acquire: granted })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(calledWith(tenant.fetchSpy, "/release")).toBe(true)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("shadow + denied → dispatch STILL runs (measure only), /defer NOT called", async () => {
    const { env, tenant, prRun } = buildEnv({ mode: "shadow", acquire: denied })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(calledWith(tenant.fetchSpy, "/acquire")).toBe(true)
    expect(calledWith(prRun.fetchSpy, "/defer")).toBe(false)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("off → admission skipped entirely, dispatch runs", async () => {
    const { env, tenant } = buildEnv({ mode: "off", acquire: denied })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(calledWith(tenant.fetchSpy, "/acquire")).toBe(false)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("acquire throws → fail-open: dispatch runs", async () => {
    const { env } = buildEnv({
      mode: "enforce",
      acquire: () => Promise.reject(new Error("DO unavailable")),
    })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("deferCount >= MAX_DEFERS → admission bypassed, dispatch runs (anti-starvation)", async () => {
    const { env, tenant } = buildEnv({ mode: "enforce", acquire: denied })
    const message = makeMessage(makeJob({ deferCount: MAX_DEFERS }))
    await runQueue(env, message)
    expect(calledWith(tenant.fetchSpy, "/acquire")).toBe(false)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("slash rerun (no runId) → bypasses fairness, never acquires, dispatch runs", async () => {
    const { env, tenant } = buildEnv({ mode: "enforce", acquire: denied })
    const job = makeJob()
    delete (job as { runId?: string }).runId
    const message = makeMessage(job)
    await runQueue(env, message)
    expect(calledWith(tenant.fetchSpy, "/acquire")).toBe(false)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("enforce + denied + /defer non-2xx → FAIL-OPEN: dispatch runs (never ack-and-drop)", async () => {
    const { env, prRun } = buildEnv({
      mode: "enforce",
      acquire: denied,
      defer: () => Promise.resolve(jsonResponse(500, { error: "defer failed" })),
    })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(calledWith(prRun.fetchSpy, "/defer")).toBe(true)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })

  it("enforce + denied + /defer throws → FAIL-OPEN: dispatch runs", async () => {
    const { env } = buildEnv({
      mode: "enforce",
      acquire: denied,
      defer: () => Promise.reject(new Error("defer threw")),
    })
    const message = makeMessage(makeJob())
    await runQueue(env, message)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
    expect(message.ack).toHaveBeenCalledTimes(1)
  })
})

// ─── D1 cap wiring ────────────────────────────────────────────
// SIG-343 PR C Task 6: verify that resolveTenantCap is wired at the
// queue() admitTenant call site — cap comes from D1 when available,
// falls back to env when the tenant row is missing.

/** Extract the cap value from the first /acquire fetch body. */
function acquireCapFromStub(tenant: ReturnType<typeof makeNamespaceStub>): number | undefined {
  const call = tenant.fetchSpy.mock.calls.find((c) => typeof c[0] === "string" && (c[0] as string).includes("/acquire"))
  if (!call) return undefined
  const init = call[1] as RequestInit
  return (JSON.parse(init.body as string) as { cap?: number }).cap
}

describe("queue() fairness admission — D1 cap wiring (SIG-343 PR C Task 6)", () => {
  it("D1 tenant cap → admitTenant called with D1 cap, not env cap", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    await upsertTenantAndRepo(
      { SIGILIX_PLATFORM_DB: db },
      { installationId: 42, repoId: 420, fullName: "acme/core", nowIso: "2026-01-01T00:00:00Z" },
    )
    // Operator-set cap of 7; env cap is 2 — the D1 value should win
    await db.prepare("UPDATE tenant SET concurrency_cap = ? WHERE installation_id = ?").bind(7, 42).run()

    const { env, tenant } = buildEnv({ mode: "enforce", acquire: granted })
    const envWithDb = { ...env, SIGILIX_PLATFORM_DB: db, SIGILIX_TENANT_CONCURRENCY_CAP: "2" } as unknown as Env
    const message = makeMessage(makeJob({ installationId: 42 }))
    await runQueue(envWithDb, message)

    expect(acquireCapFromStub(tenant)).toBe(7)
    expect(dispatchJobMock).toHaveBeenCalledTimes(1)
  })

  it("tenant missing from D1 → admitTenant called with env-default cap", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL)
    // No row for installationId 99 → falls back to env cap

    const { env, tenant } = buildEnv({ mode: "enforce", acquire: granted, cap: "3" })
    const envWithDb = { ...env, SIGILIX_PLATFORM_DB: db } as unknown as Env
    const message = makeMessage(makeJob({ installationId: 99 }))
    await runQueue(envWithDb, message)

    expect(acquireCapFromStub(tenant)).toBe(3)
  })
})
