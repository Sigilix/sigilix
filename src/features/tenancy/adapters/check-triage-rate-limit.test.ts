// SIG-38 free-launch caps — checkTriageRateLimit orchestrator unit tests.
//
// Pattern mirrors check-rate-limit.test.ts (the PR-review orchestrator's
// suite) exactly, adapted for the team_id-keyed triage_usage_ledger.
//
// Schema is owned by the migration; exec() applies it per test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { checkTriageRateLimit } from "@/src/features/tenancy/adapters/check-triage-rate-limit"
import { DEFAULT_TRIAGE_RATE_LIMIT_CAP } from "@/src/features/tenancy/domain/rate-limit"
import type { Env } from "@/src/shared/types/env"

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0002_create_triage_usage_ledger.sql", import.meta.url),
  "utf8",
)

// ─── env builders ────────────────────────────────────────────────────────────

function makeEnv(
  db: D1Database | undefined,
  mode: string | undefined,
): Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE"> {
  const env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE"> = {
    SIGILIX_PLATFORM_DB: db as D1Database,
  }
  if (mode !== undefined) env.SIGILIX_RATE_LIMIT_MODE = mode
  return env
}

// ─── DB stubs ─────────────────────────────────────────────────────────────────

/** prepare() always throws — readRollingTriageCount catches it → {ok:false}. */
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

const NOW = 1_750_000_000_000

/** Insert one triage row for teamId. `idx` differentiates issue_id to satisfy UNIQUE(team_id, issue_id). */
async function insertTriage(db: D1Database, teamId: string, idx: number, createdAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO triage_usage_ledger (team_id, issue_id, created_at) VALUES (?, ?, ?)")
    .bind(teamId, `issue-${idx}`, createdAt)
    .run()
}

/** ISO timestamp `hoursAgo` hours before NOW — deterministic, no Date.now() drift. */
function recentIso(hoursAgo = 0.5): string {
  return new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString()
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

describe("checkTriageRateLimit", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
  })

  // ── mode = off ────────────────────────────────────────────────────────────────

  it("mode=off → allowed:true, zero console events (no D1 read)", async () => {
    const decision = await checkTriageRateLimit(makeEnv(makeBrokenDb(), "off"), {
      teamId: "team-1",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── no team ───────────────────────────────────────────────────────────────────

  it("teamId undefined → allowed:true, triage-rate-limit-no-team logged", async () => {
    const decision = await checkTriageRateLimit(makeEnv(makeBrokenDb(), "shadow"), {
      teamId: undefined,
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(eventsByName("triage-rate-limit-no-team")).toHaveLength(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── shadow mode ───────────────────────────────────────────────────────────────

  it("mode=shadow, used UNDER cap+burst (used=2) → allowed:true, triage-rate-limit-ok", async () => {
    // cap=3, burst=0; used=2 → 2 < 3+0=3 → allowed
    for (let i = 0; i < 2; i++) {
      await insertTriage(db, "team-10", i, recentIso(0.5))
    }
    const decision = await checkTriageRateLimit(makeEnv(db, "shadow"), { teamId: "team-10", nowMs: NOW })
    expect(decision.allowed).toBe(true)
    expect(decision.used).toBe(2)
    expect(decision.cap).toBe(DEFAULT_TRIAGE_RATE_LIMIT_CAP)
    const ok = eventsByName("triage-rate-limit-ok")
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({ event: "triage-rate-limit-ok", teamId: "team-10", mode: "shadow", used: 2, cap: 3 })
  })

  it("mode=shadow, used OVER cap+burst (used=3) → allowed:true (shadow never blocks), triage-rate-limit-would-skip", async () => {
    // cap=3, burst=0; used=3 → 3 < 3+0=3 = false → over limit; shadow still allows
    for (let i = 0; i < 3; i++) {
      await insertTriage(db, "team-11", i, recentIso(0.5))
    }
    // rows seeded at NOW-1800000 (30min ago); resetMs = (NOW-1800000)+18000000-NOW = 16200000
    const decision = await checkTriageRateLimit(makeEnv(db, "shadow"), { teamId: "team-11", nowMs: NOW })
    expect(decision.allowed).toBe(true)
    expect(decision.mode).toBe("shadow")
    expect(decision.used).toBe(3)
    expect(decision.cap).toBe(DEFAULT_TRIAGE_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBe(16_200_000)
    const wouldSkip = eventsByName("triage-rate-limit-would-skip")
    expect(wouldSkip).toHaveLength(1)
    expect(wouldSkip[0]).toMatchObject({ event: "triage-rate-limit-would-skip", teamId: "team-11", used: 3, cap: 3 })
  })

  // ── enforce mode ──────────────────────────────────────────────────────────────

  it("mode=enforce, used UNDER cap+burst (used=2) → allowed:true", async () => {
    for (let i = 0; i < 2; i++) {
      await insertTriage(db, "team-20", i, recentIso(0.5))
    }
    const decision = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-20", nowMs: NOW })
    expect(decision.allowed).toBe(true)
    expect(eventsByName("triage-rate-limit-ok")).toHaveLength(1)
    expect(eventsByName("triage-rate-limit-skip")).toHaveLength(0)
  })

  it("mode=enforce, used OVER cap+burst (used=3) → allowed:false, triage-rate-limit-skip, resetMs>0", async () => {
    for (let i = 0; i < 3; i++) {
      await insertTriage(db, "team-21", i, recentIso(0.5))
    }
    const decision = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-21", nowMs: NOW })
    expect(decision.allowed).toBe(false)
    expect(decision.mode).toBe("enforce")
    expect(decision.used).toBe(3)
    expect(decision.cap).toBe(DEFAULT_TRIAGE_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBe(16_200_000)
    const skip = eventsByName("triage-rate-limit-skip")
    expect(skip).toHaveLength(1)
    expect(skip[0]).toMatchObject({ event: "triage-rate-limit-skip", teamId: "team-21", used: 3, cap: 3 })
  })

  // ── D1 fault ──────────────────────────────────────────────────────────────────

  it("D1 fault (broken-db stub) → allowed:true (fail-open), triage-rate-limit-read-failed, no throw", async () => {
    await expect(
      checkTriageRateLimit(makeEnv(makeBrokenDb(), "enforce"), { teamId: "team-30", nowMs: NOW }),
    ).resolves.toMatchObject({ allowed: true })

    const failed = eventsByName("triage-rate-limit-read-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ event: "triage-rate-limit-read-failed", teamId: "team-30", mode: "enforce" })
  })

  // ── cap + burst boundary ──────────────────────────────────────────────────────

  it("cap=3 burst=0 boundary: used=2 → allowed; used=3 → denied (enforce)", async () => {
    for (let i = 0; i < 2; i++) {
      await insertTriage(db, "team-40", i, recentIso(0.5))
    }
    const d2 = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-40", nowMs: NOW })
    expect(d2.allowed).toBe(true)
    expect(d2.used).toBe(2)

    for (let i = 0; i < 3; i++) {
      await insertTriage(db, "team-41", i, recentIso(0.5))
    }
    const d3 = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-41", nowMs: NOW })
    expect(d3.allowed).toBe(false)
    expect(d3.used).toBe(3)
  })

  // ── window roll (5h) ──────────────────────────────────────────────────────────

  it("a triage just OUTSIDE the 5h window does not count; one just INSIDE does", async () => {
    await insertTriage(db, "team-50", 0, recentIso(5 + 1 / 3600))
    const outside = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-50", nowMs: NOW })
    expect(outside.used).toBe(0)

    await insertTriage(db, "team-50", 1, recentIso(5 - 1 / 3600))
    const inside = await checkTriageRateLimit(makeEnv(db, "enforce"), { teamId: "team-50", nowMs: NOW })
    expect(inside.used).toBe(1)
  })
})
