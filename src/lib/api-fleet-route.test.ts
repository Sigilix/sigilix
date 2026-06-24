import { describe, expect, it } from "vitest"
import { handleFleetApiRoute } from "@/src/lib/api-fleet-route"
import { recordContribution } from "@/src/lib/fleet/fleet-store"
import { type FleetPattern } from "@/src/shared/domain/fleet-pattern"
import type { Env } from "@/src/shared/types/env"

const KEY = "test-fleet-key"

function mockEnv(withKey = true) {
  const store = new Map<string, string>()
  const env = {
    OPENCLAW_SIGILIX_API_KEY: withKey ? KEY : undefined,
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
    },
  } as unknown as Env
  return { env, store }
}

const req = (body: unknown, key: string | null = KEY) =>
  new Request("https://x/v1/fleet", {
    method: "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  })

const pat = (): FleetPattern => ({
  category: "security",
  subType: "sql-injection",
  severity: 5,
  reproduced: true,
  verified: false,
  signature: "security:sql-injection",
})

const seedKAnonymous = async (env: Env) => {
  for (let i = 0; i < 5; i++) await recordContribution(env, pat(), `t-${i}`)
}

const insightsOf = async (res: Response): Promise<{ signature: string; insight: string }[]> =>
  ((await res.json()) as { insights: { signature: string; insight: string }[] }).insights

describe("handleFleetApiRoute", () => {
  it("503 when the endpoint is unkeyed", async () => {
    expect((await handleFleetApiRoute(req({ findings: [{ category: "logic" }] }), mockEnv(false).env)).status).toBe(503)
  })

  it("401 on a bad bearer", async () => {
    expect((await handleFleetApiRoute(req({ findings: [{ category: "logic" }] }, "wrong"), mockEnv().env)).status).toBe(
      401,
    )
  })

  it("400 on no findings", async () => {
    expect((await handleFleetApiRoute(req({ findings: [] }), mockEnv().env)).status).toBe(400)
  })

  it("returns empty insights when no pattern has crossed K (graceful, 200)", async () => {
    const res = await handleFleetApiRoute(
      req({ findings: [{ category: "security", headline: "SQL injection here" }] }),
      mockEnv().env,
    )
    expect(res.status).toBe(200)
    expect(await insightsOf(res)).toEqual([])
  })

  it("surfaces an insight once a pattern is k-anonymous", async () => {
    const { env } = mockEnv()
    await seedKAnonymous(env)
    const res = await handleFleetApiRoute(
      req({ findings: [{ category: "security", headline: "possible SQL injection in handler" }] }),
      env,
    )
    const body = (await res.json()) as { insights: { signature: string; insight: string }[] }
    expect(body.insights).toHaveLength(1)
    expect(body.insights[0]!.signature).toBe("security:sql-injection")
    expect(body.insights[0]!.insight).toContain("codebases")
    expect(body.insights[0]!.insight).toContain("reproduced by execution")
  })

  it("dedupes findings that map to the same signature", async () => {
    const { env } = mockEnv()
    await seedKAnonymous(env)
    const res = await handleFleetApiRoute(
      req({
        findings: [
          { category: "security", headline: "sql injection in A" },
          { category: "security", headline: "sqli in B" },
        ],
      }),
      env,
    )
    expect(await insightsOf(res)).toHaveLength(1)
  })

  it("skips findings whose category is out-of-vocabulary", async () => {
    const res = await handleFleetApiRoute(req({ findings: [{ category: "vibes", headline: "x" }] }), mockEnv().env)
    expect(await insightsOf(res)).toEqual([])
  })
})
