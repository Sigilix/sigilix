// sig-cli-cost-report — e2e for POST /v1/usage/report.
//
// Exercises the REAL route (auth → cost compute → late-bind) against a real D1 shim,
// with the gateway's coding_agent append simulated exactly as vertex-chat-route writes
// it (appendUsageEvent, keyed by the CLI's correlation id). The core proof: a reported
// CLI turn lands the right tokens + cost_usd on the EXISTING coding_agent event and does
// NOT add a second event (the count stays 1). The "unkeyed row" + "reverted binding"
// cases show the correlation keying is load-bearing (would fail if reverted).

import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { applyCostMigrations } from "@/src/test-shims/apply-cost-migrations"
import { handleUsageReportRoute } from "@/src/lib/usage-report-route"
import { appendUsageEvent, readUsageEventCount, readUsageEventCostSince } from "@/src/features/tenancy"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { SIGILIX_MODEL_BURN_USD_PER_MTOK } from "@/src/shared/domain/sigilix-model-burn"
import type { Env } from "@/src/shared/types/env"

const M3 = readFileSync(new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url), "utf8")
const M4 = readFileSync(new URL("../../migrations/0004_create_usage_events.sql", import.meta.url), "utf8")

const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException() {} } as unknown as ExecutionContext
const WINDOW = "2000-01-01T00:00:00.000Z"
const API_KEY = "sk-test-cli-key-abc123"
const SEAT = "gh:777" // created_by 777 → the gateway/report seat key

function makeEnv(db: D1Database): Env {
  return { SIGILIX_PLATFORM_DB: db } as unknown as Env
}

/** Insert a live per-tenant api_key row so the bearer resolves to createdBy=777. */
async function seedApiKey(db: D1Database): Promise<void> {
  const keyHash = await sha256Hex(API_KEY)
  await db
    .prepare("INSERT INTO api_key (id, key_hash, installation_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind("key-1", keyHash, 42, "777", new Date().toISOString())
    .run()
}

/** Simulate the gateway's coding_agent append for one CLI request. */
async function gatewayAppend(env: Env, correlationId: string | undefined, userKey = SEAT): Promise<void> {
  await appendUsageEvent(env, {
    meter: "coding_agent",
    installationId: 0,
    userKey,
    surface: "cli",
    eventId: correlationId ?? null,
    nowIso: new Date().toISOString(),
  })
}

function reportReq(body: unknown, key = API_KEY): Request {
  return new Request("https://api.sigilix.ai/v1/usage/report", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /v1/usage/report", () => {
  let db: D1Database
  let env: Env
  beforeEach(async () => {
    db = makeD1()
    await db.exec(M3)
    await db.exec(M4)
    await applyCostMigrations(db)
    await seedApiKey(db)
    env = makeEnv(db)
  })

  it("late-binds tokens+cost onto the gateway's coding_agent event WITHOUT double-counting", async () => {
    const correlationId = "corr-turn-1"
    await gatewayAppend(env, correlationId)

    // Before the report the event exists but carries no cost.
    expect(await readUsageEventCount(env, { meter: "coding_agent", userKey: SEAT, sinceIso: WINDOW })).toEqual({
      ok: true,
      count: 1,
    })
    expect(await readUsageEventCostSince(env, { meter: "coding_agent", userKey: SEAT, sinceIso: WINDOW })).toEqual({
      ok: true,
      costUsd: 0,
    })

    const res = await handleUsageReportRoute(
      reportReq({ correlationId, model: "sigilix/boreas", inputTokens: 100_000, outputTokens: 50_000 }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)

    // Cost bound: 150k tokens × $0.30/MTok = $0.045.
    const expectedCost = (150_000 / 1_000_000) * SIGILIX_MODEL_BURN_USD_PER_MTOK.boreas!
    const cost = await readUsageEventCostSince(env, { meter: "coding_agent", userKey: SEAT, sinceIso: WINDOW })
    expect(cost.ok && cost.costUsd).toBeCloseTo(expectedCost, 9)

    // NO double-count: still exactly ONE coding_agent event (the report UPDATEs, never appends).
    expect(await readUsageEventCount(env, { meter: "coding_agent", userKey: SEAT, sinceIso: WINDOW })).toEqual({
      ok: true,
      count: 1,
    })

    // The tokens column was stamped too.
    const row = await db
      .prepare("SELECT tokens, cost_usd FROM usage_events WHERE meter = ? AND event_id = ?")
      .bind("coding_agent", correlationId)
      .first<{ tokens: number; cost_usd: number }>()
    expect(Number(row?.tokens)).toBe(150_000)
    expect(Number(row?.cost_usd)).toBeCloseTo(expectedCost, 9)
  })

  it("REVERT-PROOF: an event the gateway wrote WITHOUT a correlation id never gets cost bound", async () => {
    // Mirrors the pre-change gateway (no eventId). The report can't key it → stays 0.
    await gatewayAppend(env, undefined)
    const res = await handleUsageReportRoute(
      reportReq({ correlationId: "corr-turn-1", model: "boreas", inputTokens: 100_000, outputTokens: 50_000 }),
      env,
      ctx,
    )
    expect(res.status).toBe(200)
    expect(await readUsageEventCostSince(env, { meter: "coding_agent", userKey: SEAT, sinceIso: WINDOW })).toEqual({
      ok: true,
      costUsd: 0,
    })
  })

  it("is tenant-safe: cannot bind cost onto another seat's event", async () => {
    // A row owned by a DIFFERENT seat, keyed by an id the caller guessed.
    await gatewayAppend(env, "corr-victim", "gh:999")
    const res = await handleUsageReportRoute(
      reportReq({ correlationId: "corr-victim", model: "boreas", inputTokens: 1_000_000, outputTokens: 0 }),
      env,
      ctx,
    )
    expect(res.status).toBe(200) // best-effort → 200, but the foreign row is untouched
    expect(await readUsageEventCostSince(env, { meter: "coding_agent", userKey: "gh:999", sinceIso: WINDOW })).toEqual({
      ok: true,
      costUsd: 0,
    })
  })

  it("rejects an unauthenticated caller (401) before touching the DB", async () => {
    const res = await handleUsageReportRoute(
      reportReq({ correlationId: "x", model: "boreas", inputTokens: 1, outputTokens: 1 }, "wrong-key"),
      env,
      ctx,
    )
    expect(res.status).toBe(401)
  })

  it("400s a body with no correlation id", async () => {
    const res = await handleUsageReportRoute(reportReq({ model: "boreas", inputTokens: 1, outputTokens: 1 }), env, ctx)
    expect(res.status).toBe(400)
  })
})
