// SIG-184 PR 5b — GET /metrics/runner-evidence route: auth, window parsing,
// response shape (counts + mode + repoPresence).

import { describe, expect, it } from "vitest"
import { handleRunnerEvidenceMetricsRoute } from "../src/lib/metrics-runner-evidence-route"
import { RunnerEvidenceMetricsDO } from "../src/do/runner-evidence-metrics"
import type { Env } from "../src/index"
import { NodeSqliteStorage } from "./_shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo(): RunnerEvidenceMetricsDO {
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
  return new RunnerEvidenceMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: Partial<Env> = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_RUNNER_EVIDENCE_MODE: "post",
    RUNNER_EVIDENCE_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)
const URL_ = "https://x/metrics/runner-evidence"

describe("handleRunnerEvidenceMetricsRoute", () => {
  it("503 when the shared metrics token is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    expect((await handleRunnerEvidenceMetricsRoute(get(URL_, `Bearer ${TOKEN}`), env)).status).toBe(503)
  })

  it("401 when the bearer token is missing or wrong", async () => {
    const env = makeEnv()
    expect((await handleRunnerEvidenceMetricsRoute(get(URL_), env)).status).toBe(401)
    expect((await handleRunnerEvidenceMetricsRoute(get(URL_, "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an out-of-range window param", async () => {
    const env = makeEnv()
    expect((await handleRunnerEvidenceMetricsRoute(get(`${URL_}?window=99`, `Bearer ${TOKEN}`), env)).status).toBe(400)
  })

  it("200 with aggregated counts, the current mode, and per-repo presence", async () => {
    const do_ = makeDo()
    // Record evidence-pending first, then verified LAST, so the repo's LATEST
    // observed state is `verified` (the upsert advances on >= last_seen_at).
    await do_.record({ owner: "Sigilix", repo: "sigilix", prNumber: 8, state: "evidence-pending", reason: "merge-sha-unavailable" })
    await do_.record({ owner: "acme", repo: "site", prNumber: 3, state: "runner-absent" })
    await do_.record({ owner: "Sigilix", repo: "sigilix", prNumber: 7, state: "verified" })

    const env = makeEnv({}, do_)
    const res = await handleRunnerEvidenceMetricsRoute(get(URL_, `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      counts: Record<string, Record<string, number>>
      repoPresence: Array<{ owner: string; repo: string; lastState: string }>
      window: { days: number }
    }
    expect(body.mode).toBe("post")
    expect(body.counts.verified[""]).toBe(1)
    expect(body.counts["evidence-pending"]["merge-sha-unavailable"]).toBe(1)
    expect(body.counts["runner-absent"][""]).toBe(1)
    expect(body.window.days).toBe(7)
    const sigilix = body.repoPresence.find((p) => p.repo === "sigilix")
    expect(sigilix?.lastState).toBe("verified")
  })

  it("defaults mode to off when OPENCLAW_RUNNER_EVIDENCE_MODE is unset", async () => {
    const env = makeEnv({ OPENCLAW_RUNNER_EVIDENCE_MODE: undefined })
    const res = await handleRunnerEvidenceMetricsRoute(get(URL_, `Bearer ${TOKEN}`), env)
    expect(((await res.json()) as { mode: string }).mode).toBe("off")
  })
})
