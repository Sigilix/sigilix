// SIG-119 — GET /metrics/validation route: auth, window parsing, response shape.

import { describe, expect, it } from "vitest"
import { handleValidationMetricsRoute } from "../src/lib/metrics-validation-route"
import { ValidationMetricsDO } from "../src/do/validation-metrics"
import type { Env } from "../src/index"
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

/** Env with a DO namespace stub whose every id resolves to one shared DO. */
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

describe("handleValidationMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleValidationMetricsRoute(get("https://x/metrics/validation", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(503)
  })

  it("401 when the bearer token is missing or wrong", async () => {
    const env = makeEnv()
    expect((await handleValidationMetricsRoute(get("https://x/metrics/validation"), env)).status).toBe(401)
    expect((await handleValidationMetricsRoute(get("https://x/metrics/validation", "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an invalid window param", async () => {
    const env = makeEnv()
    const res = await handleValidationMetricsRoute(get("https://x/metrics/validation?window=99", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(400)
  })

  it("200 with aggregated counts, modes, and head SHAs", async () => {
    const do_ = makeDo()
    await do_.recordBatch({
      owner: "o", repo: "r", prNumber: 1, headSha: "abc",
      events: [
        { kind: "gate-rejection", gate: "security", reason: "fabricated-evidence-id", dropped: false },
        { kind: "gate-rejection", gate: "tests", reason: "missing-path", dropped: true },
      ],
    })
    const env = makeEnv({ OPENCLAW_TESTS_VALIDATOR_MODE: "enforce" }, do_)
    const res = await handleValidationMetricsRoute(get("https://x/metrics/validation?window=14d", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      window: { days: number }
      modes: Record<string, string>
      counts: Record<string, Record<string, { wouldDrop: number; kept: number }>>
      lastSeenPrHeads: Array<{ headSha: string }>
    }
    expect(body.window.days).toBe(14)
    expect(body.modes.tests).toBe("enforce")
    expect(body.modes.security).toBe("shadow")
    expect(body.counts.security["fabricated-evidence-id"]).toEqual({ wouldDrop: 1, kept: 1 })
    expect(body.counts.tests["missing-path"]).toEqual({ wouldDrop: 1, kept: 0 })
    expect(body.lastSeenPrHeads[0].headSha).toBe("abc")
  })

  it("200 surfaces the per-category over-fire rollup (byCategory)", async () => {
    const do_ = makeDo()
    await do_.recordBatch({
      owner: "o", repo: "r", prNumber: 1, headSha: "abc",
      events: [
        { kind: "gate-rejection", gate: "security", reason: "no-credential-token", dropped: false, category: "testing" },
        { kind: "gate-rejection", gate: "security", reason: "fabricated-evidence-id", dropped: false, category: "security" },
      ],
    })
    const env = makeEnv({}, do_)
    const res = await handleValidationMetricsRoute(get("https://x/metrics/validation", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = await res.json() as {
      byCategory: Record<string, Record<string, { wouldDrop: number; kept: number }>>
    }
    expect(body.byCategory.security.testing).toEqual({ wouldDrop: 1, kept: 1 })
    expect(body.byCategory.security.security).toEqual({ wouldDrop: 1, kept: 1 })
  })

  it("defaults to a 7-day window when unspecified", async () => {
    const env = makeEnv()
    const res = await handleValidationMetricsRoute(get("https://x/metrics/validation", `Bearer ${TOKEN}`), env)
    const body = await res.json() as { window: { days: number } }
    expect(body.window.days).toBe(7)
  })
})
