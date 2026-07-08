// auth-routes: the user-facing auth/identity sub-dispatcher. Pins the refactor
// that pulled the inline /auth/* branches out of src/index.ts (behavior must stay
// byte-identical) — including the deferred-provider 501 stubs that MOVED from the
// tail of index.ts into this dispatcher, and the fall-through (null) contract that
// lets index.ts keep matching non-auth routes.

import { describe, expect, it } from "vitest"
import worker from "@/src/index"
import { handleAuthRoutes } from "@/src/lib/auth-routes"
import type { Env } from "@/src/shared/types/env"

const CTX = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function call(method: string, path: string, env: Env = {} as Env) {
  const url = new URL(`https://api.sigilix.ai${path}`)
  return handleAuthRoutes(new Request(url.toString(), { method }), env, CTX, url)
}

describe("handleAuthRoutes — dispatcher", () => {
  it("routes the still-deferred provider stubs to 501 (bitbucket/azure)", async () => {
    for (const provider of ["bitbucket", "azure"]) {
      const res = await call("GET", `/auth/${provider}`)
      expect(res, `GET /auth/${provider}`).not.toBeNull()
      expect(res!.status).toBe(501)
      expect(await res!.text()).toContain("not implemented yet")
    }
  })

  it("routes GitLab login to the real handler — 503 when unconfigured (not the 501 stub)", async () => {
    // sig-gitlab-oauth-login: /auth/gitlab and /auth/gitlab/login now hit the real
    // kickoff, which 503s (graceful) with an empty env — NOT the deferred 501 stub.
    for (const path of ["/auth/gitlab", "/auth/gitlab/login"]) {
      const res = await call("GET", path, { OPENCLAW_STATE: {} } as unknown as Env)
      expect(res, `GET ${path}`).not.toBeNull()
      expect(res!.status).toBe(503)
      expect(await res!.text()).toContain("gitlab login not configured")
    }
  })

  it("delegates to the identity router (/auth/providers → 200 config)", async () => {
    // Empty env → github/google/gitlab unconfigured, password always available.
    // Proves the tryHandleIdentityRoute delegation is wired inside the dispatcher.
    const res = await call("GET", "/auth/providers")
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ github: false, google: false, gitlab: false, password: true })
  })

  it("returns null for a non-auth path (index.ts keeps matching)", async () => {
    expect(await call("GET", "/v1/keys")).toBeNull()
    expect(await call("POST", "/github/webhook")).toBeNull()
    expect(await call("GET", "/")).toBeNull()
  })

  it("wires into the worker entrypoint at the right slot (GET /auth/bitbucket → 501 via worker.fetch)", async () => {
    // Drives the REAL index.ts entrypoint to prove the dispatcher is invoked (and
    // still ahead of the 404 fall-through) after the refactor. Uses a STILL-stubbed
    // provider (GitLab now returns 503, not 501 — see the kickoff test above).
    const env = { OPENCLAW_STATE: undefined } as unknown as Env
    const res = await worker.fetch(new Request("https://api.sigilix.ai/auth/bitbucket"), env, CTX)
    expect(res.status).toBe(501)
    expect(await res.text()).toContain("not implemented yet")
  })
})
