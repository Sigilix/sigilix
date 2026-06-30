// SIG-38 free-launch caps — cross-cutting integration test proving the
// PR-review rate-limit cap and the Linear-triage rate-limit cap are fully
// INDEPENDENT: hitting one cap's ledger never affects the other's count, even
// though both are gated by the SAME `SIGILIX_RATE_LIMIT_MODE` flag and run
// against the same D1 binding. Genuinely cross-module (spans
// `check-rate-limit.ts` + `check-triage-rate-limit.ts` + both migrations), so
// it lives in e2e/ per COMPLIANCE §5 rather than beside a single adapter.

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { checkRateLimit } from "@/src/features/tenancy/adapters/check-rate-limit"
import { checkTriageRateLimit } from "@/src/features/tenancy/adapters/check-triage-rate-limit"
import { DEFAULT_RATE_LIMIT_CAP, DEFAULT_TRIAGE_RATE_LIMIT_CAP } from "@/src/features/tenancy/domain/rate-limit"
import type { Env } from "@/src/shared/types/env"

const REPO_ROOT = resolve(__dirname, "..")
const PR_MIGRATION_SQL = readFileSync(resolve(REPO_ROOT, "migrations/0001_create_tenant_repo_usage.sql"), "utf8")
const TRIAGE_MIGRATION_SQL = readFileSync(resolve(REPO_ROOT, "migrations/0002_create_triage_usage_ledger.sql"), "utf8")

const NOW = 1_750_000_000_000

async function insertReview(db: D1Database, installationId: number, idx: number, createdAt: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO usage_ledger" +
        " (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(installationId, 100, idx, `sha${idx}`, 1, 100, "alice", createdAt)
    .run()
}

async function insertTriage(db: D1Database, teamId: string, idx: number, createdAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO triage_usage_ledger (team_id, issue_id, created_at) VALUES (?, ?, ?)")
    .bind(teamId, `issue-${idx}`, createdAt)
    .run()
}

function recentIso(hoursAgo = 0.5): string {
  return new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString()
}

describe("PR-review rate-limit cap vs Linear-triage rate-limit cap — independence", () => {
  let db: D1Database
  let env: Pick<Env, "SIGILIX_PLATFORM_DB" | "SIGILIX_RATE_LIMIT_MODE">

  beforeEach(async () => {
    db = makeD1()
    await db.exec(PR_MIGRATION_SQL)
    await db.exec(TRIAGE_MIGRATION_SQL)
    env = { SIGILIX_PLATFORM_DB: db, SIGILIX_RATE_LIMIT_MODE: "enforce" }
  })

  it("maxing out the PR-review cap does NOT consume the Linear-triage budget", async () => {
    // Saturate the PR cap (DEFAULT_RATE_LIMIT_CAP = 2) for installation 99 / alice.
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CAP; i++) {
      await insertReview(db, 99, i, recentIso(0.5))
    }
    const prDecision = await checkRateLimit(env, { installationId: 99, authorLogin: "alice", nowMs: NOW })
    expect(prDecision.allowed).toBe(false) // PR cap is exhausted.

    // The Linear-triage cap for ANY team — including one keyed the same way —
    // must read zero usage; it only ever reads triage_usage_ledger.
    const triageDecision = await checkTriageRateLimit(env, { teamId: "team-99", nowMs: NOW })
    expect(triageDecision.used).toBe(0)
    expect(triageDecision.allowed).toBe(true)
  })

  it("maxing out the Linear-triage cap does NOT consume the PR-review budget", async () => {
    // Saturate the triage cap (DEFAULT_TRIAGE_RATE_LIMIT_CAP = 3) for team-77.
    for (let i = 0; i < DEFAULT_TRIAGE_RATE_LIMIT_CAP; i++) {
      await insertTriage(db, "team-77", i, recentIso(0.5))
    }
    const triageDecision = await checkTriageRateLimit(env, { teamId: "team-77", nowMs: NOW })
    expect(triageDecision.allowed).toBe(false) // Triage cap is exhausted.

    // The PR-review cap for installation 77 / alice must read zero usage; it
    // only ever reads usage_ledger.
    const prDecision = await checkRateLimit(env, { installationId: 77, authorLogin: "alice", nowMs: NOW })
    expect(prDecision.used).toBe(0)
    expect(prDecision.allowed).toBe(true)
  })

  it("both caps share the SAME SIGILIX_RATE_LIMIT_MODE flag but enforce independently", async () => {
    // Exhaust BOTH caps under the same shared mode flag; each must deny on
    // its own terms without one decision leaking into the other's numbers.
    for (let i = 0; i < DEFAULT_RATE_LIMIT_CAP; i++) await insertReview(db, 5, i, recentIso(0.5))
    for (let i = 0; i < DEFAULT_TRIAGE_RATE_LIMIT_CAP; i++) await insertTriage(db, "team-5", i, recentIso(0.5))

    const prDecision = await checkRateLimit(env, { installationId: 5, authorLogin: "alice", nowMs: NOW })
    const triageDecision = await checkTriageRateLimit(env, { teamId: "team-5", nowMs: NOW })

    expect(prDecision.mode).toBe("enforce")
    expect(triageDecision.mode).toBe("enforce")
    expect(prDecision.allowed).toBe(false)
    expect(triageDecision.allowed).toBe(false)
    expect(prDecision.used).toBe(DEFAULT_RATE_LIMIT_CAP)
    expect(triageDecision.used).toBe(DEFAULT_TRIAGE_RATE_LIMIT_CAP)
  })
})
