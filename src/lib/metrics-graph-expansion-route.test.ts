// SIG-286 PR2.5: GET /metrics/graph-expansion route — auth, window parsing,
// the mode surface, and the expansion metrics shape.

import { describe, expect, it } from "vitest"
import { handleGraphExpansionMetricsRoute } from "@/src/lib/metrics-graph-expansion-route"
import { GraphExpansionMetricsDO, type GraphExpansionSample } from "@/src/do/graph-expansion-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo(): GraphExpansionMetricsDO {
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
  return new GraphExpansionMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_GRAPH_EXPANSION: "shadow",
    GRAPH_EXPANSION_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)
const URL_ = "https://x/metrics/graph-expansion"

function sample(netNew: number, over: Partial<GraphExpansionSample> = {}): GraphExpansionSample {
  return {
    mode: "shadow",
    graphAvailable: true,
    netNewTokens: netNew,
    controlTokens: 100,
    totalTokens: 100 + netNew,
    fetchEnabled: true,
    fetchFiles: 1,
    fetchBytes: 500,
    fetchElapsedMs: 50,
    budgetExhausted: false,
    ...over,
  }
}

describe("handleGraphExpansionMetricsRoute", () => {
  it("503 when the shared metrics token is unset", async () => {
    expect(
      (
        await handleGraphExpansionMetricsRoute(
          get(URL_, `Bearer ${TOKEN}`),
          makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined }),
        )
      ).status,
    ).toBe(503)
  })

  it("401 on missing / wrong bearer", async () => {
    const env = makeEnv()
    expect((await handleGraphExpansionMetricsRoute(get(URL_), env)).status).toBe(401)
    expect((await handleGraphExpansionMetricsRoute(get(URL_, "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an out-of-range window", async () => {
    expect(
      (await handleGraphExpansionMetricsRoute(get(`${URL_}?window=99`, `Bearer ${TOKEN}`), makeEnv())).status,
    ).toBe(400)
  })

  it("200 with mode, reviews, the netNewTokens median/rates, and the GO/KILL verdict", async () => {
    const do_ = makeDo()
    for (const v of [850, 900, 1000, 1200, 2000]) await do_.recordSample({ sample: sample(v) })
    const res = await handleGraphExpansionMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv({}, do_))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      reviews: number
      netNewTokens: { medianEstimate: number; medianBucket: string; crossFileRate: number }
      goKill: { verdict: string }
    }
    expect(body.mode).toBe("shadow")
    expect(body.reviews).toBe(5)
    expect(body.netNewTokens.medianBucket).toBe("[800,1600)")
    expect(body.netNewTokens.crossFileRate).toBe(1)
    expect(body.goKill.verdict).toBe("GO")
  })

  it("defaults mode to off when OPENCLAW_GRAPH_EXPANSION is unset", async () => {
    const res = await handleGraphExpansionMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_GRAPH_EXPANSION: undefined }),
    )
    expect(((await res.json()) as { mode: string }).mode).toBe("off")
  })
})
