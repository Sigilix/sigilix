// SIG-38 Task 3 — checkRateLimit orchestrator unit tests.
//
// TDD red-first: this file is written before the implementation exists.
// Tests cover every mode branch, the bypass/no-author fast-paths, the
// cap+burst boundary, and the D1-fault fail-open contract.
//
// Schema is owned by the migration; exec() applies it per test.
// Pattern mirrors check-shadow-quota.test.ts exactly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { checkRateLimit } from "@/src/features/tenancy/adapters/check-rate-limit"
import { DEFAULT_RATE_LIMIT_CAP } from "@/src/features/tenancy/domain/rate-limit"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)

// ─── env builders ────────────────────────────────────────────────────────────

function makeEnv(
  db: D1Database | undefined,
  mode: string | undefined,
): Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE"> {
  // exactOptionalPropertyTypes: only include optional keys when the value is defined.
  const env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE"> = {
    SIGILIX_PLATFORM_DB: db as D1Database,
  }
  if (mode !== undefined) env.SIGILIX_RATE_LIMIT_MODE = mode
  return env
}

// ─── DB stubs ─────────────────────────────────────────────────────────────────

/** prepare() always throws — readRollingReviewCount catches it → {ok:false}. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
    batch() {
      return Promise.reject(new Error("simulated D1 error"))
    },
    exec() {
      return Promise.reject(new Error("simulated D1 error"))
    },
  } as unknown as D1Database
}

// ─── seed helpers ─────────────────────────────────────────────────────────────

/**
 * Insert one review row for (installationId, authorLogin).
 * `idx` differentiates rows to satisfy the UNIQUE(installation_id, repo_id, pr_number, head_sha) constraint.
 */
async function insertReview(
  db: D1Database,
  installationId: number,
  authorLogin: string,
  idx: number,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(installationId, 100, idx, `sha${idx}`, 1, 100, authorLogin, createdAt)
    .run()
}

/** ISO timestamp `hoursAgo` hours before now — guaranteed inside the 1-hour window. */
function recentIso(hoursAgo = 0.5): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString()
}

// ─── console spies ────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls.map((c) => JSON.parse(c[0] as string))
}

function eventsByName(name: string): Array<Record<string, unknown>> {
  return loggedEvents().filter((e) => e["event"] === name)
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  // ── mode = off ────────────────────────────────────────────────────────────────

  it("mode=off → allowed:true, empty footer, zero console events (no D1 read)", async () => {
    // No DB provided — if D1 were touched, step 6 would log rate-limit-read-failed.
    // Absence of that event (combined with allowed:true) proves the off-path
    // short-circuits before any I/O.
    const decision = await checkRateLimit(makeEnv(undefined, "off"), {
      installationId: 1,
      authorLogin: "alice",
      nowMs: Date.now(),
    })
    expect(decision.allowed).toBe(true)
    expect(decision.footer).toBe("")
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── bypass ────────────────────────────────────────────────────────────────────

  it("bypassReason present → allowed:true, rate-limit-bypass logged, no D1 read", async () => {
    // No DB provided — if D1 were touched, rate-limit-read-failed would appear.
    const decision = await checkRateLimit(makeEnv(undefined, "enforce"), {
      installationId: 2,
      authorLogin: "alice",
      nowMs: Date.now(),
      bypassReason: "manual-rerun",
    })
    expect(decision.allowed).toBe(true)
    const bypasses = eventsByName("rate-limit-bypass")
    expect(bypasses).toHaveLength(1)
    expect(bypasses[0]).toMatchObject({
      event: "rate-limit-bypass",
      installationId: 2,
      bypassReason: "manual-rerun",
    })
    expect(eventsByName("rate-limit-read-failed")).toHaveLength(0)
  })

  // ── no author ─────────────────────────────────────────────────────────────────

  it("authorLogin undefined → allowed:true, rate-limit-no-author logged", async () => {
    const decision = await checkRateLimit(makeEnv(undefined, "shadow"), {
      installationId: 3,
      authorLogin: undefined,
      nowMs: Date.now(),
    })
    expect(decision.allowed).toBe(true)
    const noAuthor = eventsByName("rate-limit-no-author")
    expect(noAuthor).toHaveLength(1)
    expect(noAuthor[0]).toMatchObject({ event: "rate-limit-no-author", installationId: 3 })
    expect(eventsByName("rate-limit-read-failed")).toHaveLength(0)
  })

  // ── shadow mode ───────────────────────────────────────────────────────────────

  it("mode=shadow, used UNDER cap+burst (used=2) → allowed:true, rate-limit-ok", async () => {
    // cap=3, burst=0; used=2 → 2 < 3+0=3 → allowed
    for (let i = 0; i < 2; i++) {
      await insertReview(db, 10, "alice", i, recentIso(0.5))
    }
    const decision = await checkRateLimit(makeEnv(db, "shadow"), {
      installationId: 10,
      authorLogin: "alice",
      nowMs: Date.now(),
    })
    expect(decision.allowed).toBe(true)
    expect(decision.used).toBe(2)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    const ok = eventsByName("rate-limit-ok")
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({ event: "rate-limit-ok", installationId: 10, mode: "shadow", used: 2, cap: 3 })
  })

  it("mode=shadow, used OVER cap+burst (used=3) → allowed:true (shadow never blocks), rate-limit-would-skip, footer + resetMs set", async () => {
    // cap=3, burst=0; used=3 → 3 < 3+0=3 = false → over limit; shadow still allows
    for (let i = 0; i < 3; i++) {
      await insertReview(db, 11, "bob", i, recentIso(0.5))
    }
    const nowMs = Date.now()
    const decision = await checkRateLimit(makeEnv(db, "shadow"), {
      installationId: 11,
      authorLogin: "bob",
      nowMs,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.mode).toBe("shadow")
    expect(decision.used).toBe(3)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBeGreaterThan(0)
    expect(decision.footer).toContain("3 of 3 reviews used")
    expect(decision.footer).toContain("resets in")
    const wouldSkip = eventsByName("rate-limit-would-skip")
    expect(wouldSkip).toHaveLength(1)
    expect(wouldSkip[0]).toMatchObject({ event: "rate-limit-would-skip", installationId: 11, used: 3, cap: 3 })
    expect((wouldSkip[0]?.["resetMs"] as number | undefined) ?? 0).toBeGreaterThan(0)
  })

  // ── enforce mode ──────────────────────────────────────────────────────────────

  it("mode=enforce, used UNDER cap+burst (used=2) → allowed:true", async () => {
    // cap=3, burst=0; used=2 → 2 < 3+0=3 → allowed
    for (let i = 0; i < 2; i++) {
      await insertReview(db, 20, "charlie", i, recentIso(0.5))
    }
    const decision = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 20,
      authorLogin: "charlie",
      nowMs: Date.now(),
    })
    expect(decision.allowed).toBe(true)
    expect(eventsByName("rate-limit-ok")).toHaveLength(1)
    expect(eventsByName("rate-limit-skip")).toHaveLength(0)
  })

  it("mode=enforce, used OVER cap+burst (used=3) → allowed:false, rate-limit-skip, resetMs>0, footer set", async () => {
    // cap=3, burst=0; used=3 → 3 < 3+0=3 = false → denied
    for (let i = 0; i < 3; i++) {
      await insertReview(db, 21, "dave", i, recentIso(0.5))
    }
    const nowMs = Date.now()
    const decision = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 21,
      authorLogin: "dave",
      nowMs,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.mode).toBe("enforce")
    expect(decision.used).toBe(3)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBeGreaterThan(0)
    expect(decision.footer).toContain("3 of 3 reviews used")
    expect(decision.footer).toContain("resets in")
    const skip = eventsByName("rate-limit-skip")
    expect(skip).toHaveLength(1)
    expect(skip[0]).toMatchObject({ event: "rate-limit-skip", installationId: 21, used: 3, cap: 3 })
    expect((skip[0]?.["resetMs"] as number | undefined) ?? 0).toBeGreaterThan(0)
  })

  // ── D1 fault ──────────────────────────────────────────────────────────────────

  it("D1 fault (broken-db stub) → allowed:true (fail-open), rate-limit-read-failed, no throw", async () => {
    await expect(
      checkRateLimit(makeEnv(makeBrokenDb(), "enforce"), {
        installationId: 30,
        authorLogin: "eve",
        nowMs: Date.now(),
      }),
    ).resolves.toMatchObject({ allowed: true })

    const failed = eventsByName("rate-limit-read-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ event: "rate-limit-read-failed", installationId: 30, mode: "enforce" })
  })

  // ── cap + burst boundary ──────────────────────────────────────────────────────

  it("cap=3 burst=0 boundary: used=2 → allowed; used=3 → denied (enforce)", async () => {
    // Part A: used=2 → 2 < cap+burst=3+0=3 → allowed
    for (let i = 0; i < 2; i++) {
      await insertReview(db, 40, "frank", i, recentIso(0.5))
    }
    const d2 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 40,
      authorLogin: "frank",
      nowMs: Date.now(),
    })
    expect(d2.allowed).toBe(true)
    expect(d2.used).toBe(2)

    // Part B: used=3 → 3 < 3 = false → denied
    for (let i = 0; i < 3; i++) {
      await insertReview(db, 41, "frank", i, recentIso(0.5))
    }
    const d3 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 41,
      authorLogin: "frank",
      nowMs: Date.now(),
    })
    expect(d3.allowed).toBe(false)
    expect(d3.used).toBe(3)
  })
})
