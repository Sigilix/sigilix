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
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
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
 * Fixed epoch ms — pinned so every time-dependent test uses the same reference
 * point, eliminating Date.now() drift between insertReview() and checkRateLimit().
 * Chosen as a round number well inside the valid Date range.
 */
const NOW = 1_750_000_000_000

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

describe("checkRateLimit", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  // ── mode = off ────────────────────────────────────────────────────────────────

  it("mode=off → allowed:true, empty footer, zero console events (no D1 read)", async () => {
    // Tripwire: a broken DB (prepare throws) is passed so that if D1 is ever
    // touched in this path, console.warn fires and the warnSpy assertion below
    // catches it — proving mode=off short-circuits before any I/O.
    const decision = await checkRateLimit(makeEnv(makeBrokenDb(), "off"), {
      installationId: 1,
      authorLogin: "alice",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.footer).toBe("")
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── bypass ────────────────────────────────────────────────────────────────────

  it("bypassReason present → allowed:true, rate-limit-bypass logged, no D1 read", async () => {
    // Tripwire: broken DB ensures any D1 touch would fire console.warn.
    const decision = await checkRateLimit(makeEnv(makeBrokenDb(), "enforce"), {
      installationId: 2,
      authorLogin: "alice",
      nowMs: NOW,
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
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── no author ─────────────────────────────────────────────────────────────────

  it("authorLogin undefined → allowed:true, rate-limit-no-author logged", async () => {
    // Tripwire: broken DB ensures any D1 touch would fire console.warn.
    const decision = await checkRateLimit(makeEnv(makeBrokenDb(), "shadow"), {
      installationId: 3,
      authorLogin: undefined,
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    const noAuthor = eventsByName("rate-limit-no-author")
    expect(noAuthor).toHaveLength(1)
    expect(noAuthor[0]).toMatchObject({ event: "rate-limit-no-author", installationId: 3 })
    expect(eventsByName("rate-limit-read-failed")).toHaveLength(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  // ── shadow mode ───────────────────────────────────────────────────────────────

  it("mode=shadow, used UNDER cap+burst (used=1) → allowed:true, rate-limit-ok", async () => {
    // burst=0; used=1 → 1 < cap+0 → allowed
    for (let i = 0; i < 1; i++) {
      await insertReview(db, 10, "alice", i, recentIso(0.5))
    }
    const decision = await checkRateLimit(makeEnv(db, "shadow"), {
      installationId: 10,
      authorLogin: "alice",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.used).toBe(1)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    const ok = eventsByName("rate-limit-ok")
    expect(ok).toHaveLength(1)
    expect(ok[0]).toMatchObject({
      event: "rate-limit-ok",
      installationId: 10,
      mode: "shadow",
      used: 1,
      cap: DEFAULT_RATE_LIMIT_CAP,
    })
  })

  it("mode=shadow, used AT cap+burst → allowed:true (shadow never blocks), rate-limit-would-skip, footer + resetMs set", async () => {
    // burst=0; used=cap → used < cap+0 = false → over limit; shadow still allows.
    // Seeded relative to the cap so a product retune of the ladder can't rot this test.
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CAP; i++) {
      await insertReview(db, 11, "bob", i, recentIso(0.5))
    }
    // rows seeded at NOW-1800000 (30min ago); resetMs = (NOW-1800000)+18000000-NOW = 16200000
    const decision = await checkRateLimit(makeEnv(db, "shadow"), {
      installationId: 11,
      authorLogin: "bob",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.mode).toBe("shadow")
    expect(decision.used).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBe(16_200_000)
    expect(decision.footer).toContain(`${DEFAULT_RATE_LIMIT_CAP} of ${DEFAULT_RATE_LIMIT_CAP} reviews used`)
    expect(decision.footer).toContain("resets in")
    const wouldSkip = eventsByName("rate-limit-would-skip")
    expect(wouldSkip).toHaveLength(1)
    expect(wouldSkip[0]).toMatchObject({
      event: "rate-limit-would-skip",
      installationId: 11,
      used: DEFAULT_RATE_LIMIT_CAP,
      cap: DEFAULT_RATE_LIMIT_CAP,
    })
    expect((wouldSkip[0]?.["resetMs"] as number | undefined) ?? 0).toBe(16_200_000)
  })

  // ── enforce mode ──────────────────────────────────────────────────────────────

  it("mode=enforce, used UNDER cap+burst (used=1) → allowed:true", async () => {
    // cap=2, burst=0; used=1 → 1 < 2+0=2 → allowed
    for (let i = 0; i < 1; i++) {
      await insertReview(db, 20, "charlie", i, recentIso(0.5))
    }
    const decision = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 20,
      authorLogin: "charlie",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(true)
    expect(eventsByName("rate-limit-ok")).toHaveLength(1)
    expect(eventsByName("rate-limit-skip")).toHaveLength(0)
  })

  it("mode=enforce, used AT cap+burst → allowed:false, rate-limit-skip, resetMs>0, footer set", async () => {
    // burst=0; used=cap → used < cap+0 = false → denied
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CAP; i++) {
      await insertReview(db, 21, "dave", i, recentIso(0.5))
    }
    // rows seeded at NOW-1800000 (30min ago); resetMs = (NOW-1800000)+18000000-NOW = 16200000
    const decision = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 21,
      authorLogin: "dave",
      nowMs: NOW,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.mode).toBe("enforce")
    expect(decision.used).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(decision.resetMs).toBe(16_200_000)
    expect(decision.footer).toContain(`${DEFAULT_RATE_LIMIT_CAP} of ${DEFAULT_RATE_LIMIT_CAP} reviews used`)
    expect(decision.footer).toContain("resets in")
    const skip = eventsByName("rate-limit-skip")
    expect(skip).toHaveLength(1)
    expect(skip[0]).toMatchObject({
      event: "rate-limit-skip",
      installationId: 21,
      used: DEFAULT_RATE_LIMIT_CAP,
      cap: DEFAULT_RATE_LIMIT_CAP,
    })
    expect((skip[0]?.["resetMs"] as number | undefined) ?? 0).toBe(16_200_000)
  })

  // ── D1 fault ──────────────────────────────────────────────────────────────────

  it("D1 fault (broken-db stub) → allowed:true (fail-open), rate-limit-read-failed, no throw", async () => {
    await expect(
      checkRateLimit(makeEnv(makeBrokenDb(), "enforce"), {
        installationId: 30,
        authorLogin: "eve",
        nowMs: NOW,
      }),
    ).resolves.toMatchObject({ allowed: true })

    const failed = eventsByName("rate-limit-read-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ event: "rate-limit-read-failed", installationId: 30, mode: "enforce" })
  })

  // ── cap + burst boundary ──────────────────────────────────────────────────────

  it("cap=2 burst=0 boundary: used=1 → allowed; used=2 → denied (enforce)", async () => {
    // Part A: used=1 → 1 < cap+burst=2+0=2 → allowed
    for (let i = 0; i < 1; i++) {
      await insertReview(db, 40, "frank", i, recentIso(0.5))
    }
    const d2 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 40,
      authorLogin: "frank",
      nowMs: NOW,
    })
    expect(d2.allowed).toBe(true)
    expect(d2.used).toBe(1)

    // Part B: used=cap → used < cap = false → denied
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CAP; i++) {
      await insertReview(db, 41, "frank", i, recentIso(0.5))
    }
    const d3 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 41,
      authorLogin: "frank",
      nowMs: NOW,
    })
    expect(d3.allowed).toBe(false)
    expect(d3.used).toBe(DEFAULT_RATE_LIMIT_CAP)
  })

  // ── window roll (5h retune) ───────────────────────────────────────────────────

  it("a review just OUTSIDE the 5h window does not count; one just INSIDE does (window rolls correctly)", async () => {
    // Review at 5h + 1s old — strictly outside the 5h window — must not count.
    await insertReview(db, 60, "grace", 0, recentIso(5 + 1 / 3600))
    const outside = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 60,
      authorLogin: "grace",
      nowMs: NOW,
    })
    expect(outside.used).toBe(0)
    expect(outside.allowed).toBe(true)

    // A second review at 5h - 1s old — just inside the window — must count
    // (used=1, still under cap=2 → allowed). The first row stays excluded
    // (it ages out at exactly 5h), so this proves the window boundary itself
    // rolls correctly, independent of the cap boundary covered above.
    await insertReview(db, 60, "grace", 1, recentIso(5 - 1 / 3600))
    const inside = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 60,
      authorLogin: "grace",
      nowMs: NOW,
    })
    expect(inside.used).toBe(1)
    expect(inside.allowed).toBe(true)
  })

  // ── tier seam ─────────────────────────────────────────────────────────────────

  it("tier=pro → cap=20; used=19 → allowed, used=20 → denied (enforce)", async () => {
    // Exercises resolveRateLimitCap("pro") = 20 through the full orchestrator path.
    // Part A: 19 reviews under the pro cap → allowed.
    for (let i = 0; i < 19; i++) {
      await insertReview(db, 50, "grace", i, recentIso(0.5))
    }
    const d4 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 50,
      authorLogin: "grace",
      nowMs: NOW,
      tier: "pro",
    })
    expect(d4.cap).toBe(20)
    expect(d4.allowed).toBe(true)
    expect(d4.used).toBe(19)

    // Part B: 20 reviews at the pro cap → denied (20 < 20 = false).
    for (let i = 0; i < 20; i++) {
      await insertReview(db, 51, "grace", i, recentIso(0.5))
    }
    const d5 = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 51,
      authorLogin: "grace",
      nowMs: NOW,
      tier: "pro",
    })
    expect(d5.cap).toBe(20)
    expect(d5.allowed).toBe(false)
    expect(d5.used).toBe(20)
  })

  // ── trial cap seam (sig-trial-cap) ──────────────────────────────────────────

  it("tier=pro trialing → HALF cap=10 (full pro is 20); active → full cap=20 restored", async () => {
    // Trialing pro: cap halved to 10. 10 reviews at the trial cap → denied (10 < 10 = false).
    for (let i = 0; i < 10; i++) {
      await insertReview(db, 52, "heidi", i, recentIso(0.5))
    }
    const trial = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 52,
      authorLogin: "heidi",
      nowMs: NOW,
      tier: "pro",
      trialing: true,
    })
    expect(trial.cap).toBe(10)
    expect(trial.allowed).toBe(false)
    expect(trial.used).toBe(10)

    // Same tenant, same 10 reviews, but now ACTIVE (trial converted) → full pro cap 20,
    // and 10 < 20 → allowed. Proves converting restores the full volume, no lingering half.
    const active = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 52,
      authorLogin: "heidi",
      nowMs: NOW,
      tier: "pro",
      trialing: false,
    })
    expect(active.cap).toBe(20)
    expect(active.allowed).toBe(true)
    expect(active.used).toBe(10)
  })

  it("tier=teams → active cap=40 (2× pro); trialing → half cap=20", async () => {
    const active = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 55,
      authorLogin: "judy",
      nowMs: NOW,
      tier: "teams",
      trialing: false,
    })
    expect(active.cap).toBe(40)
    expect(active.allowed).toBe(true)

    const trial = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 56,
      authorLogin: "judy",
      nowMs: NOW,
      tier: "teams",
      trialing: true,
    })
    expect(trial.cap).toBe(20)
  })

  it("a Pro trial's halved cap (10) is still ≥ the Free cap (8) — a trial is never worse than Free", async () => {
    const proTrial = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 53,
      authorLogin: "ivan",
      nowMs: NOW,
      tier: "pro",
      trialing: true,
    })
    const free = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 54,
      authorLogin: "ivan",
      nowMs: NOW,
      tier: "free",
    })
    expect(proTrial.cap).toBeGreaterThanOrEqual(free.cap)
    expect(proTrial.cap).toBe(10)
    expect(free.cap).toBe(DEFAULT_RATE_LIMIT_CAP)
  })
})

// ─── cost-based enforcement (sig-cost-based-metering) ─────────────────────────

/** Insert one review row carrying an explicit `cost_usd` (blended model spend). */
async function insertReviewWithCost(
  db: D1Database,
  installationId: number,
  authorLogin: string,
  idx: number,
  costUsd: number,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, cost_usd, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(installationId, 100, idx, `sha${idx}`, 1, 100, costUsd, authorLogin, createdAt)
    .run()
}

describe("checkRateLimit — cost budget", () => {
  let db: D1Database
  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
  })

  it("blocks on COST while still UNDER the count cap (cost is the primary dimension)", async () => {
    // Pro: count cap 5, session cost budget $3.75. Two reviews at $2 each = $4 ≥ $3.75,
    // but only 2 of 5 reviews used → the count cap is NOT hit. Cost binds first.
    await insertReviewWithCost(db, 70, "mallory", 1, 2.0, recentIso())
    await insertReviewWithCost(db, 70, "mallory", 2, 2.0, recentIso())
    const d = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 70,
      authorLogin: "mallory",
      nowMs: NOW,
      tier: "pro",
      trialing: false,
    })
    expect(d.used).toBe(2)
    expect(d.used).toBeLessThan(d.cap) // under the COUNT cap
    expect(d.usedCostUsd).toBeCloseTo(4.0, 6)
    expect(d.costBudgetUsd).toBeCloseTo(3.75, 6)
    expect(d.allowed).toBe(false) // …yet blocked, on COST
  })

  it("a big-cost request consumes proportionally more budget than a small one", async () => {
    await insertReviewWithCost(db, 71, "big", 1, 3.0, recentIso())
    await insertReviewWithCost(db, 72, "small", 1, 0.1, recentIso())
    const big = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 71,
      authorLogin: "big",
      nowMs: NOW,
      tier: "pro",
    })
    const small = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 72,
      authorLogin: "small",
      nowMs: NOW,
      tier: "pro",
    })
    // Same ONE review each, but the big one has drained far more of the same budget.
    expect(big.usedCostUsd).toBeGreaterThan(small.usedCostUsd)
    expect(big.costRemainingUsd!).toBeLessThan(small.costRemainingUsd!)
  })

  it("enterprise has an UNBOUNDED cost budget → never blocked on cost", async () => {
    // Way past any dollar figure, but enterprise budget is null (unbounded).
    for (let i = 1; i <= 6; i++) await insertReviewWithCost(db, 73, "ent", i, 100.0, recentIso())
    const d = await checkRateLimit(makeEnv(db, "enforce"), {
      installationId: 73,
      authorLogin: "ent",
      nowMs: NOW,
      tier: "enterprise",
    })
    expect(d.costBudgetUsd).toBeNull()
    expect(d.costRemainingUsd).toBeNull()
    expect(d.usedCostUsd).toBeCloseTo(600, 6)
    expect(d.allowed).toBe(true) // count cap for enterprise is 500 — 6 is trivially under it
  })

  it("shadow mode never blocks even when the cost budget is exceeded", async () => {
    await insertReviewWithCost(db, 74, "shadow", 1, 10.0, recentIso())
    const d = await checkRateLimit(makeEnv(db, "shadow"), {
      installationId: 74,
      authorLogin: "shadow",
      nowMs: NOW,
      tier: "pro",
    })
    expect(d.usedCostUsd).toBeCloseTo(10.0, 6)
    expect(d.allowed).toBe(true) // shadow observes, never blocks
  })
})
