import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { insertApiKey } from "@/src/lib/api-key-store"
import { sha256Hex } from "@/src/lib/auth-bearer"
import { handleFleetApiRoute } from "@/src/lib/api-fleet-route"
import { recordContribution } from "@/src/lib/fleet/fleet-store"
import { type FleetPattern } from "@/src/shared/domain/fleet-pattern"
import type { Env } from "@/src/shared/types/env"

const KEY = "test-fleet-key"
const MIGRATION_SQL_API_KEY = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)
/** Throws on any operation — simulates a genuine D1 outage/fault. */
function makeBrokenDb(): D1Database {
  return {
    prepare() {
      throw new Error("simulated D1 error")
    },
  } as unknown as D1Database
}

function mockEnv(withKey = true, extra: Partial<Env> = {}) {
  const store = new Map<string, string>()
  const env = {
    OPENCLAW_SIGILIX_API_KEY: withKey ? KEY : undefined,
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
    },
    ...extra,
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

  // #155 slice 2: the route now authenticates via resolveApiKey (D1 api_key lookup,
  // falling back to the legacy global key). These pin the new invariants at the
  // route level (resolveApiKey's own unit suite covers the resolver exhaustively).
  it("200 with a valid per-tenant api_key — NO global key configured at all", async () => {
    const db = makeD1()
    await db.exec(MIGRATION_SQL_API_KEY)
    const plaintext = "sigilix_live_fleet_test"
    await insertApiKey(db, {
      id: "key-1",
      keyHash: await sha256Hex(plaintext),
      installationId: 42,
      createdBy: "1",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const { env } = mockEnv(false, { SIGILIX_PLATFORM_DB: db })
    const res = await handleFleetApiRoute(req({ findings: [{ category: "logic" }] }, plaintext), env)
    expect(res.status).toBe(200)
  })
  it("401 on a genuine D1 fault — fails CLOSED even though the presented bearer is the valid global key", async () => {
    const { env } = mockEnv(true, { SIGILIX_PLATFORM_DB: makeBrokenDb() })
    const res = await handleFleetApiRoute(req({ findings: [{ category: "logic" }] }, KEY), env)
    expect(res.status).toBe(401)
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
    expect(body.insights[0]!.insight).toContain("teams")
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
