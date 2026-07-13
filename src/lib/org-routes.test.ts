// org-routes.ts — dispatcher routing tests.
//
// These pin the dispatcher's match/fall-through decisions (the part index.ts
// used to make inline): OPTIONS preflight for the org surface, and `null` for
// anything that doesn't match so index.ts falls through to its own 404. The
// matched GET/POST paths themselves are exercised end-to-end (auth, CORS, DB)
// through worker.fetch in org-overview-route.test.ts / org-seat-route.test.ts.

import { describe, expect, it } from "vitest"
import { handleOrgRoutes } from "@/src/lib/org-routes"
import type { Env } from "@/src/shared/types/env"

// handlePortalPreflight only reads OPENCLAW_PORTAL_ORIGINS (defaults to
// https://app.sigilix.ai); the null/OPTIONS branches touch nothing else, so an
// empty env + stub ctx is sufficient for the routing decisions under test.
const env = {} as Env
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

const PORTAL_ORIGIN = "https://app.sigilix.ai"

describe("handleOrgRoutes dispatcher", () => {
  it("returns null when nothing under /v1/org/ matches (so index.ts falls through)", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "https://x/v1/org/1/members/dev/seat"], // seat path but wrong method
      ["POST", "https://x/v1/org/overview"], // overview path but wrong method
      ["DELETE", "https://x/v1/org/1/members/dev/seat"],
      ["PUT", "https://x/v1/org/1/members"],
      ["POST", "https://x/v1/org/1/members/222"],
      ["GET", "https://x/v1/org/unknown"],
      ["GET", "https://x/v1/other"],
    ]
    for (const [method, url] of cases) {
      const res = await handleOrgRoutes(new Request(url, { method }), env, ctx)
      expect(res, `${method} ${url}`).toBeNull()
    }
  })

  it("answers the CORS preflight for /v1/org/overview from an allowlisted origin", async () => {
    const req = new Request("https://x/v1/org/overview", {
      method: "OPTIONS",
      headers: { origin: PORTAL_ORIGIN },
    })
    const res = await handleOrgRoutes(req, env, ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(204)
    expect(res!.headers.get("access-control-allow-origin")).toBe(PORTAL_ORIGIN)
    expect(res!.headers.get("access-control-allow-credentials")).toBe("true")
    expect(res!.headers.get("access-control-allow-methods")).toContain("GET")
  })

  it("answers the CORS preflight for a seat path from an allowlisted origin", async () => {
    const req = new Request("https://x/v1/org/1/members/dev/seat", {
      method: "OPTIONS",
      headers: { origin: PORTAL_ORIGIN },
    })
    const res = await handleOrgRoutes(req, env, ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(204)
    expect(res!.headers.get("access-control-allow-methods")).toContain("POST")
  })

  it("answers CORS preflight for member collection and immutable-id item paths", async () => {
    for (const path of ["/v1/org/1/members", "/v1/org/1/members/222"]) {
      const req = new Request(`https://x${path}`, {
        method: "OPTIONS",
        headers: { origin: PORTAL_ORIGIN },
      })
      const res = await handleOrgRoutes(req, env, ctx)
      expect(res, path).not.toBeNull()
      expect(res!.status, path).toBe(204)
      expect(res!.headers.get("access-control-allow-methods")).toContain("PATCH")
      expect(res!.headers.get("access-control-allow-methods")).toContain("DELETE")
    }
  })

  it("rejects malformed member-route identifiers before authentication", async () => {
    const cases: Array<[string, string]> = [
      ["POST", "https://x/v1/org/not-a-number/members"],
      ["PATCH", "https://x/v1/org/1/members/not-an-id"],
    ]
    for (const [method, url] of cases) {
      const res = await handleOrgRoutes(
        new Request(url, { method, headers: { "content-type": "application/json" }, body: "{}" }),
        env,
        ctx,
      )
      expect(res, `${method} ${url}`).not.toBeNull()
      expect(res!.status, `${method} ${url}`).toBe(400)
    }
  })

  it("refuses the preflight for an org path from a non-allowlisted origin (403)", async () => {
    const req = new Request("https://x/v1/org/overview", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    })
    const res = await handleOrgRoutes(req, env, ctx)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
  })
})
