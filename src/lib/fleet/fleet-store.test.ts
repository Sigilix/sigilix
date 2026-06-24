import { describe, expect, it } from "vitest"
import { readAggregate, recordContribution } from "@/src/lib/fleet/fleet-store"
import { type FleetPattern } from "@/src/shared/domain/fleet-pattern"
import { isEligible } from "@/src/shared/domain/fleet-aggregate"
import type { Env } from "@/src/shared/types/env"

function mockEnv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
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

const pat = (o: Partial<FleetPattern> = {}): FleetPattern => ({
  category: "security",
  subType: "sql-injection",
  severity: 5,
  reproduced: false,
  verified: false,
  signature: "security:sql-injection",
  ...o,
})

describe("fleet-store", () => {
  it("returns null for an absent / corrupt / shape-mismatched record", async () => {
    expect(await readAggregate(mockEnv().env, "x:y")).toBeNull()
    expect(await readAggregate(mockEnv({ "fleet:agg:x:y": "{not json" }).env, "x:y")).toBeNull()
    expect(await readAggregate(mockEnv({ "fleet:agg:x:y": JSON.stringify({ nope: 1 }) }).env, "x:y")).toBeNull()
  })

  it("records contributions and accumulates distinct tenants to the gate", async () => {
    const { env } = mockEnv()
    for (let i = 0; i < 5; i++) expect(await recordContribution(env, pat(), `tenant-${i}`)).toBe(true)
    const agg = await readAggregate(env, "security:sql-injection")
    expect(agg).not.toBeNull()
    expect(agg!.occurrences).toBe(5)
    expect(isEligible(agg!)).toBe(true)
  })

  it("a single noisy tenant stays below the gate (distinct, not volume)", async () => {
    const { env } = mockEnv()
    for (let i = 0; i < 20; i++) await recordContribution(env, pat(), "one-tenant")
    const agg = await readAggregate(env, "security:sql-injection")
    expect(agg!.occurrences).toBe(20)
    expect(isEligible(agg!)).toBe(false)
  })

  it("never persists the tenant id", async () => {
    const { env, store } = mockEnv()
    await recordContribution(env, pat(), "acme-secret-tenant")
    expect([...store.values()].join("")).not.toContain("acme-secret-tenant")
  })

  it("soft-fails to false on a KV put throw", async () => {
    const env = {
      OPENCLAW_STATE: {
        get: async () => null,
        put: async () => {
          throw new Error("kv down")
        },
      },
    } as unknown as Env
    expect(await recordContribution(env, pat(), "t")).toBe(false)
  })
})
