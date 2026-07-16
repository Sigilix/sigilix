// auth-middleware durable-identity authority: once D1 is bound, a KV session
// authenticates only while its user_identity row is still live and consistent.
// Definitively stale KV is revoked; an unavailable D1 denies without destroying
// recoverable state; legacy no-D1 deployments retain their existing behavior.

import { afterEach, describe, expect, it, vi } from "vitest"
import { requireSession } from "@/src/lib/auth-middleware"
import type { SessionRecord } from "@/src/lib/auth-session"

interface FakeKV {
  store: Map<string, string>
  kv: KVNamespace
  get: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
}

interface IdentityRow {
  user_id: string
  github_user_id: string | null
  google_sub: string | null
  gitlab_id: string | null
  email: string | null
  email_verified: number
  name: string | null
  avatar_url: string | null
  providers: string
  mfa_enabled: number
  created_at: string
  last_login_at: string
}

function sessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    login: "alice",
    githubUserId: 111,
    userId: "user-1",
    provider: "github",
    encryptedAccessToken: "ciphertext",
    iv: "iv",
    createdAt: 1,
    lastSeenAt: 1,
    ...overrides,
  }
}

function identityRow(overrides: Partial<IdentityRow> = {}): IdentityRow {
  return {
    user_id: "user-1",
    github_user_id: "111",
    google_sub: null,
    gitlab_id: null,
    email: null,
    email_verified: 0,
    name: "Alice",
    avatar_url: null,
    providers: '["github"]',
    mfa_enabled: 0,
    created_at: "2026-07-15T00:00:00.000Z",
    last_login_at: "2026-07-15T00:00:00.000Z",
    ...overrides,
  }
}

function makeKV(sessionId: string, record: SessionRecord, events: string[] = []): FakeKV {
  const store = new Map([[`auth_session:${sessionId}`, JSON.stringify(record)]])
  const get = vi.fn(async (key: string, type?: "json") => {
    events.push("kv-get")
    const raw = store.get(key)
    if (raw === undefined) return null
    return type === "json" ? JSON.parse(raw) : raw
  })
  const put = vi.fn(async (key: string, value: string) => {
    events.push("kv-touch")
    store.set(key, value)
  })
  const del = vi.fn(async (key: string) => {
    events.push("kv-delete")
    store.delete(key)
  })
  return {
    store,
    get,
    put,
    delete: del,
    kv: { get, put, delete: del } as unknown as KVNamespace,
  }
}

function makeIdentityDb(args: {
  row?: IdentityRow | null
  beforeFirst?: () => Promise<void>
  firstError?: Error
  events?: string[]
}): { db: D1Database; first: ReturnType<typeof vi.fn>; bind: ReturnType<typeof vi.fn> } {
  const first = vi.fn(async () => {
    args.events?.push("identity-proof-start")
    await args.beforeFirst?.()
    if (args.firstError) throw args.firstError
    args.events?.push("identity-proof-complete")
    return args.row ?? null
  })
  const bind = vi.fn(() => ({ first }))
  const prepare = vi.fn(() => ({ bind }))
  return { db: { prepare } as unknown as D1Database, first, bind }
}

function requestFor(sessionId: string): Request {
  return new Request("https://api.sigilix.ai/auth/session", {
    headers: { cookie: `__Host-sigilix_session=${sessionId}` },
  })
}

function makeCtx(): {
  ctx: ExecutionContext
  waitUntil: ReturnType<typeof vi.fn>
  settled: () => Promise<void>
} {
  const pending: Promise<unknown>[] = []
  const waitUntil = vi.fn((promise: Promise<unknown>) => {
    pending.push(promise)
  })
  return {
    waitUntil,
    ctx: { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext,
    settled: async () => void (await Promise.allSettled(pending)),
  }
}

function envWithDb(kv: KVNamespace, db: D1Database): Parameters<typeof requireSession>[1] {
  return { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Parameters<typeof requireSession>[1]
}

function backendUnavailableEvent(errorSpy: ReturnType<typeof vi.spyOn>): boolean {
  return errorSpy.mock.calls.some(([value]) => {
    if (typeof value !== "string") return false
    try {
      const parsed = JSON.parse(value) as { event?: unknown }
      return parsed.event === "auth-session-identity-backend-unavailable"
    } catch {
      return false
    }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("requireSession durable identity authority", () => {
  it("proves the D1 identity before authenticating or scheduling the sliding KV touch", async () => {
    const events: string[] = []
    const kv = makeKV("sess-live", sessionRecord(), events)
    let releaseProof!: () => void
    const proofGate = new Promise<void>((resolve) => {
      releaseProof = resolve
    })
    const identity = makeIdentityDb({
      row: identityRow(),
      events,
      beforeFirst: () => proofGate,
    })
    const ctx = makeCtx()

    const pending = requireSession(requestFor("sess-live"), envWithDb(kv.kv, identity.db), ctx.ctx)
    try {
      await vi.waitFor(() => expect(identity.first).toHaveBeenCalledOnce())
      expect(kv.put).not.toHaveBeenCalled()
      expect(ctx.waitUntil).not.toHaveBeenCalled()
    } finally {
      releaseProof()
    }

    await expect(pending).resolves.toEqual({ sessionId: "sess-live", record: sessionRecord() })
    await ctx.settled()
    expect(identity.bind).toHaveBeenCalledWith("user-1")
    expect(events).toEqual(["kv-get", "identity-proof-start", "identity-proof-complete", "kv-touch"])
    expect(kv.delete).not.toHaveBeenCalled()
  })

  it("rejects and revokes a KV session whose durable user_identity row was deleted", async () => {
    const kv = makeKV("sess-deleted", sessionRecord())
    const identity = makeIdentityDb({ row: null })
    const ctx = makeCtx()

    await expect(requireSession(requestFor("sess-deleted"), envWithDb(kv.kv, identity.db), ctx.ctx)).resolves.toBeNull()
    await ctx.settled()

    expect(kv.store.has("auth_session:sess-deleted")).toBe(false)
    expect(kv.delete).toHaveBeenCalledWith("auth_session:sess-deleted")
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("rejects and revokes a userId-less legacy session when the durable identity DB is bound", async () => {
    const legacy = sessionRecord()
    delete legacy.userId
    const kv = makeKV("sess-legacy", legacy)
    const identity = makeIdentityDb({ row: identityRow() })
    const ctx = makeCtx()

    await expect(requireSession(requestFor("sess-legacy"), envWithDb(kv.kv, identity.db), ctx.ctx)).resolves.toBeNull()
    await ctx.settled()

    expect(identity.first).not.toHaveBeenCalled()
    expect(kv.store.has("auth_session:sess-legacy")).toBe(false)
    expect(kv.delete).toHaveBeenCalledWith("auth_session:sess-legacy")
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("rejects and revokes a session whose durable GitHub id conflicts with the session proof", async () => {
    const kv = makeKV("sess-mismatch", sessionRecord({ githubUserId: 111 }))
    const identity = makeIdentityDb({ row: identityRow({ github_user_id: "222" }) })
    const ctx = makeCtx()

    await expect(
      requireSession(requestFor("sess-mismatch"), envWithDb(kv.kv, identity.db), ctx.ctx),
    ).resolves.toBeNull()
    await ctx.settled()

    expect(kv.store.has("auth_session:sess-mismatch")).toBe(false)
    expect(kv.delete).toHaveBeenCalledWith("auth_session:sess-mismatch")
    expect(kv.put).not.toHaveBeenCalled()
  })

  it("denies on an unavailable identity backend but preserves KV and emits distinct telemetry", async () => {
    const kv = makeKV("sess-recoverable", sessionRecord())
    const identity = makeIdentityDb({ firstError: new Error("D1 unavailable") })
    const ctx = makeCtx()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    await expect(
      requireSession(requestFor("sess-recoverable"), envWithDb(kv.kv, identity.db), ctx.ctx),
    ).resolves.toBeNull()
    await ctx.settled()

    expect(kv.store.has("auth_session:sess-recoverable")).toBe(true)
    expect(kv.delete).not.toHaveBeenCalled()
    expect(kv.put).not.toHaveBeenCalled()
    expect(backendUnavailableEvent(errorSpy)).toBe(true)
  })

  it("keeps legacy no-D1 authentication and sliding-touch behavior compatible", async () => {
    const legacy = sessionRecord()
    delete legacy.userId
    const kv = makeKV("sess-no-db", legacy)
    const ctx = makeCtx()
    const env = { OPENCLAW_STATE: kv.kv }

    await expect(requireSession(requestFor("sess-no-db"), env, ctx.ctx)).resolves.toEqual({
      sessionId: "sess-no-db",
      record: legacy,
    })
    await ctx.settled()

    expect(kv.put).toHaveBeenCalledOnce()
    expect(kv.delete).not.toHaveBeenCalled()
    expect(kv.store.has("auth_session:sess-no-db")).toBe(true)
  })
})
