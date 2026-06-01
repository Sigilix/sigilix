// SIG-286 PR3 — GET /metrics/graph-expansion-ab: auth, param validation, and
// per-arm aggregation over a stubbed KV binding.

import { describe, expect, it } from "vitest"
import { handleGraphExpansionAbMetricsRoute } from "../src/lib/metrics-graph-expansion-ab-route"
import { REVERSE_TS_BASE } from "../src/lib/fp-rate/ingest"
import type { Env } from "../src/index"

const TOKEN = "metrics-token"
const DAY = 86_400_000

function makeKv(records: Record<string, unknown>) {
  return {
    async list({ prefix }: { prefix: string }) {
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
    OPENCLAW_GRAPH_EXPANSION: "post",
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) =>
  new Request(url, auth ? { headers: { authorization: auth } } : undefined)

/** A telemetry record ~1 day old with an A/B arm + synth findings of given scores. */
function rec(arm: "treatment" | "control" | undefined, scores: number[], pr: number): [string, unknown] {
  const reverseTs = REVERSE_TS_BASE - (Date.now() - DAY)
  const value: Record<string, unknown> = {
    owner: "o",
    repo: "r",
    prNumber: pr,
    synthesizer: { verdict: { findings: scores.map((score) => ({ score })) } },
  }
  if (arm) value.graphExpansionAb = { arm }
  return [`ensemble-review-telemetry:${reverseTs}:o/r#${pr}`, value]
}

describe("handleGraphExpansionAbMetricsRoute", () => {
  it("503 when the token is unset", async () => {
    const env = makeEnv({}, { OPENCLAW_VALIDATION_METRICS_TOKEN: undefined })
    expect((await handleGraphExpansionAbMetricsRoute(get("https://x/metrics/graph-expansion-ab?repo=o/r", `Bearer ${TOKEN}`), env)).status).toBe(503)
  })

  it("401 on missing / wrong token", async () => {
    expect((await handleGraphExpansionAbMetricsRoute(get("https://x/metrics/graph-expansion-ab?repo=o/r"), makeEnv())).status).toBe(401)
    expect((await handleGraphExpansionAbMetricsRoute(get("https://x/metrics/graph-expansion-ab?repo=o/r", "Bearer nope"), makeEnv())).status).toBe(401)
  })

  it("400 on missing / malformed repo", async () => {
    expect((await handleGraphExpansionAbMetricsRoute(get("https://x/metrics/graph-expansion-ab", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
    expect((await handleGraphExpansionAbMetricsRoute(get("https://x/metrics/graph-expansion-ab?repo=notarepo", `Bearer ${TOKEN}`), makeEnv())).status).toBe(400)
  })

  it("aggregates findings per arm; excludes records without an arm", async () => {
    const records: Record<string, unknown> = Object.fromEntries([
      rec("treatment", [5, 4, 2], 101), // 3 findings, 2 high-sev
      rec("treatment", [4], 102), // 1 finding, 1 high-sev
      rec("control", [2], 103), // 1 finding, 0 high-sev
      rec(undefined, [5, 5, 5], 104), // NO arm — excluded from both arms
    ])
    const res = await handleGraphExpansionAbMetricsRoute(
      get("https://x/metrics/graph-expansion-ab?repo=o/r&window=30", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      treatment: { reviews: number; totalFindings: number; highSevFindings: number; meanFindings: number | null; meanHighSev: number | null }
      control: { reviews: number; totalFindings: number; highSevFindings: number; meanHighSev: number | null }
      verdict: string
    }
    expect(body.mode).toBe("post")
    // Treatment: 2 reviews, 4 findings total, 3 high-sev → meanHighSev 1.5.
    expect(body.treatment).toMatchObject({ reviews: 2, totalFindings: 4, highSevFindings: 3, meanFindings: 2, meanHighSev: 1.5 })
    // Control: 1 review, 1 finding, 0 high-sev.
    expect(body.control).toMatchObject({ reviews: 1, totalFindings: 1, highSevFindings: 0, meanHighSev: 0 })
    // The no-arm record (104) is in neither arm: total reviews = 3, not 4.
    expect(body.treatment.reviews + body.control.reviews).toBe(3)
    // Below MIN_PER_ARM (30) → accruing.
    expect(body.verdict).toBe("accruing")
  })

  it("excludes telemetry older than the window", async () => {
    const oldReverseTs = REVERSE_TS_BASE - (Date.now() - 40 * DAY) // ~40 days old
    const records: Record<string, unknown> = {
      [`ensemble-review-telemetry:${oldReverseTs}:o/r#200`]: {
        owner: "o", repo: "r", prNumber: 200,
        synthesizer: { verdict: { findings: [{ score: 5 }] } },
        graphExpansionAb: { arm: "treatment" },
      },
    }
    const res = await handleGraphExpansionAbMetricsRoute(
      get("https://x/metrics/graph-expansion-ab?repo=o/r&window=30", `Bearer ${TOKEN}`),
      makeEnv(records),
    )
    const body = (await res.json()) as { treatment: { reviews: number } }
    expect(body.treatment.reviews).toBe(0) // 40d-old review excluded by the 30d window
  })
})
