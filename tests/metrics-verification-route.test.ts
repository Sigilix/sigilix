// SIG-285 PR 2 — GET /metrics/verification route: auth, window parsing, shape.

import { describe, expect, it } from "vitest"
import { handleVerificationMetricsRoute } from "../src/lib/metrics-verification-route"
import { VerificationMetricsDO } from "../src/do/verification-metrics"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo(): VerificationMetricsDO {
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
  return new VerificationMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: Partial<Env> = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_VERIFICATION_MODE: "shadow",
    VERIFICATION_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)
const URL_ = "https://x/metrics/verification"

describe("handleVerificationMetricsRoute", () => {
  it("503 when the shared metrics token is unset", async () => {
    expect((await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined }))).status).toBe(503)
  })

  it("401 on missing / wrong bearer", async () => {
    const env = makeEnv()
    expect((await handleVerificationMetricsRoute(get(URL_), env)).status).toBe(401)
    expect((await handleVerificationMetricsRoute(get(URL_, "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an out-of-range window", async () => {
    expect((await handleVerificationMetricsRoute(get(`${URL_}?window=99`, `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
  })

  it("200 with mode, totals, derived fractions, and the verdict breakdown", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "refuted", category: "security" },
      { verdict: "confirmed", category: "logic" },
      { verdict: "no-check", category: "logic" },
      { verdict: "inconclusive", category: "security" },
    ])
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv({}, do_))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string; total: number; refutableFraction: number; refutedFraction: number
      byVerdict: Record<string, number>; counts: Record<string, Record<string, number>>
    }
    expect(body.mode).toBe("shadow")
    expect(body.total).toBe(4)
    expect(body.refutableFraction).toBe(0.5) // (1 confirmed + 1 refuted)/4
    expect(body.refutedFraction).toBe(0.25)
    expect(body.byVerdict).toMatchObject({ refuted: 1, confirmed: 1, "no-check": 1, inconclusive: 1 })
    expect(body.counts.refuted).toEqual({ security: 1 })
  })

  it("defaults mode to off when OPENCLAW_VERIFICATION_MODE is unset", async () => {
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv({ OPENCLAW_VERIFICATION_MODE: undefined }))
    expect(((await res.json()) as { mode: string }).mode).toBe("off")
  })
})
