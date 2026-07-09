// sig-health-endpoints — tests for the public, dependency-aware health probes.
//
// Proves the DOWN-path fires (not just the happy path): a failing/absent
// dependency yields degraded/down and the correct HTTP status, and a hung model
// probe times out to degraded WITHOUT hanging the route.

import { describe, it, expect, vi } from "vitest"
import {
  handleHealthRoute,
  handleModelsHealthRoute,
  handleIntegrationsHealthRoute,
  tryHandleHealthRoute,
  type HealthResponse,
  type ModelsHealthDeps,
  type IntegrationsHealthDeps,
} from "@/src/lib/health-routes"
import type { Env } from "@/src/shared/types/env"

// Mock the Vertex token mint so the DEFAULT models-probe path can be exercised
// (incl. the hung-mint timeout) with zero network. `vi.hoisted` gives the mock
// fn a stable identity the factory + tests share.
const { mintMock } = vi.hoisted(() => ({ mintMock: vi.fn() }))
vi.mock("@/src/lib/boreas-gateway/vertex-token", () => ({
  getVertexAccessToken: mintMock,
}))

// ── stubs ────────────────────────────────────────────────────────────────────

/** KV stub: `get` resolves null (a miss still proves reachability) or throws. */
function kvStub(mode: "ok" | "throw" | "hang"): KVNamespace {
  return {
    get: vi.fn(async () => {
      if (mode === "throw") throw new Error("kv down")
      if (mode === "hang") return await new Promise(() => {}) // never resolves
      return null
    }),
  } as unknown as KVNamespace
}

/** D1 stub: `SELECT 1` resolves a row or throws. */
function d1Stub(mode: "ok" | "throw"): D1Database {
  return {
    prepare: vi.fn(() => ({
      first: vi.fn(async () => {
        if (mode === "throw") throw new Error("d1 down")
        return { "1": 1 }
      }),
    })),
  } as unknown as D1Database
}

const ctxStub = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

async function bodyOf(res: Response): Promise<HealthResponse> {
  return (await res.json()) as HealthResponse
}

/** Assert a named check exists and return it (satisfies noUncheckedIndexedAccess). */
function chk(body: HealthResponse, name: string) {
  const c = body.checks[name]
  expect(c, `check "${name}" missing`).toBeDefined()
  return c!
}

// ── GET /health ────────────────────────────────────────────────────────────

describe("handleHealthRoute", () => {
  it("healthy KV + D1 → 200 operational", async () => {
    const env = { OPENCLAW_STATE: kvStub("ok"), SIGILIX_PLATFORM_DB: d1Stub("ok") } as unknown as Env
    const res = await handleHealthRoute(env)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "kv").status).toBe("operational")
    expect(chk(body, "d1").status).toBe("operational")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    expect(res.headers.get("cache-control")).toContain("max-age")
    expect(typeof body.ts).toBe("string")
  })

  it("D1 unbound → 200 operational, d1 not_configured", async () => {
    const env = { OPENCLAW_STATE: kvStub("ok") } as unknown as Env
    const res = await handleHealthRoute(env)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "d1").status).toBe("not_configured")
  })

  it("DOWN-path: KV throws → 503 down (core dependency)", async () => {
    const env = { OPENCLAW_STATE: kvStub("throw"), SIGILIX_PLATFORM_DB: d1Stub("ok") } as unknown as Env
    const res = await handleHealthRoute(env)
    const body = await bodyOf(res)
    expect(res.status).toBe(503)
    expect(body.status).toBe("down")
    expect(chk(body, "kv").status).toBe("down")
  })

  it("DOWN-path: D1 query fails → 200 degraded (optional dependency)", async () => {
    const env = { OPENCLAW_STATE: kvStub("ok"), SIGILIX_PLATFORM_DB: d1Stub("throw") } as unknown as Env
    const res = await handleHealthRoute(env)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("degraded")
    expect(chk(body, "d1").status).toBe("degraded")
  })

  it("never leaks secrets: response body is only statuses + short details", async () => {
    const env = { OPENCLAW_STATE: kvStub("ok"), SIGILIX_PLATFORM_DB: d1Stub("throw") } as unknown as Env
    const raw = await (await handleHealthRoute(env)).text()
    expect(raw).not.toMatch(/token|secret|key|password/i)
  })
})

// ── GET /health/models ───────────────────────────────────────────────────────

// A serveable gateway route needs BOTH an auth config AND the issuer (mirrors the
// `/v1/*` 503 preconditions in vertex-chat-route.ts).
const configuredGatewayEnv = {
  OPENCLAW_SIGILIX_API_KEY: "shared-bearer",
  OPENCLAW_SESSION_ENCRYPTION_KEY: "x",
  OPENCLAW_GATEWAY_ISSUER: "https://api.sigilix.ai",
} as unknown as Env

describe("handleModelsHealthRoute", () => {
  it("gateway token mint ok → 200 operational, all models operational", async () => {
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => true) }
    const res = await handleModelsHealthRoute(configuredGatewayEnv, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "gateway").status).toBe("operational")
    expect(chk(body, "boreas").status).toBe("operational")
    expect(chk(body, "pyroeis").status).toBe("operational")
    expect(chk(body, "astraeus").status).toBe("operational")
  })

  it("DOWN-path: Vertex down + only a Turbo key → 200 degraded (per-model fallback)", async () => {
    // OLLAMA key alone gives Boreas + Astraeus a Turbo leg (both have a built-in
    // default model); Pyroeis has NO default so it stays down. Partial → degraded.
    const env = { ...configuredGatewayEnv, OLLAMA_API_KEY: "turbo" } as unknown as Env
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => false) }
    const res = await handleModelsHealthRoute(env, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("degraded")
    expect(chk(body, "gateway").status).toBe("down")
    expect(chk(body, "boreas").status).toBe("degraded")
    expect(chk(body, "astraeus").status).toBe("degraded")
    // Pyroeis has no built-in Turbo default → down without an explicit env var.
    expect(chk(body, "pyroeis").status).toBe("down")
  })

  it("DOWN-path: Vertex down + Pyroeis has its OWN explicit Turbo fallback → pyroeis degraded", async () => {
    const env = {
      ...configuredGatewayEnv,
      OLLAMA_API_KEY: "turbo",
      OPENCLAW_PYROEIS_FALLBACK_TURBO_MODEL: "some-turbo-model:cloud",
    } as unknown as Env
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => false) }
    const res = await handleModelsHealthRoute(env, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("degraded")
    expect(chk(body, "pyroeis").status).toBe("degraded")
  })

  it("DOWN-path: Vertex down + AWS keys but NO region/model-id → NOT a bedrock fallback → 503 down", async () => {
    // Mirrors isBedrockConfigured: without region + a per-model Bedrock model id,
    // the Bedrock leg is skipped, so incomplete AWS creds must NOT mask an outage.
    const env = {
      ...configuredGatewayEnv,
      OPENCLAW_AWS_ACCESS_KEY_ID: "AKIA",
      OPENCLAW_AWS_SECRET_ACCESS_KEY: "secret",
    } as unknown as Env
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => false) }
    const res = await handleModelsHealthRoute(env, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(503)
    expect(body.status).toBe("down")
    expect(chk(body, "boreas").status).toBe("down")
  })

  it("DOWN-path: Vertex leg down AND no fallback anywhere → 503 down (all models)", async () => {
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => false) }
    const res = await handleModelsHealthRoute(configuredGatewayEnv, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(503)
    expect(body.status).toBe("down")
    expect(chk(body, "gateway").status).toBe("down")
    expect(chk(body, "boreas").status).toBe("down")
    expect(chk(body, "pyroeis").status).toBe("down")
    expect(chk(body, "astraeus").status).toBe("down")
    expect(deps.probeGateway).toHaveBeenCalledTimes(1)
  })

  it("DOWN-path: gateway route not configured (no issuer) → 503 down, probe NOT called", async () => {
    // Missing the issuer → `/v1/*` 503s before the failover chain, so NO fallback
    // can serve. Even with a Turbo key configured the component is fully down.
    const env = { OPENCLAW_SIGILIX_API_KEY: "k", OLLAMA_API_KEY: "turbo" } as unknown as Env
    const deps: ModelsHealthDeps = { probeGateway: vi.fn(async () => true) }
    const res = await handleModelsHealthRoute(env, ctxStub, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(503)
    expect(body.status).toBe("down")
    expect(chk(body, "gateway").status).toBe("down")
    expect(chk(body, "boreas").status).toBe("down")
    expect(chk(body, "pyroeis").status).toBe("down")
    // Inert route → the probe is never called (no wasted token mint).
    expect(deps.probeGateway).not.toHaveBeenCalled()
  })

  it("DOWN-path: default probe path — a real mint success → 200 operational", async () => {
    mintMock.mockResolvedValueOnce("ya29.a-real-looking-token")
    const res = await handleModelsHealthRoute(configuredGatewayEnv, ctxStub)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "gateway").status).toBe("operational")
  })

  it("DOWN-path: default probe path — a mint that throws → gateway down", async () => {
    mintMock.mockRejectedValueOnce(new Error("WIF exchange failed"))
    const env = { ...configuredGatewayEnv, OLLAMA_API_KEY: "turbo" } as unknown as Env
    const res = await handleModelsHealthRoute(env, ctxStub)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("degraded")
    expect(chk(body, "gateway").status).toBe("down")
  })

  it("TIMEOUT-path: a hung token mint times out to a false probe WITHOUT hanging the route", async () => {
    vi.useFakeTimers()
    try {
      const env = { ...configuredGatewayEnv, OLLAMA_API_KEY: "turbo" } as unknown as Env
      // The mint never resolves; the real `probe`'s Promise.race timer must fire
      // and yield degraded (turbo fallback) rather than hanging the route.
      mintMock.mockImplementationOnce(() => new Promise<string>(() => {}))

      const pending = handleModelsHealthRoute(env, ctxStub)
      // Advance past the probe timeout so the race resolves — proves no hang.
      await vi.advanceTimersByTimeAsync(3_000)
      const res = await pending
      const body = await bodyOf(res)
      expect(res.status).toBe(200)
      expect(body.status).toBe("degraded")
      expect(chk(body, "gateway").status).toBe("down")
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── GET /health/integrations ──────────────────────────────────────────────────

describe("handleIntegrationsHealthRoute", () => {
  it("configured + reachable → 200 operational", async () => {
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "k",
      SIGILIX_GITLAB_TOKEN: "t",
      SLACK_BOT_TOKEN: "b",
      LINEAR_API_KEY: "l",
    } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "github").status).toBe("operational")
    expect(chk(body, "gitlab").status).toBe("operational")
    expect(chk(body, "slack").status).toBe("operational")
    expect(chk(body, "linear").status).toBe("operational")
  })

  it("DEGRADE-path: configured but host unreachable → 200 degraded", async () => {
    const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k" } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => false) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("degraded")
    expect(chk(body, "github").status).toBe("degraded")
    // Unconfigured integrations don't drag the overall below degraded.
    expect(chk(body, "slack").status).toBe("not_configured")
  })

  it("Linear configured via a COMPLETE OAuth id+secret pair → operational", async () => {
    const env = { LINEAR_OAUTH_CLIENT_ID: "oauth-app", LINEAR_OAUTH_CLIENT_SECRET: "shh" } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(chk(body, "linear").status).toBe("operational")
  })

  it("Linear with only a client id (NO secret) → not_configured (can't exchange tokens)", async () => {
    const env = { LINEAR_OAUTH_CLIENT_ID: "oauth-app" } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(chk(body, "linear").status).toBe("not_configured")
  })

  it("Linear configured via the dedicated agent id+secret pair → operational", async () => {
    const env = {
      OPENCLAW_LINEAR_AGENT_CLIENT_ID: "agent-app",
      OPENCLAW_LINEAR_AGENT_CLIENT_SECRET: "shh",
    } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(chk(body, "linear").status).toBe("operational")
  })

  it("GitLab with only a client id (NO secret, no token) → not_configured", async () => {
    const env = { SIGILIX_GITLAB_OAUTH_CLIENT_ID: "gl-app" } as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(chk(body, "gitlab").status).toBe("not_configured")
  })

  it("CONCURRENCY: all configured probes run in parallel — one timeout window, not the sum", async () => {
    vi.useFakeTimers()
    try {
      const env = {
        GITHUB_APP_ID: "1",
        GITHUB_PRIVATE_KEY: "k",
        SIGILIX_GITLAB_TOKEN: "t",
        SLACK_BOT_TOKEN: "b",
        LINEAR_API_KEY: "l",
      } as unknown as Env
      // Every reach hangs. If the four probes were sequential they'd need 4×
      // PROBE_TIMEOUT_MS to all fire; a single advance settling them all proves
      // they ran concurrently (Promise.all).
      const deps: IntegrationsHealthDeps = { reach: vi.fn(() => new Promise<boolean>(() => {})) }
      const pending = handleIntegrationsHealthRoute(env, deps)
      await vi.advanceTimersByTimeAsync(3_000)
      const res = await pending
      const body = await bodyOf(res)
      expect(res.status).toBe(200)
      expect(body.status).toBe("degraded")
      expect(chk(body, "github").status).toBe("degraded")
      expect(chk(body, "linear").status).toBe("degraded")
      expect(deps.reach).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it("all unconfigured → 200 operational (not_configured is neutral, never a crash)", async () => {
    const env = {} as unknown as Env
    const deps: IntegrationsHealthDeps = { reach: vi.fn(async () => true) }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(body.status).toBe("operational")
    expect(chk(body, "github").status).toBe("not_configured")
    expect(deps.reach).not.toHaveBeenCalled()
  })

  it("FAIL-SAFE: a throwing reach probe degrades, never crashes the route", async () => {
    const env = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY: "k" } as unknown as Env
    const deps: IntegrationsHealthDeps = {
      reach: vi.fn(async () => {
        throw new Error("network boom")
      }),
    }
    const res = await handleIntegrationsHealthRoute(env, deps)
    const body = await bodyOf(res)
    expect(res.status).toBe(200)
    expect(chk(body, "github").status).toBe("degraded")
  })
})

// ── dispatcher ────────────────────────────────────────────────────────────────

describe("tryHandleHealthRoute", () => {
  const env = { OPENCLAW_STATE: kvStub("ok") } as unknown as Env

  it("GET / → the unchanged plaintext liveness probe", async () => {
    const res = await tryHandleHealthRoute(
      new Request("https://api.sigilix.ai/"),
      env,
      ctxStub,
      new URL("https://api.sigilix.ai/"),
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(await res!.text()).toBe("Sigilix — alive\n")
  })

  it("GET /health → routed to the core health JSON", async () => {
    const res = await tryHandleHealthRoute(
      new Request("https://api.sigilix.ai/health"),
      env,
      ctxStub,
      new URL("https://api.sigilix.ai/health"),
    )
    expect(res).not.toBeNull()
    expect(res!.headers.get("content-type")).toBe("application/json")
  })

  it("non-GET or unknown path → null (falls through to the rest of routing)", async () => {
    const post = await tryHandleHealthRoute(
      new Request("https://api.sigilix.ai/health", { method: "POST" }),
      env,
      ctxStub,
      new URL("https://api.sigilix.ai/health"),
    )
    expect(post).toBeNull()
    const other = await tryHandleHealthRoute(
      new Request("https://api.sigilix.ai/v1/review"),
      env,
      ctxStub,
      new URL("https://api.sigilix.ai/v1/review"),
    )
    expect(other).toBeNull()
  })
})
