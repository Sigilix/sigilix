// SIG-152 — GET /metrics/graph route: auth, window parsing, response shape.

import { describe, expect, it } from "vitest"
import { handleGraphMetricsRoute } from "@/src/lib/metrics-graph-route"
import { GraphMetricsDO } from "@/src/do/graph-metrics"
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
  return new GraphMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: Partial<Env> = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return { OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN, GRAPH_METRICS_DO: ns, ...overrides } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)

describe("handleGraphMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    expect((await handleGraphMetricsRoute(get("https://x/metrics/graph", `Bearer ${TOKEN}`), env)).status).toBe(503)
  })

  it("401 on missing/wrong bearer", async () => {
    const env = makeEnv()
    expect((await handleGraphMetricsRoute(get("https://x/metrics/graph"), env)).status).toBe(401)
    expect((await handleGraphMetricsRoute(get("https://x/metrics/graph", "Bearer no"), env)).status).toBe(401)
  })

  it("400 on invalid window (zero, over-max, non-numeric)", async () => {
    const env = makeEnv()
    for (const w of ["0", "31", "abc"]) {
      expect((await handleGraphMetricsRoute(get(`https://x/metrics/graph?window=${w}`, `Bearer ${TOKEN}`), env)).status).toBe(400)
    }
  })

  it("200 with windowed averages, mode breakdown, and heads", async () => {
    const do_ = makeDo()
    await do_.recordSample({ owner: "o", repo: "r", prNumber: 1, headSha: "abc", sample: { mode: "shadow", jaccard: 0.5, addedCount: 2, nodeCount: 6, cappedNodeCount: 4, blastCallerCount: 3, blastDependentCount: 1 } })
    const env = makeEnv({}, do_)
    const res = await handleGraphMetricsRoute(get("https://x/metrics/graph?window=14d", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = await res.json() as { window: { days: number }; reviews: number; averages: { jaccard: number }; modeReviews: Record<string, number>; lastSeenPrHeads: Array<{ headSha: string }> }
    expect(body.window.days).toBe(14)
    expect(body.reviews).toBe(1)
    expect(body.averages.jaccard).toBeCloseTo(0.5)
    expect(body.modeReviews.shadow).toBe(1)
    expect(body.lastSeenPrHeads[0].headSha).toBe("abc")
  })
})
