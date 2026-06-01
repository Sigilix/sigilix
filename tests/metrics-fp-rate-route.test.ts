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
    // Single-page stub: returns ALL matching keys at once and ignores
    // `limit`/`cursor` (fixtures here are tiny, so the route's pagination loop
    // is exercised by the real binding, not this stub). `list_complete: true`
    // makes the route's loop exit after one page.
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
      windowDays: number
      maturityDays: number
      minN: number
      totalDismissals: number
      reviewsRealFanout: number
      scanCapped: boolean
      failedFetches: number
      note: string
      rows: Array<{ role: string; postedN: number; hard: number; soft: number; unlabeled: number; hardFpRate: number | null }>
    }
    // Echoed params + run metadata.
    expect(body.repo).toBe("sigilix/sigilix")
    expect(body).toMatchObject({ windowDays: 60, maturityDays: 0, minN: 1 })
    expect(body.reviewsRealFanout).toBe(1)
    expect(body.totalDismissals).toBe(1)
    expect(body.scanCapped).toBe(false)
    expect(body.failedFetches).toBe(0)
    expect(typeof body.note).toBe("string")
    // All 5 rows present (4 specialists + synth).
    expect(body.rows.map((r) => r.role).sort()).toEqual(["logic", "performance", "security", "synth", "tests"])
    const logic = body.rows.find((r) => r.role === "logic")!
    expect(logic).toMatchObject({ postedN: 1, hard: 1, soft: 0, unlabeled: 0, hardFpRate: 1 })
    // Synth = the final-gate aggregate over all posted findings.
    const synth = body.rows.find((r) => r.role === "synth")!
    expect(synth).toMatchObject({ postedN: 1, hard: 1, hardFpRate: 1 })
    // A specialist with no findings reports an empty denominator.
    const security = body.rows.find((r) => r.role === "security")!
    expect(security).toMatchObject({ postedN: 0, hard: 0, hardFpRate: null })
  })

  it("joins across a rename: review telemetry under the OLD slug + dismissals under the NEW slug, unioned via multiple ?repo= aliases", async () => {
    const now = Date.now()
    const reverseTs = REVERSE_TS_BASE - (now - DAY)
    const finding = { path: "a.ts", line: 10, headline: "bug", score: 5 }
    const fid = await computeFid({ ruleId: null, path: finding.path, line: finding.line, headline: finding.headline })
    const records: Record<string, unknown> = {
      // Review recorded BEFORE the rename → keyed under arc-and-anchor/sigilix.
      [`ensemble-review-telemetry:${reverseTs}:Arc-and-Anchor/sigilix#100`]: {
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        prNumber: 100,
        synthesizer: {
          verdict: { findings: [finding] },
          provenance: { findings: [{ sourceSpecialists: ["logic"] }] },
        },
      },
      // Dismissal dual-written AFTER the rename → keyed under sigilix/sigilix.
      "review-memory:Sigilix/sigilix:cat:logic": {
        schemaVersion: 1,
        category: "logic",
        lastUpdatedTs: new Date(now).toISOString(),
        signals: [
          { ts: new Date(now).toISOString(), prNumber: 100, commentId: 555, fid, kind: "dismissed-textual", dismissReason: "not-a-bug" },
        ],
      },
    }
    // A single slug joins NEITHER side to the other...
    const oldOnly = (await (
      await handleFpRateMetricsRoute(
        get("https://x/metrics/fp-rate?repo=Arc-and-Anchor/sigilix&window=60&maturity=0&min-n=1", `Bearer ${TOKEN}`),
        makeEnv(records),
      )
    ).json()) as { reviewsRealFanout: number; totalDismissals: number }
    expect(oldOnly).toMatchObject({ reviewsRealFanout: 1, totalDismissals: 0 }) // review found, dismissal missed

    // ...both aliases (comma-separated) reconstruct the joinable corpus.
    const res = await handleFpRateMetricsRoute(
      get(
        "https://x/metrics/fp-rate?repo=sigilix/sigilix,arc-and-anchor/sigilix&window=60&maturity=0&min-n=1",
        `Bearer ${TOKEN}`,
      ),
      makeEnv(records),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      repo: string
      repos: string[]
      reviewsRealFanout: number
      totalDismissals: number
      rows: Array<{ role: string; postedN: number; hard: number; hardFpRate: number | null }>
    }
    expect(body.repos.sort()).toEqual(["arc-and-anchor/sigilix", "sigilix/sigilix"])
    expect(body.repo).toBe("sigilix/sigilix,arc-and-anchor/sigilix")
    expect(body.reviewsRealFanout).toBe(1)
    expect(body.totalDismissals).toBe(1)
    const logic = body.rows.find((r) => r.role === "logic")!
    expect(logic).toMatchObject({ postedN: 1, hard: 1, hardFpRate: 1 })
  })
})
