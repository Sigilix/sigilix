import { describe, it, expect } from "vitest"
import { admitTenant, releaseTenant } from "@/src/features/tenancy"
import type { Env } from "@/src/shared/types/env"

function envWith(fetchImpl: (req: Request) => Promise<Response>): Env {
  return {
    TENANT_CONCURRENCY: {
      idFromName: (n: string) => ({ toString: () => n }),
      get: () => ({ fetch: (req: Request) => fetchImpl(req) }),
    },
  } as unknown as Env
}

describe("admitTenant", () => {
  it("returns the DO verdict", async () => {
    const env = envWith(
      async () => new Response(JSON.stringify({ granted: false, retryAfterMs: 1234 }), { status: 200 }),
    )
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r).toEqual({ granted: false, retryAfterMs: 1234 })
  })

  it("FAILS OPEN on a DO error (granted=true)", async () => {
    const env = envWith(async () => {
      throw new Error("DO down")
    })
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r).toEqual({ granted: true, retryAfterMs: 0 })
  })

  it("FAILS OPEN on a non-200 (granted=true)", async () => {
    const env = envWith(async () => new Response("nope", { status: 500 }))
    const r = await admitTenant({ env, tenantId: "42", leaseId: "l1", cap: 2 })
    expect(r.granted).toBe(true)
  })

  it("releaseTenant never throws", async () => {
    const env = envWith(async () => {
      throw new Error("boom")
    })
    await expect(releaseTenant(env, "42", "l1")).resolves.toBeUndefined()
  })
})
