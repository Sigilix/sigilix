import { describe, expect, it } from "vitest"
import { contributeFindingsToFleet } from "@/src/lib/fleet/fleet-contribute"
import { readAggregate } from "@/src/lib/fleet/fleet-store"
import { isEligible } from "@/src/shared/domain/fleet-aggregate"
import type { Env } from "@/src/shared/types/env"
import type { SigilixConfig } from "@/src/lib/sigilix-config"

function mockEnv() {
  const store = new Map<string, string>()
  const env = {
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
    },
  } as unknown as Env
  return { env, store }
}

const findings = (n: number) =>
  Array.from({ length: n }, () => ({ category: "security", headline: "SQL injection", score: 5 }))

describe("contributeFindingsToFleet", () => {
  it("contributes keyed by ORG → crosses K=5 with 5 distinct orgs", async () => {
    const { env } = mockEnv()
    for (let i = 0; i < 5; i++) await contributeFindingsToFleet(env, `org-${i}`, findings(1), null)
    const agg = await readAggregate(env, "security:sql-injection")
    expect(agg).not.toBeNull()
    expect(isEligible(agg!)).toBe(true)
  })

  it("one org with many findings does NOT cross K (org is the k-anonymity unit)", async () => {
    const { env } = mockEnv()
    await contributeFindingsToFleet(env, "solo-org", findings(20), null)
    const agg = await readAggregate(env, "security:sql-injection")
    expect(agg!.occurrences).toBe(20)
    expect(isEligible(agg!)).toBe(false)
  })

  it("respects the per-repo opt-out (writes nothing)", async () => {
    const { env, store } = mockEnv()
    const optedOut = { fleet: { contribute: false } } as SigilixConfig
    await contributeFindingsToFleet(env, "org-x", findings(1), optedOut)
    expect(store.size).toBe(0)
  })

  it("maps the REPRODUCED trust tier onto the aggregate", async () => {
    const { env } = mockEnv()
    const f = [
      { category: "logic", headline: "off-by-one error", score: 4, trust: { tier: "reproduced-by-execution" } },
    ]
    for (let i = 0; i < 5; i++) await contributeFindingsToFleet(env, `o-${i}`, f, null)
    const agg = await readAggregate(env, "logic:off-by-one")
    expect(agg!.reproduced).toBe(5)
  })

  it("never throws even if the store read fails (best-effort)", async () => {
    const env = {
      OPENCLAW_STATE: {
        get: async () => {
          throw new Error("boom")
        },
        put: async () => {},
      },
    } as unknown as Env
    await expect(contributeFindingsToFleet(env, "o", findings(1), null)).resolves.toBeUndefined()
  })
})
