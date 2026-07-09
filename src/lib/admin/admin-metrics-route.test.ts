// sig-admin-metrics — GET /v1/admin/metrics route tests.
//
// Exercises the fail-closed auth gate (unset secret → 503, missing/wrong bearer →
// 401, correct → 200) and the real aggregate shape against an in-memory SQLite
// (d1-sqlite-shim + the real 0001/0004/0006 migrations). Revenue degrades to
// available:false with no Stripe key (never a fabricated MRR).

import { describe, expect, it, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { handleAdminMetricsRoute } from "@/src/lib/admin/admin-metrics-route"
import type { Env } from "@/src/shared/types/env"

const MIG = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), "utf8")
const SECRET = "admin-secret-abc"

async function seededDb(): Promise<D1Database> {
  const db = makeD1()
  await db.exec(MIG("0001_create_tenant_repo_usage.sql"))
  await db.exec(MIG("0004_create_usage_events.sql"))
  await db.exec(MIG("0006_create_user_identity.sql"))

  const now = new Date().toISOString()
  // 2 users
  for (const gh of ["100", "200"]) {
    await db
      .prepare(
        "INSERT INTO user_identity (user_id, github_user_id, providers, created_at, last_login_at) VALUES (?, ?, '[\"github\"]', ?, ?)",
      )
      .bind(`u-${gh}`, gh, now, now)
      .run()
  }
  // 2 tenants (pro + free)
  await db
    .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (1, 'pro', ?, ?)")
    .bind(now, now)
    .run()
  await db
    .prepare("INSERT INTO tenant (installation_id, tier, created_at, updated_at) VALUES (2, 'free', ?, ?)")
    .bind(now, now)
    .run()
  await db
    .prepare("INSERT INTO repo (repo_id, installation_id, full_name, updated_at) VALUES (10, 1, 'o/r', ?)")
    .bind(now)
    .run()
  // 2 PR-review ledger rows, 1500 tokens total, one active author
  await db
    .prepare(
      "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at) VALUES (1, 10, 5, 'aaa', 3, 1000, 'octocat', ?)",
    )
    .bind(now)
    .run()
  await db
    .prepare(
      "INSERT INTO usage_ledger (installation_id, repo_id, pr_number, head_sha, model_calls, tokens, author_login, created_at) VALUES (1, 10, 6, 'bbb', 2, 500, 'octocat', ?)",
    )
    .bind(now)
    .run()
  // usage_events: 1 CLI (coding_agent) + 1 chatbot
  await db
    .prepare(
      "INSERT INTO usage_events (meter, installation_id, user_key, surface, created_at) VALUES ('coding_agent', 0, 'gh:100', 'cli', ?)",
    )
    .bind(now)
    .run()
  await db
    .prepare(
      "INSERT INTO usage_events (meter, installation_id, user_key, surface, created_at) VALUES ('chatbot', 0, 'gh:200', 'portal', ?)",
    )
    .bind(now)
    .run()
  return db
}

function makeEnv(over: Partial<Env>): Env {
  return { ...over } as unknown as Env
}

const req = (auth?: string) =>
  new Request("https://worker/v1/admin/metrics?window=30d", auth ? { headers: { authorization: auth } } : undefined)

describe("GET /v1/admin/metrics — auth (fail-closed)", () => {
  it("503 when ADMIN_API_SECRET is unset (never an open dashboard)", async () => {
    const res = await handleAdminMetricsRoute(req(`Bearer ${SECRET}`), makeEnv({}))
    expect(res.status).toBe(503)
  })

  it("401 when no Authorization header is presented", async () => {
    const res = await handleAdminMetricsRoute(req(), makeEnv({ ADMIN_API_SECRET: SECRET }))
    expect(res.status).toBe(401)
  })

  it("401 when the bearer secret is wrong", async () => {
    const res = await handleAdminMetricsRoute(req("Bearer wrong-secret"), makeEnv({ ADMIN_API_SECRET: SECRET }))
    expect(res.status).toBe(401)
  })
})

describe("GET /v1/admin/metrics — real aggregate shape", () => {
  let db: D1Database
  beforeEach(async () => {
    db = await seededDb()
  })

  it("returns real adoption/usage aggregates for a valid secret", async () => {
    const res = await handleAdminMetricsRoute(
      req(`Bearer ${SECRET}`),
      makeEnv({ ADMIN_API_SECRET: SECRET, SIGILIX_PLATFORM_DB: db }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      adoption: {
        totalUsers: number
        totalOrgs: number
        totalRepos: number
        perPlan: Array<{ tier: string; count: number }>
      }
      usage: { totalReviewTokens: number; prReviews: unknown[]; cli: unknown[]; perModelTokens: null }
      cost: { estimatedInferenceUsd: number; perProvider: null }
      revenue: { available: boolean; mrrUsd: number | null }
      margin: { grossUsd: number | null }
      gaps: string[]
    }
    expect(body.adoption.totalUsers).toBe(2)
    expect(body.adoption.totalOrgs).toBe(2)
    expect(body.adoption.totalRepos).toBe(1)
    expect(body.adoption.perPlan).toEqual(
      expect.arrayContaining([
        { tier: "pro", count: 1 },
        { tier: "free", count: 1 },
      ]),
    )
    expect(body.usage.totalReviewTokens).toBe(1500)
    expect(body.usage.prReviews).toHaveLength(30) // densified 30d series
    expect(body.usage.perModelTokens).toBeNull()
    expect(body.cost.estimatedInferenceUsd).toBeGreaterThan(0)
    expect(body.cost.perProvider).toBeNull()
    // No Stripe key → revenue unavailable (never a wrong MRR), margin null.
    expect(body.revenue.available).toBe(false)
    expect(body.revenue.mrrUsd).toBeNull()
    expect(body.margin.grossUsd).toBeNull()
    // Gaps are explicitly surfaced, not fabricated numbers.
    expect(body.gaps.length).toBeGreaterThan(0)
  })

  it("200 with empty aggregates when no platform DB is bound (never 500)", async () => {
    const res = await handleAdminMetricsRoute(req(`Bearer ${SECRET}`), makeEnv({ ADMIN_API_SECRET: SECRET }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { adoption: { totalUsers: number }; gaps: string[] }
    expect(body.adoption.totalUsers).toBe(0)
    expect(body.gaps.some((g) => g.includes("SIGILIX_PLATFORM_DB"))).toBe(true)
  })

  it("flags a D1 FAULT as a gap (never presents the degraded 0 as a real number)", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 error")
      },
    } as unknown as D1Database
    const res = await handleAdminMetricsRoute(
      req(`Bearer ${SECRET}`),
      makeEnv({ ADMIN_API_SECRET: SECRET, SIGILIX_PLATFORM_DB: brokenDb }),
    )
    expect(res.status).toBe(200) // never 500
    const body = (await res.json()) as { adoption: { totalUsers: number }; gaps: string[] }
    expect(body.adoption.totalUsers).toBe(0)
    expect(body.gaps.some((g) => g.toLowerCase().includes("faulted"))).toBe(true)
  })
})
