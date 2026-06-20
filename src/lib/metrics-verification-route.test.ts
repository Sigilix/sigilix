// SIG-285 PR 2 — GET /metrics/verification route: auth, window parsing, shape.

import { describe, expect, it } from "vitest"
import { handleVerificationMetricsRoute } from "@/src/lib/metrics-verification-route"
import {
  VerificationMetricsDO,
  RECEIPTJOIN_CATEGORY,
  TRUSTLEDGER_CATEGORY,
  SELFCONFIRM_CATEGORY,
  REPRODUCE_ELIGIBILITY_CATEGORY,
  REPRODUCE_RESULT_CATEGORY,
} from "@/src/do/verification-metrics"
import type { Env } from "@/src/shared/types/env"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

const TOKEN = "metrics-token"

function makeDo(): VerificationMetricsDO {
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
  return new VerificationMetricsDO(state as unknown as DurableObjectState, {} as Env)
}

function makeEnv(overrides: { [K in keyof Env]?: Env[K] | undefined } = {}, doInstance = makeDo()): Env {
  const ns = { idFromName: (_: string) => "id", get: (_: unknown) => doInstance }
  return {
    OPENCLAW_VALIDATION_METRICS_TOKEN: TOKEN,
    OPENCLAW_VERIFICATION_MODE: "shadow",
    VERIFICATION_METRICS_DO: ns,
    ...overrides,
  } as unknown as Env
}

const get = (url: string, auth?: string) => new Request(url, auth ? { headers: { authorization: auth } } : undefined)
const URL_ = "https://x/metrics/verification"

describe("handleVerificationMetricsRoute", () => {
  it("503 when the shared metrics token is unset", async () => {
    expect(
      (
        await handleVerificationMetricsRoute(
          get(URL_, `Bearer ${TOKEN}`),
          makeEnv({ OPENCLAW_VALIDATION_METRICS_TOKEN: undefined }),
        )
      ).status,
    ).toBe(503)
  })

  it("401 on missing / wrong bearer", async () => {
    const env = makeEnv()
    expect((await handleVerificationMetricsRoute(get(URL_), env)).status).toBe(401)
    expect((await handleVerificationMetricsRoute(get(URL_, "Bearer nope"), env)).status).toBe(401)
  })

  it("400 on an out-of-range window", async () => {
    expect((await handleVerificationMetricsRoute(get(`${URL_}?window=99`, `Bearer ${TOKEN}`), makeEnv())).status).toBe(
      400,
    )
  })

  it("200 with mode, totals, derived fractions, and the verdict breakdown", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "refuted", category: "security" },
      { verdict: "confirmed", category: "logic" },
      { verdict: "no-check", category: "logic" },
      { verdict: "inconclusive", category: "security" },
    ])
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv({}, do_))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string
      total: number
      refutableFraction: number
      refutedFraction: number
      byVerdict: Record<string, number>
      counts: Record<string, Record<string, number>>
    }
    expect(body.mode).toBe("shadow")
    expect(body.total).toBe(4)
    expect(body.refutableFraction).toBe(0.5) // (1 confirmed + 1 refuted)/4
    expect(body.refutedFraction).toBe(0.25)
    expect(body.byVerdict).toMatchObject({
      refuted: 1,
      confirmed: 1,
      "no-check": 1,
      inconclusive: 1,
    })
    expect(body.counts.refuted).toEqual({ security: 1 })
  })

  it("surfaces receiptJoinMode + the receiptJoin corpus, kept out of the worker-token totals", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security" }, // worker-token
      { verdict: "confirmed", category: RECEIPTJOIN_CATEGORY },
      { verdict: "inconclusive", category: RECEIPTJOIN_CATEGORY },
    ])
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_RECEIPTJOIN_MODE: "shadow" }, do_),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      receiptJoinMode: string
      receiptJoin: {
        confirmed: number
        inconclusive: number
        total: number
        refutableEligibleFraction: number
      }
    }
    expect(body.total).toBe(1) // worker-token only — receipt-join excluded
    expect(body.receiptJoinMode).toBe("shadow")
    expect(body.receiptJoin).toEqual({
      confirmed: 1,
      inconclusive: 1,
      total: 2,
      refutableEligibleFraction: 0.5,
    })
  })

  it("defaults receiptJoinMode to off when OPENCLAW_RECEIPTJOIN_MODE is unset", async () => {
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv())
    expect(((await res.json()) as { receiptJoinMode: string }).receiptJoinMode).toBe("off")
  })

  it("surfaces trustLedgerMode + the trustLedger corpus, kept out of the worker-token totals", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security" }, // worker-token
      { verdict: "runner-confirmed", category: TRUSTLEDGER_CATEGORY },
      { verdict: "grounded-model", category: TRUSTLEDGER_CATEGORY },
      { verdict: "grounded-model", category: TRUSTLEDGER_CATEGORY },
    ])
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_TRUST_LEDGER: "shadow" }, do_),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      trustLedgerMode: string
      trustLedger: { byTier: Record<string, number>; total: number }
    }
    expect(body.total).toBe(1) // worker-token only — trust-ledger excluded
    expect(body.trustLedgerMode).toBe("shadow")
    expect(body.trustLedger).toEqual({
      byTier: { "runner-confirmed": 1, "grounded-model": 2 },
      total: 3,
    })
  })

  it("defaults trustLedgerMode to off when OPENCLAW_TRUST_LEDGER is unset", async () => {
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv())
    expect(((await res.json()) as { trustLedgerMode: string }).trustLedgerMode).toBe("off")
  })

  it("SIG-476: surfaces selfConfirmMode + the selfConfirm corpus, kept out of the worker-token totals", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security" }, // worker-token
      { verdict: "uplift", category: SELFCONFIRM_CATEGORY },
      { verdict: "uplift", category: SELFCONFIRM_CATEGORY },
      { verdict: "redundant", category: SELFCONFIRM_CATEGORY },
      { verdict: "inconclusive", category: SELFCONFIRM_CATEGORY },
    ])
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_SELFCONFIRM_MODE: "shadow" }, do_),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      selfConfirmMode: string
      selfConfirm: {
        uplift: number
        redundant: number
        inconclusive: number
        confirmed: number
        total: number
        confirmedFraction: number
        upliftFraction: number
      }
    }
    expect(body.total).toBe(1) // worker-token only — self-confirm excluded
    expect(body.selfConfirmMode).toBe("shadow")
    expect(body.selfConfirm).toEqual({
      uplift: 2,
      redundant: 1,
      inconclusive: 1,
      confirmed: 3,
      total: 4,
      confirmedFraction: 0.75,
      upliftFraction: 0.667,
    })
  })

  it("defaults selfConfirmMode to off when OPENCLAW_SELFCONFIRM_MODE is unset", async () => {
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv())
    expect(((await res.json()) as { selfConfirmMode: string }).selfConfirmMode).toBe("off")
  })

  it("SIG-477: surfaces reproduceMode + the reproduceEligibility corpus, kept out of the worker-token totals", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security" }, // worker-token
      { verdict: "eligible", category: REPRODUCE_ELIGIBILITY_CATEGORY },
      { verdict: "ineligible", category: REPRODUCE_ELIGIBILITY_CATEGORY },
      { verdict: "ineligible", category: REPRODUCE_ELIGIBILITY_CATEGORY },
    ])
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_REPRODUCE_MODE: "shadow" }, do_),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      reproduceMode: string
      reproduceEligibility: { eligible: number; ineligible: number; total: number; eligibleFraction: number }
    }
    expect(body.total).toBe(1) // worker-token only — reproduce corpus excluded
    expect(body.reproduceMode).toBe("shadow")
    expect(body.reproduceEligibility).toEqual({
      eligible: 1,
      ineligible: 2,
      total: 3,
      eligibleFraction: 0.333,
    })
  })

  it("defaults reproduceMode to off when OPENCLAW_REPRODUCE_MODE is unset", async () => {
    const res = await handleVerificationMetricsRoute(get(URL_, `Bearer ${TOKEN}`), makeEnv())
    expect(((await res.json()) as { reproduceMode: string }).reproduceMode).toBe("off")
  })

  it("SIG-477 PR-3: surfaces the reproduceResult corpus, kept out of the worker-token totals", async () => {
    const do_ = makeDo()
    await do_.recordBatch([
      { verdict: "confirmed", category: "security" }, // worker-token
      { verdict: "reproduced", category: REPRODUCE_RESULT_CATEGORY },
      { verdict: "inconclusive", category: REPRODUCE_RESULT_CATEGORY },
      { verdict: "skipped", category: REPRODUCE_RESULT_CATEGORY },
    ])
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_REPRODUCE_MODE: "shadow" }, do_),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      reproduceMode: string
      reproduceResult: {
        reproduced: number
        inconclusive: number
        skipped: number
        total: number
        reproducedFraction: number
      }
    }
    expect(body.total).toBe(1) // worker-token only — result corpus excluded
    expect(body.reproduceMode).toBe("shadow")
    expect(body.reproduceResult).toEqual({
      reproduced: 1,
      inconclusive: 1,
      skipped: 1,
      total: 2, // skipped excluded from the attempt total
      reproducedFraction: 0.5,
    })
  })

  it("defaults mode to off when OPENCLAW_VERIFICATION_MODE is unset", async () => {
    const res = await handleVerificationMetricsRoute(
      get(URL_, `Bearer ${TOKEN}`),
      makeEnv({ OPENCLAW_VERIFICATION_MODE: undefined }),
    )
    expect(((await res.json()) as { mode: string }).mode).toBe("off")
  })
})
