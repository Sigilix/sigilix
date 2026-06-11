// SIG-114 PR 5 — GET /metrics/fp-rate route: auth, param validation, and an
// end-to-end compute over a stubbed KV binding. (The join/rate math itself is
// unit-tested in fp-rate.test.ts; this exercises the KV-read + JSON wiring.)

import { describe, expect, it } from "vitest"
import { handleFpRateMetricsRoute } from "@/src/lib/metrics-fp-rate-route"
import { computeFid } from "@/src/lib/review-memory/marker"
import { REVERSE_TS_BASE } from "@/src/lib/fp-rate/ingest"
import type { Env } from "@/src/shared/types/env"

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

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)

describe("handleFpRateMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({}, { OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    const res = await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(503)
  })

  it("401 on missing / wrong bearer token", async () => {
    expect((await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r"), makeEnv())).status).toBe(401)
    expect(
      (await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=o/r", "Bearer nope"), makeEnv())).status,
    ).toBe(401)
  })

  it("400 on missing / malformed repo", async () => {
    expect(
      (await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate", `Bearer ${TOKEN}`), makeEnv())).status,
    ).toBe(400)
    expect(
      (await handleFpRateMetricsRoute(get("https://x/metrics/fp-rate?repo=notarepo", `Bearer ${TOKEN}`), makeEnv()))
        .status,
    ).toBe(400)
  })

  it("400 on invalid window or maturity>=window", async () => {
    expect(
      (
        await handleFpRateMetricsRoute(
          get("https://x/metrics/fp-rate?repo=o/r&window=999", `Bearer ${TOKEN}`),
          makeEnv(),
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await handleFpRateMetricsRoute(
          get("https://x/metrics/fp-rate?repo=o/r&window=10&maturity=10", `Bearer ${TOKEN}`),
          makeEnv(),
        )
      ).status,
    ).toBe(400)
  })

  it("computes the per-specialist rate over the KV binding and returns JSON", async () => {
    const now = Date.now()
    const reverseTs = REVERSE_TS_BASE - (now - DAY) // posted ~1 day ago
    const finding = { path: "a.ts", line: 10, headline: "bug", score: 5 }
    const fid = await computeFid({
      ruleId: null,
      path: finding.path,
      line: finding.line,
      headline: finding.headline,
    })
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
          {
            ts: new Date(now).toISOString(),
            prNumber: 100,
            commentId: 555,
            fid,
            kind: "dismissed-textual",
            dismissReason: "not-a-bug",
          },
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
      rows: Array<{
        role: string
        postedN: number
        hard: number
        soft: number
        unlabeled: number
        hardFpRate: number | null
      }>
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

  const reviewRecord = (slug: string, pr: number, ageMs: number, now: number) => ({
    [`ensemble-review-telemetry:${REVERSE_TS_BASE - (now - ageMs)}:${slug}#${pr}`]: {
      owner: slug.split("/")[0],
      repo: slug.split("/")[1],
      prNumber: pr,
      synthesizer: {
        verdict: { findings: [{ path: "a.ts", line: 10, headline: "bug", score: 5 }] },
        provenance: { findings: [{ sourceSpecialists: ["logic"] }] },
      },
    },
  })

  it("surfaces maturityExcludedReviews when SOME reviews are too recent (no relax needed)", async () => {
    const now = Date.now()
    const records = {
      ...reviewRecord("o/r", 100, 20 * DAY, now), // mature: 20d old, ≥ 14d gate
      ...reviewRecord("o/r", 101, 1 * DAY, now), // too recent: 1d old, excluded by 14d gate
    }
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=o/r&window=60&maturity=14&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    const body = (await res.json()) as {
      reviewsScanned: number
      maturityExcludedReviews: number
      maturityRelaxed: boolean
      effectiveMaturityDays: number
    }
    expect(body.reviewsScanned).toBe(1) // only the mature one counts
    expect(body.maturityExcludedReviews).toBe(1) // the recent one is held back + surfaced
    expect(body.maturityRelaxed).toBe(false) // a mature review exists → no relax
    expect(body.effectiveMaturityDays).toBe(14)
  })

  it("auto-relaxes the maturity gate (flagged) rather than return a silent empty when EVERY review is too recent (SIG-245)", async () => {
    const now = Date.now()
    // Only review is 2 days old — fully excluded by the requested 14d gate.
    const records = reviewRecord("o/r", 100, 2 * DAY, now)
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=o/r&window=60&maturity=14&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    const body = (await res.json()) as {
      reviewsScanned: number
      maturityExcludedReviews: number
      maturityRelaxed: boolean
      maturityDays: number
      effectiveMaturityDays: number
    }
    // Instead of a misleading reviewsScanned:0, the gate relaxes to admit the
    // review, and the relaxation is flagged.
    expect(body.reviewsScanned).toBe(1)
    expect(body.maturityRelaxed).toBe(true)
    expect(body.maturityDays).toBe(14) // requested gate echoed unchanged
    // Relaxed to the oldest review's age (2d), NOT all the way to 0 — keeps the
    // most-settled gate that still yields data.
    expect(body.effectiveMaturityDays).toBe(2)
    expect(body.maturityExcludedReviews).toBe(0)
  })

  it("relaxes all the way to 0 when the only review is younger than a day (floor(age)→0)", async () => {
    const now = Date.now()
    const records = reviewRecord("o/r", 100, Math.round(0.5 * DAY), now) // ~12h old
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=o/r&window=60&maturity=3&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    const body = (await res.json()) as {
      reviewsScanned: number
      maturityRelaxed: boolean
      effectiveMaturityDays: number
    }
    expect(body.reviewsScanned).toBe(1)
    expect(body.maturityRelaxed).toBe(true)
    expect(body.effectiveMaturityDays).toBe(0)
  })

  it("never relaxes when maturity=0 was requested (the relax guard can't false-fire)", async () => {
    const now = Date.now()
    const records = reviewRecord("o/r", 100, Math.round(0.25 * DAY), now) // very recent
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=o/r&window=60&maturity=0&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    const body = (await res.json()) as {
      reviewsScanned: number
      maturityRelaxed: boolean
      effectiveMaturityDays: number
    }
    expect(body.reviewsScanned).toBe(1)
    expect(body.maturityRelaxed).toBe(false) // maturity=0 already admits everything → no relax
    expect(body.effectiveMaturityDays).toBe(0)
  })

  it("defaults the maturity gate to 3 days (SIG-245 — was 14, too high for the dismissal cadence)", async () => {
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=o/r&min-n=1", `Bearer ${TOKEN}`),
      makeEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { maturityDays: number }
    expect(body.maturityDays).toBe(3)
  })

  it("joins across a rename: review telemetry under the OLD slug + dismissals under the NEW slug, unioned via multiple ?repo= aliases", async () => {
    const now = Date.now()
    const reverseTs = REVERSE_TS_BASE - (now - DAY)
    const finding = { path: "a.ts", line: 10, headline: "bug", score: 5 }
    const fid = await computeFid({
      ruleId: null,
      path: finding.path,
      line: finding.line,
      headline: finding.headline,
    })
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
          {
            ts: new Date(now).toISOString(),
            prNumber: 100,
            commentId: 555,
            fid,
            kind: "dismissed-textual",
            dismissReason: "not-a-bug",
          },
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

  it("accepts the repeated ?repo= param form (not just comma-separated)", async () => {
    const res = await handleFpRateMetricsRoute(
      get(
        "https://x/metrics/fp-rate?repo=sigilix/sigilix&repo=arc-and-anchor/sigilix&window=60&maturity=0&min-n=1",
        `Bearer ${TOKEN}`,
      ),
      makeEnv(),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { repos: string[] }
    expect(body.repos.sort()).toEqual(["arc-and-anchor/sigilix", "sigilix/sigilix"])
  })

  it("400s on stray leading/trailing/double commas (empty segments rejected explicitly, not order-dependently)", async () => {
    for (const repo of ["o/r,", ",o/r", "o/r,,o/r", "o/r, ,o/r"]) {
      const res = await handleFpRateMetricsRoute(
        get(`https://x/metrics/fp-rate?repo=${encodeURIComponent(repo)}`, `Bearer ${TOKEN}`),
        makeEnv(),
      )
      expect(res.status, `repo=${repo}`).toBe(400)
      expect(((await res.json()) as { error: string }).error, `repo=${repo}`).toBe("invalid_repo")
    }
  })

  it("400s when aliases are DIFFERENT repos (cross-repo attribution guard)", async () => {
    // arc-and-anchor/sigilix and acme/widgets are different repos: PR-number /
    // fid collisions would cross-attribute, so the union must be rejected.
    const res = await handleFpRateMetricsRoute(
      get("https://x/metrics/fp-rate?repo=arc-and-anchor/sigilix,acme/widgets", `Bearer ${TOKEN}`),
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe("alias_repo_mismatch")
    // Same repo name across differing owners (a transfer/rename) is allowed.
    const ok = await handleFpRateMetricsRoute(
      get(
        "https://x/metrics/fp-rate?repo=arc-and-anchor/sigilix,sigilix/sigilix&window=60&maturity=0&min-n=1",
        `Bearer ${TOKEN}`,
      ),
      makeEnv(),
    )
    expect(ok.status).toBe(200)
  })
})
