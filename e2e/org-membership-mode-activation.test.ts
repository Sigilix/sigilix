import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import worker from "@/src/index"
import type { Env } from "@/src/shared/types/env"

const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8")
const configured = /OPENCLAW_ORG_MEMBERSHIP_MODE\s*=\s*"([^"]*)"/u.exec(wrangler)?.[1]
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
const OPERATOR_TOKEN = "test-operator-token-never-valid-in-production"

describe("organization membership production activation", () => {
  it("routes production config through the managed-access worker path", async () => {
    expect(configured, "OPENCLAW_ORG_MEMBERSHIP_MODE in wrangler.toml").toBe("on")
    const env = {
      OPENCLAW_ADMIN_TOKEN: OPERATOR_TOKEN,
      OPENCLAW_ORG_MEMBERSHIP_MODE: configured,
    } as unknown as Env

    const backfill = await worker.fetch(
      new Request("https://api.sigilix.ai/admin/org-access/backfill", {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ installationId: 42, apply: false }),
      }),
      env,
      ctx,
    )
    expect(backfill.status).toBe(409)
    await expect(backfill.json()).resolves.toEqual({ error: "org_membership_already_enabled" })

    const recovery = await worker.fetch(
      new Request("https://api.sigilix.ai/admin/org-access/recover", {
        method: "POST",
        headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      }),
      env,
      ctx,
    )
    expect(recovery.status).toBe(415)
    await expect(recovery.json()).resolves.toEqual({ error: "content-type must be application/json" })
  })
})
