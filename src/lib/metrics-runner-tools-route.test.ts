// SIG-107 — GET /metrics/runner-tools: authenticated per-tool runner telemetry.

import { describe, expect, it } from "vitest"
import { RunnerToolMetricsDO } from "@/src/do/runner-tool-metrics"
import { handleRunnerToolsMetricsRoute } from "@/src/lib/metrics-runner-tools-route"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo(): RunnerToolMetricsDO {
  const sqlStorage = new NodeSqliteStorage()
  let alarmAt: number | null = null
  const state = {
    storage: {
      sql: sqlStorage,
      transactionSync<T>(fn: () => T): T {
        return sqlStorage.transactionSync(fn)
      },
      async get(): Promise<unknown> {
        return undefined
      },
      async put(): Promise<void> {},
      async delete(): Promise<boolean> {
        return false
      },
      async setAlarm(t: number): Promise<void> {
        alarmAt = t
      },
      async getAlarm(): Promise<number | null> {
        return alarmAt
      },
      async deleteAlarm(): Promise<void> {
        alarmAt = null
      },
    },
    id: { toString: () => "global", name: "global" },
  }
  return new RunnerToolMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    RUNNER_TOOL_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)
const URL_ = "https://x/metrics/runner-tools"

describe("handleRunnerToolsMetricsRoute", () => {
  it("503 when the shared metrics token is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    expect((await handleRunnerToolsMetricsRoute(get(URL_, `Bearer ${TOKEN}`), env)).status).toBe(503)
  })

  it("401 when the bearer token is missing or wrong", async () => {
    const env = makeEnv()
    expect((await handleRunnerToolsMetricsRoute(get(URL_), env)).status).toBe(401)
    expect((await handleRunnerToolsMetricsRoute(get(URL_, "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an out-of-range window param", async () => {
    const env = makeEnv()
    expect((await handleRunnerToolsMetricsRoute(get(`${URL_}?window=99`, `Bearer ${TOKEN}`), env)).status).toBe(400)
  })

  it("200 with per-tool status counts and latest repo state", async () => {
    const do_ = makeDo()
    await do_.recordManifest({
      owner: "Sigilix",
      repo: "sigilix",
      occurredAt: "2026-06-12T12:00:00.000Z",
      tools: [
        { toolId: "eslint", enabled: true, status: "produced", runCount: 1, resultCount: 2 },
        { toolId: "ruff", enabled: true, status: "empty", runCount: 1, resultCount: 0 },
      ],
    })

    const env = makeEnv({}, do_)
    const res = await handleRunnerToolsMetricsRoute(get(`${URL_}?window=14d`, `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      window: { days: number }
      manifestReceipts: number
      tools: Array<{ toolId: string; statuses: Record<string, number>; resultCount: number }>
      latestByRepo: Array<{ repo: string; toolId: string; status: string }>
    }
    expect(body.window.days).toBe(14)
    expect(body.manifestReceipts).toBe(1)
    expect(body.tools.find((t) => t.toolId === "eslint")).toMatchObject({
      statuses: { produced: 1 },
      resultCount: 2,
    })
    expect(body.latestByRepo.find((t) => t.toolId === "ruff")).toMatchObject({
      repo: "sigilix",
      status: "empty",
    })
  })
})
