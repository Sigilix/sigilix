// SIG-347 (SIG-166 AC #4) — GET /metrics/test-suppressions: auth, window
// parsing, and the tests-gate per-reason suppression-rate projection.

import { describe, expect, it } from "vitest"
import { handleTestSuppressionsMetricsRoute } from "../src/lib/metrics-test-suppressions-route"
import { ValidationMetricsDO } from "../src/do/validation-metrics"
import type { Env } from "../src/shared/types/env"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo() {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T { return sqlStorage.transactionSync(fn) },
      async get(): Promise<unknown> { return undefined },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> { return false },
      async setAlarm(t: number): Promise<void> { alarmAt = t },
      async getAlarm(): Promise<number | null> { return alarmAt },
      async deleteAlarm(): Promise<void> { alarmAt = null },
    },
    id: { toString: () => "global", name: "global" },
  }
  return new ValidationMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: Partial<Env> = {}, doInstance = makeDo()): Env {
  const ns = {
    idFromName: (_: string) => "id",
    get: (_: unknown) => doInstance,
  }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    VALIDATION_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)

interface SuppressionBody {
  window: { days: number }
  mode: string
  reasons: Record<string, { wouldDrop: number; kept: number; suppressionRate: number }>
  byCategory: Record<string, { wouldDrop: number; kept: number; suppressionRate: number }>
  totals: { wouldDrop: number; kept: number; suppressionRate: number }
}

describe("handleTestSuppressionsMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(503)
  })

  it("401 when the bearer token is missing or wrong", async () => {
    const env = makeEnv()
    expect((await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions"), env)).status).toBe(401)
    expect((await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions", "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an invalid window param", async () => {
    const env = makeEnv()
    const res = await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions?window=99", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(400)
  })

  it("accepts the max window (30d) and rejects max+1 — pins the cap (mirrors /metrics/validation)", async () => {
    const env = makeEnv()
    expect((await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions?window=30", `Bearer ${TOKEN}`), env)).status).toBe(200)
    expect((await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions?window=31", `Bearer ${TOKEN}`), env)).status).toBe(400)
  })

  it("200 projects only the tests gate, per reason, with suppression rates", async () => {
    const do_ = makeDo()
    await do_.recordBatch({
      owner: "o", repo: "r", prNumber: 1, headSha: "abc",
      events: [
        { kind: "gate-rejection", gate: "tests", reason: "cross-referenced-in-sibling-test", dropped: true, category: "testing" },
        { kind: "gate-rejection", gate: "tests", reason: "vague-insufficient-test", dropped: false, category: "testing" },
        // a non-tests gate event must be excluded from this projection
        { kind: "gate-rejection", gate: "security", reason: "fabricated-evidence-id", dropped: true, category: "security" },
      ],
    })
    const env = makeEnv({ OPENCLAW_TESTS_VALIDATOR_MODE: "enforce" }, do_)
    const res = await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions?window=14d", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = await res.json() as SuppressionBody
    expect(body.window.days).toBe(14)
    expect(body.mode).toBe("enforce")
    // enforce drop → wouldDrop 1, kept 0, rate 1; shadow → wouldDrop 1, kept 1, rate 0.5
    expect(body.reasons["cross-referenced-in-sibling-test"]).toEqual({ wouldDrop: 1, kept: 0, suppressionRate: 1 })
    expect(body.reasons["vague-insufficient-test"]).toEqual({ wouldDrop: 1, kept: 1, suppressionRate: 0.5 })
    expect(body.reasons["fabricated-evidence-id"]).toBeUndefined() // security gate not projected
    expect(body.byCategory.testing.wouldDrop).toBe(2)
    expect(body.byCategory.testing.kept).toBe(1)
    expect(body.totals.wouldDrop).toBe(2)
    expect(body.totals.kept).toBe(1)
    expect(body.totals.suppressionRate).toBeCloseTo(0.6667, 4)
  })

  it("200 with an empty window: zero totals, no reasons", async () => {
    const env = makeEnv()
    const res = await handleTestSuppressionsMetricsRoute(get("https://x/metrics/test-suppressions", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = await res.json() as SuppressionBody
    expect(body.window.days).toBe(7)
    expect(body.mode).toBe("shadow")
    expect(body.reasons).toEqual({})
    expect(body.totals).toEqual({ wouldDrop: 0, kept: 0, suppressionRate: 0 })
  })
})
