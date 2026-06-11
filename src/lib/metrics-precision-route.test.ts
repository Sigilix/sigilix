// SIG-147 — GET /metrics/precision route: auth, repo param, FP-reduction shape.

import { describe, expect, it } from "vitest"
import { handlePrecisionMetricsRoute } from "@/src/lib/metrics-precision-route"
import { recordOutcome } from "@/src/features/precision-profile"
import type { Env } from "@/src/shared/types/env"

const TOKEN = "metrics-token"

function makeEnv(overrides: Partial<Env> = {}) {
  const store = new Map<string, string>()
  const kv = {
    async get(k: string) {
      return store.get(k) ?? null
    },
    async put(k: string, v: string) {
      store.set(k, v)
    },
  }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_STATE: kv,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)

describe("handlePrecisionMetricsRoute", () => {
  it("503 when the token secret is unset", async () => {
    const env = makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    expect(
      (await handlePrecisionMetricsRoute(get("https://x/metrics/precision?repo=o/r", `Bearer ${TOKEN}`), env)).status,
    ).toBe(503)
  })

  it("401 on missing/wrong bearer", async () => {
    const env = makeEnv()
    expect((await handlePrecisionMetricsRoute(get("https://x/metrics/precision?repo=o/r"), env)).status).toBe(401)
    expect(
      (await handlePrecisionMetricsRoute(get("https://x/metrics/precision?repo=o/r", "Bearer nope"), env)).status,
    ).toBe(401)
  })

  it("400 when ?repo is missing", async () => {
    const env = makeEnv()
    expect((await handlePrecisionMetricsRoute(get("https://x/metrics/precision", `Bearer ${TOKEN}`), env)).status).toBe(
      400,
    )
  })

  it("200 with a zeroed FP-reduction when the repo has no profile", async () => {
    const env = makeEnv()
    const res = await handlePrecisionMetricsRoute(get("https://x/metrics/precision?repo=o/r", `Bearer ${TOKEN}`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      patterns: number
      fpReduction: { suppressingPatterns: number }
    }
    expect(body).toMatchObject({ patterns: 0, fpReduction: { suppressingPatterns: 0 } })
  })

  it("200 reporting a suppressing pattern after repeated dismissals", async () => {
    const env = makeEnv()
    for (let i = 0; i < 5; i++) {
      await recordOutcome(
        env,
        { repoId: "o/r", category: "logic", patternHash: "fp1", outcome: "dismissed" },
        1700000000000 + i,
      )
    }
    const res = await handlePrecisionMetricsRoute(get("https://x/metrics/precision?repo=o/r", `Bearer ${TOKEN}`), env)
    const body = (await res.json()) as {
      patterns: number
      fpReduction: { suppressingPatterns: number }
    }
    expect(body.patterns).toBe(1)
    expect(body.fpReduction.suppressingPatterns).toBe(1) // fp1 crossed the suppress threshold
  })
})
