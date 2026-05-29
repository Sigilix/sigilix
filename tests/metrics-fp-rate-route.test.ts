// SIG-114 PR 5 — GET /metrics/fp-rate route: auth, param validation, and an
// end-to-end compute over a stubbed KV binding. (The join/rate math itself is
// unit-tested in fp-rate.test.ts; this exercises the KV-read + JSON wiring.)

import { describe, expect, it } from "vitest"
import { handleFpRateMetricsRoute } from "../src/lib/metrics-fp-rate-route"
import { computeFid } from "../src/lib/review-memory/marker"
import { REVERSE_TS_BASE } from "../src/lib/fp-rate/ingest"
import type { Env } from "../src/index"

const TOKEN = "metrics-token"
const DAY = 86_400_000

function makeKv(records: Record<string, unknown>) {
  return {
    async list({ prefix }: { prefix: string; limit?: number; cursor?: string }) {
      const keys = Object.keys(records)
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }))
      return { keys, list_complete: true, cursor: undefined }
    },
    async get(key: string, _type?: string) {
      return key in records ? records[key] : null
    },
  }
}

function makeEnv(records: Record<string, unknown> = {}, overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_STATE: makeKv(records),
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)

describe("handleFpRateMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({}, { OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(503)
  })

  it("401 on missing / wrong bearer token", async () => {
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r"), makeEnv())).status).toBe(401)
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r", "Bearer nope"), makeEnv())).status).toBe(401)
  })

  it("400 on missing / malformed repo", async () => {
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=notarepo", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
  })

  it("400 on invalid window or maturity>=window", async () => {
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r&window=999", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r&window=10&maturity=10", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
  })

  it("computes the per-specialist rate over the KV binding and returns JSON", async () => {
    const now = Date.now()
    const reverseTs = REVERSE_TS_BASE - (now - DAY) // posted ~1 day ago
    const finding = { path: "a.ts", line: 10, headline: "bug", score: 5 }
    const fid = await computeFid({ ruleId: null, path: finding.path, line: finding.line, headline: finding.headline })
    const records: Record<string, unknown> = {
      [`ensemble-review-telemetry:${reverseTs}:Sigilix/sigilix#100`]: {
        owner: "Sigilix",
        repo: "sigilix",
        prNumber: 100,
        synthesizer: {
          verdict: { findings: [finding] },
          provenance: { findings: [{ sourceSpecialists: ["logic"] }] },
        },
      },
      "review-memory:Sigilix/sigilix:cat:logic": {
        schemaVersion: 1,
        category: "logic",
        lastUpdatedTs: new Date(now).toISOString(),
        signals: [
          { ts: new Date(now).toISOString(), prNumber: 100, commentId: 555, fid, kind: "dismissed-textual", dismissReason: "not-a-bug" },
        ],
      },
    }
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=Sigilix/sigilix&window=60&maturity=0&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      repo: string
      totalDismissals: number
      rows: Array<{ role: string; postedN: number; hard: number; hardFpRate: number | null }>
    }
    expect(body.repo).toBe("sigilix/sigilix")
    expect(body.totalDismissals).toBe(1)
    const logic = body.rows.find((r) => r.role === "logic")!
    expect(logic.postedN).toBe(1)
    expect(logic.hard).toBe(1) // dismissReason "not-a-bug" → hard FP
    expect(logic.hardFpRate).toBe(1)
    const synth = body.rows.find((r) => r.role === "synth")!
    expect(synth.postedN).toBe(1)
    expect(synth.hard).toBe(1)
  })
})
