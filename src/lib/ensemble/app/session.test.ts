// SIG-304 recall-safety: isDryRunEngineFailure is the shared primitive both headless
// callers (the CLI run-review-in-node + POST /v1/review) use to decide whether a
// dry-run result is an ENGINE FAILURE (→ surface an error) or a legitimately empty
// review (→ clean pass). A reason that means "no verdict produced" must NEVER read as
// clean — the iron rule. NO_VERDICT_FAILURES is derived exhaustively from the
// SkipNoticeReason union so it can't drift; this test pins every reason.
//
// SIG-343: finalize() usage-ledger metering tests. The persistence adapter +
// SLO emitter are mocked to no-op so finalize() is exercisable in isolation;
// appendUsage runs against the real D1 SQLite shim so the ledger path is
// exercised end-to-end.

// vi.mock calls are hoisted by vitest — declare before imports.
import { vi } from "vitest"
vi.mock("@/src/lib/ensemble/adapters/persistence", () => ({
  incrementDailyBudget: vi.fn(async () => {}),
  incrementDailyCostUsd: vi.fn(async () => {}),
  writeTelemetry: vi.fn(async () => {}),
}))
// Keep computeReviewCost real (used inside finalize's cost-accounting try block);
// mock only the emitter that fires console.log side-effects.
vi.mock("@/src/lib/ensemble-slo-telemetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/ensemble-slo-telemetry")>()
  return { ...actual, emitReviewSlo: vi.fn() }
})

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { isDryRunEngineFailure, finalize } from "./session"
import type { EnsembleResult, FinalizeTelemetry } from "./session"
import type { SkipNoticeReason } from "@/src/lib/review-comment-fallback"
import type { Env } from "@/src/shared/types/env"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"

// ── SIG-304 helpers ──────────────────────────────────────────────────────────

const result = (status: string, telemetry: Record<string, unknown>, dryRunReview?: unknown): EnsembleResult =>
  ({ status, telemetry, ...(dryRunReview !== undefined ? { dryRunReview } : {}) }) as unknown as EnsembleResult

const ALL_NO_VERDICT_REASONS: SkipNoticeReason[] = [
  "router_no_specialists",
  "specialists_all_failed",
  "synth_timeout",
  "synth_failed_parse",
  "synth_invalid_provenance",
  "cost_governor_trimmed_all_routable",
  "internal_error",
]

// ── SIG-343 helpers ──────────────────────────────────────────────────────────

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const IMMUTABLE_AUTHOR_MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0029_add_usage_author_github_identity.sql", import.meta.url),
  "utf8",
)

function makeTelemetry(overrides: Partial<FinalizeTelemetry> = {}): FinalizeTelemetry {
  return {
    scmProvider: "github",
    owner: "acme",
    repo: "site",
    prNumber: 7,
    headSha: "sha0001",
    startMs: Date.now(),
    totalMs: 0,
    retrievalCacheStats: null,
    // 100+50+200+75 = 425 total tokens
    tokenUsageByModel: {
      "model-a": { inputTokens: 100, outputTokens: 50 },
      "model-b": { inputTokens: 200, outputTokens: 75 },
    },
    specialistVerdicts: [{ attemptsUsed: 2 }],
    synthesizer: { attemptsUsed: 1 },
    ...overrides,
  }
}

/** Throws on any D1 operation — simulates a binding error for fail-open testing. */
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

async function usageLedgerRowCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM usage_ledger").first<{ n: number }>()
  return row?.n ?? 0
}

// ── SIG-304 tests ────────────────────────────────────────────────────────────

describe("isDryRunEngineFailure (recall-safety)", () => {
  it("an errored run is always a failure", () => {
    expect(isDryRunEngineFailure(result("errored", {}))).toBe(true)
  })

  it.each(ALL_NO_VERDICT_REASONS)("a no-verdict bail (%s) is a failure, never a clean pass", (reason) => {
    expect(isDryRunEngineFailure(result("skipped", { fellBackReason: reason }))).toBe(true)
  })

  it("a produced dryRunReview is never a failure (the engine got a verdict)", () => {
    const review = { verdict: {}, unanchoredFindings: [] }
    expect(isDryRunEngineFailure(result("skipped", { fellBackReason: "synth_timeout" }, review))).toBe(false)
  })

  it("a genuinely empty review (skipped, no failure reason, no verdict) is NOT a failure", () => {
    expect(isDryRunEngineFailure(result("skipped", {}))).toBe(false)
  })
})

// ── SIG-343 tests ────────────────────────────────────────────────────────────

describe("finalize — SIG-343 usage-ledger metering", () => {
  let db: D1Database

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_SQL)
    await applyCostMigrations(db)
    await db.exec(IMMUTABLE_AUTHOR_MIGRATION_SQL)
    vi.clearAllMocks()
  })

  it("inserts one usage_ledger row with correct identity and counts when installationId+repoId are present", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({ installationId: 10, repoId: 200 })

    const res = await finalize(tel, env, "posted", null)

    expect(res.status).toBe("posted")
    expect(await usageLedgerRowCount(db)).toBe(1)

    const row = await db
      .prepare("SELECT installation_id, repo_id, pr_number, head_sha, model_calls, tokens FROM usage_ledger LIMIT 1")
      .first<{
        installation_id: number
        repo_id: number
        pr_number: number
        head_sha: string
        model_calls: number
        tokens: number
      }>()

    expect(row?.installation_id).toBe(10)
    expect(row?.repo_id).toBe(200)
    expect(row?.pr_number).toBe(7)
    expect(row?.head_sha).toBe("sha0001")
    // callsUsed = attemptsUsed(2) + synthesizer.attemptsUsed(1) = 3
    expect(row?.model_calls).toBe(3)
    // tokens = 100 + 50 + 200 + 75 = 425
    expect(row?.tokens).toBe(425)
  })

  it("does NOT insert a row when installationId is absent (headless/CLI dry-run path)", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    // No installationId or repoId → guard skips appendUsage
    const tel = makeTelemetry()

    const res = await finalize(tel, env, "posted", null)

    expect(res.status).toBe("posted")
    expect(await usageLedgerRowCount(db)).toBe(0)
  })

  it("does NOT insert a row when repoId is absent even if installationId is present", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({ installationId: 10 }) // repoId omitted

    const res = await finalize(tel, env, "posted", null)

    expect(res.status).toBe("posted")
    expect(await usageLedgerRowCount(db)).toBe(0)
  })

  it("does NOT write GitHub usage for GitLab even when colliding installation and repo ids are populated", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({ scmProvider: "gitlab", installationId: 10, repoId: 200 })

    const res = await finalize(tel, env, "posted", null)

    expect(res.status).toBe("posted")
    expect(res.telemetry.scmProvider).toBe("gitlab")
    expect(await usageLedgerRowCount(db)).toBe(0)
  })

  it("finalize still returns its normal result when the D1 binding throws (fail-open)", async () => {
    const env = { SIGILIX_PLATFORM_DB: makeBrokenDb() } as unknown as Env
    const tel = makeTelemetry({ installationId: 10, repoId: 200 })

    await expect(finalize(tel, env, "posted", null)).resolves.toMatchObject({ status: "posted" })
  })

  it("finalize threads authorLogin into the usage_ledger row", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({ installationId: 10, repoId: 200, authorLogin: "torvalds" })

    await finalize(tel, env, "posted", null)

    const row = await db
      .prepare("SELECT author_login FROM usage_ledger LIMIT 1")
      .first<{ author_login: string | null }>()
    expect(row?.author_login).toBe("torvalds")
  })

  it("finalize threads immutable GitHub author identity beside the display login", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({
      installationId: 10,
      repoId: 200,
      authorLogin: "torvalds",
      authorGithubUserId: "1024025",
    })

    await finalize(tel, env, "posted", null)

    await expect(
      db.prepare("SELECT author_login, author_github_user_id FROM usage_ledger LIMIT 1").first(),
    ).resolves.toEqual({ author_login: "torvalds", author_github_user_id: "1024025" })
  })

  it("finalize writes NULL author_login when authorLogin is absent from telemetry", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({ installationId: 10, repoId: 200 }) // no authorLogin

    await finalize(tel, env, "posted", null)

    const row = await db
      .prepare("SELECT author_login FROM usage_ledger LIMIT 1")
      .first<{ author_login: string | null }>()
    expect(row?.author_login).toBeNull()
  })

  it("malformed tokenUsageByModel does not throw out of finalize (fail-open try/catch)", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({
      installationId: 10,
      repoId: 200,
      tokenUsageByModel: { broken: null } as unknown as FinalizeTelemetry["tokenUsageByModel"],
    })

    // Must not throw — the outer try/catch in finalize swallows reduce errors
    await expect(finalize(tel, env, "posted", null)).resolves.toMatchObject({ status: "posted" })
    // No row written when reduce fails
    expect(await usageLedgerRowCount(db)).toBe(0)
  })

  it("partially malformed tokenUsageByModel (undefined field) — finite tokens written, good entries summed, undefined clamped to 0", async () => {
    const env = { SIGILIX_PLATFORM_DB: db } as unknown as Env
    const tel = makeTelemetry({
      installationId: 10,
      repoId: 200,
      tokenUsageByModel: {
        good: { inputTokens: 100, outputTokens: 50 },
        bad: { inputTokens: undefined, outputTokens: 5 } as unknown as { inputTokens: number; outputTokens: number },
      } as unknown as FinalizeTelemetry["tokenUsageByModel"],
    })

    const res = await finalize(tel, env, "posted", null)

    // finalize still returns its normal posted result
    expect(res.status).toBe("posted")

    // good: 100+50=150; bad: 0(undefined→0)+5=5; total=155
    const row = await db.prepare("SELECT tokens FROM usage_ledger LIMIT 1").first<{ tokens: number }>()
    expect(row).not.toBeNull()
    expect(Number.isFinite(row?.tokens)).toBe(true)
    expect(row?.tokens).toBe(155)
  })

  it("existing isDryRunEngineFailure tests are unaffected by the new mocks (finalize is not involved in those tests)", () => {
    // Smoke-check: the pure isDryRunEngineFailure function still resolves correctly
    // after the module-level vi.mock additions above.
    expect(isDryRunEngineFailure(result("errored", {}))).toBe(true)
    expect(isDryRunEngineFailure(result("skipped", {}))).toBe(false)
  })
})
