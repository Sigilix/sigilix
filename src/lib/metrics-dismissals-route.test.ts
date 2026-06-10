// SIG-173 — GET /metrics/dismissals route: auth, window parsing, response shape.

import { describe, expect, it } from "vitest"
import { handleDismissalMetricsRoute } from "@/src/lib/metrics-dismissals-route"
import { ValidationMetricsDO } from "@/src/do/validation-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

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

describe("handleDismissalMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleDismissalMetricsRoute(
      get("https://x/metrics/dismissals", `Bearer ${TOKEN}`),
      env,
    )
    expect(res.status).toBe(503)
  })

  it("401 when the bearer token is missing or wrong", async () => {
    const env = makeEnv()
    expect((await handleDismissalMetricsRoute(get("https://x/metrics/dismissals"), env)).status).toBe(401)
    expect((await handleDismissalMetricsRoute(get("https://x/metrics/dismissals", "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an invalid window param", async () => {
    const env = makeEnv()
    expect(
      (await handleDismissalMetricsRoute(get("https://x/metrics/dismissals?window=99", `Bearer ${TOKEN}`), env)).status,
    ).toBe(400)
    expect(
      (await handleDismissalMetricsRoute(get("https://x/metrics/dismissals?window=banana", `Bearer ${TOKEN}`), env)).status,
    ).toBe(400)
  })

  it("200 with the full per-reason rollup (defaults absent reasons to 0)", async () => {
    const do_ = makeDo()
    await do_.recordBatch({
      owner: "", repo: "", prNumber: 0, headSha: "",
      events: [
        { kind: "dismissal-reason", reason: "too-minor" },
        { kind: "dismissal-reason", reason: "too-minor" },
        { kind: "dismissal-reason", reason: "not-a-bug" },
      ],
    })
    const env = makeEnv({}, do_)
    const res = await handleDismissalMetricsRoute(
      get("https://x/metrics/dismissals?window=30d", `Bearer ${TOKEN}`),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as {
      window: { days: number; startDay: string; endDay: string }
      reasonCounts: Record<string, number>
    }
    expect(body.window.days).toBe(30)
    expect(body.reasonCounts).toEqual({
      "not-a-bug": 1,
      "bad-anchor": 0,
      "already-covered": 0,
      "too-minor": 2,
      "wrong-context": 0,
      "unlabeled": 0,
    })
  })

  it("defaults to a 7-day window when unspecified", async () => {
    const env = makeEnv()
    const res = await handleDismissalMetricsRoute(
      get("https://x/metrics/dismissals", `Bearer ${TOKEN}`),
      env,
    )
    const body = await res.json() as { window: { days: number } }
    expect(body.window.days).toBe(7)
  })
})
