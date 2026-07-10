// sig-portal-agent — tests for the in-portal coding-agent routes.
// Mirrors onboarding-context-route.test.ts's session + fetch-stubbing style.
// The GitHub App installation-token mint is avoided by pre-seeding the KV token
// cache (getInstallationToken returns a still-valid cached token without
// signing a JWT), so the happy path needs no RSA private key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleAgentBranchesRoute,
  handleAgentRunCreateRoute,
  handleAgentRunStatusRoute,
} from "@/src/lib/agent-portal-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const routeMocks = vi.hoisted(() => ({
  dispatchAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  getValidGithubToken: vi.fn(),
}))

vi.mock("@/src/lib/agent-runner/dispatch", () => ({
  dispatchAgentRun: routeMocks.dispatchAgentRun,
  getAgentRunStatus: routeMocks.getAgentRunStatus,
}))

vi.mock("@/src/lib/github-user-token", () => ({
  getValidGithubToken: routeMocks.getValidGithubToken,
}))

const SESSION_COOKIE = "__Host-sigilix_session"
const ENC_KEY = base64urlEncode(new Uint8Array(32).fill(9))
const TOKEN_CACHE_PREFIX = "gh-installation-token:"
const RUN_OWNER_PREFIX = "agent-run-owner:"

function makeKV(options: { failOwnerPut?: boolean } = {}): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      if (options.failOwnerPut && key.startsWith(RUN_OWNER_PREFIX)) throw new Error("owner binding unavailable")
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

async function seedSession(kv: KVNamespace, sessionId: string, githubUserId = 111): Promise<void> {
  await createSession({
    kv,
    sessionId,
    login: "octocat",
    githubUserId,
    accessToken: "ghu_test_token",
    encryptionKeyB64url: ENC_KEY,
  })
}

async function seedRunOwner(
  kv: KVNamespace,
  runId: string,
  owner: { installationId?: number; owner?: string; repo?: string; githubUserId?: number } = {},
): Promise<void> {
  await kv.put(
    `${RUN_OWNER_PREFIX}${runId}`,
    JSON.stringify({ installationId: 42, owner: "acme", repo: "api", githubUserId: 111, ...owner }),
  )
}

/** Pre-seed a still-valid installation token so getInstallationToken skips the JWT sign. */
async function seedInstallationToken(kv: KVNamespace, installationId: number): Promise<void> {
  await kv.put(
    `${TOKEN_CACHE_PREFIX}${installationId}`,
    JSON.stringify({ token: "ghs_installation_token", expiresAt: Date.now() + 60 * 60 * 1000 }),
  )
}

function reqGet(url: string, sessionId: string | null): Request {
  const headers = new Headers()
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { headers })
}

function reqPost(url: string, sessionId: string | null, body: unknown): Request {
  const headers = new Headers({ "content-type": "application/json" })
  if (sessionId) headers.set("cookie", `${SESSION_COOKIE}=${sessionId}`)
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) })
}

function reqRawPost(url: string, sessionId: string, body: string, contentType = "application/json"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": contentType, cookie: `${SESSION_COOKIE}=${sessionId}` },
    body,
  })
}

function baseEnv(kv: KVNamespace, overrides: Record<string, unknown> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_SESSION_ENCRYPTION_KEY: ENC_KEY,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: "unused-cached-token-path",
    ...overrides,
  } as unknown as Env
}

function githubUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString()
}

/** Stub GitHub so the caller has exact App scope to the supplied installation repositories. */
function stubGithubOwning42(repos = ["acme/api"]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = githubUrl(input)
      if (url.startsWith("https://api.github.com/user/installations?")) {
        return new Response(JSON.stringify({ total_count: 1, installations: [{ id: 42 }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/user/installations/42/repositories?")) {
        return new Response(JSON.stringify({ repositories: repos.map((full_name) => ({ full_name })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://api.github.com/repos/acme/api") {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/repos/acme/api/branches?")) {
        return new Response(
          JSON.stringify([
            { name: "main", protected: true },
            { name: "feature/x", protected: false },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      if (url === "https://api.github.com/repos/acme/private") {
        return new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/repos/acme/private/branches?")) {
        return new Response(JSON.stringify([{ name: "main", protected: true }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

beforeEach(() => {
  routeMocks.dispatchAgentRun.mockReset()
  routeMocks.dispatchAgentRun.mockImplementation(async (_env: Env, input: { runId: string }) => ({
    runId: input.runId,
    dispatched: true,
    outcome: { status: "started" },
  }))
  routeMocks.getAgentRunStatus.mockReset()
  routeMocks.getAgentRunStatus.mockResolvedValue(null)
  routeMocks.getValidGithubToken.mockReset()
  routeMocks.getValidGithubToken.mockResolvedValue("ghu_refreshed_token")
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("handleAgentBranchesRoute (GET /v1/agent/branches)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/api", null),
      baseEnv(kv),
    )
    expect(res.status).toBe(401)
  })

  it("400 on missing / malformed params", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    const env = baseEnv(kv)
    expect((await handleAgentBranchesRoute(reqGet("https://x/v1/agent/branches", "s1"), env)).status).toBe(400)
    expect(
      (await handleAgentBranchesRoute(reqGet("https://x/v1/agent/branches?installationId=42&repo=nope", "s1"), env))
        .status,
    ).toBe(400)
  })

  it("403 when the session does not control the installation (fails closed)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ total_count: 0, installations: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/api", "s1"),
      baseEnv(kv),
    )
    expect(res.status).toBe(403)
  })

  it("502 when the exact GitHub repository-scope lookup fails", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream failed", { status: 500 })),
    )
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/api", "s1"),
      baseEnv(kv),
    )
    expect(res.status).toBe(502)
  })

  it("403 for a different repository inside an installation the user otherwise controls", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await seedInstallationToken(kv, 42)
    stubGithubOwning42(["acme/allowed"])
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/private", "s1"),
      baseEnv(kv),
    )
    expect(res.status).toBe(403)
  })

  it("uses the refresh-aware GitHub user-token seam for authorization", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await seedInstallationToken(kv, 42)
    stubGithubOwning42()
    const env = baseEnv(kv)
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/api", "s1"),
      env,
    )
    expect(res.status).toBe(200)
    expect(routeMocks.getValidGithubToken).toHaveBeenCalledWith(
      expect.objectContaining({ env, sessionId: "s1", encryptionKeyB64url: ENC_KEY }),
    )
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining("https://api.github.com/user/installations?"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer ghu_refreshed_token" }),
      }),
    )
  })

  it("happy path: returns defaultBranch + branches for an owned installation", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await seedInstallationToken(kv, 42)
    stubGithubOwning42()
    const res = await handleAgentBranchesRoute(
      reqGet("https://x/v1/agent/branches?installationId=42&repo=acme/api", "s1"),
      baseEnv(kv),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      defaultBranch: string | null
      branches: { name: string; protected: boolean }[]
    }
    expect(body.defaultBranch).toBe("main")
    expect(body.branches).toEqual([
      { name: "main", protected: true },
      { name: "feature/x", protected: false },
    ])
  })
})

describe("handleAgentRunCreateRoute (POST /v1/agent/runs)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", null, { installationId: 42, repo: "acme/api", prompt: "fix" }),
      baseEnv(kv),
    )
    expect(res.status).toBe(401)
  })

  it("400 on a missing prompt", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "  " }),
      baseEnv(kv),
    )
    expect(res.status).toBe(400)
  })

  it("415 when the content-type is not application/json (CSRF guard)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const res = await handleAgentRunCreateRoute(
      reqRawPost(
        "https://x/v1/agent/runs",
        "s1",
        JSON.stringify({ installationId: 42, repo: "acme/api", prompt: "fix" }),
        "text/plain",
      ),
      baseEnv(kv),
    )
    expect(res.status).toBe(415)
    expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()
  })

  it.each(["null", "[]", '"string"', "42", "true"])(
    "400 for a JSON body that is not a plain object: %s",
    async (rawBody) => {
      const kv = makeKV()
      await seedSession(kv, "s1")
      const res = await handleAgentRunCreateRoute(reqRawPost("https://x/v1/agent/runs", "s1", rawBody), baseEnv(kv))
      expect(res.status).toBe(400)
      expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()
    },
  )

  it("403 when the session does not control the installation", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ total_count: 0, installations: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix" }),
      baseEnv(kv),
    )
    expect(res.status).toBe(403)
  })

  it("403 for a different repository inside an installation the user otherwise controls", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42(["acme/allowed"])
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", {
        installationId: 42,
        repo: "acme/private",
        prompt: "fix",
      }),
      baseEnv(kv),
    )
    expect(res.status).toBe(403)
    expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()
  })

  it("returns an honest, non-pollable preview without dispatch when the runner is dark", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    // OPENCLAW_AGENT_RUNNER_MODE unset → dark → preview, never a fake PR.
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix the bug" }),
      baseEnv(kv),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string; dispatched: boolean; status: string; prUrl?: string }
    expect(body.dispatched).toBe(false)
    expect(body.status).toBe("preview")
    expect(body.prUrl).toBeUndefined()
    expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()

    const polled = await handleAgentRunStatusRoute(
      reqGet(`https://x/v1/agent/runs/${body.runId}`, "s1"),
      baseEnv(kv),
      body.runId,
    )
    expect(polled.status).toBe(404)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it.each([
    ["portal gate is off", "on", undefined],
    ["global gate is off", undefined, "on"],
  ])("does not dispatch when %s", async (_label, globalMode, portalMode) => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix" }),
      baseEnv(kv, {
        OPENCLAW_AGENT_RUNNER_MODE: globalMode,
        SIGILIX_PORTAL_AGENT_RUNNER_MODE: portalMode,
        OLLAMA_API_KEY: "model-key",
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({ dispatched: false, status: "preview" }))
    expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()
  })

  it("dispatches only when both the portal-specific and global gates are on", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const env = baseEnv(kv, {
      OPENCLAW_AGENT_RUNNER_MODE: "on",
      SIGILIX_PORTAL_AGENT_RUNNER_MODE: "on",
      OLLAMA_API_KEY: "model-key",
    })
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix" }),
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(expect.objectContaining({ dispatched: true, status: "started" }))
    expect(routeMocks.dispatchAgentRun).toHaveBeenCalledTimes(1)
  })

  it("does not dispatch when the durable run-owner binding cannot be written", async () => {
    const kv = makeKV({ failOwnerPut: true })
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix" }),
      baseEnv(kv, {
        OPENCLAW_AGENT_RUNNER_MODE: "on",
        SIGILIX_PORTAL_AGENT_RUNNER_MODE: "on",
        OLLAMA_API_KEY: "model-key",
      }),
    )
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(routeMocks.dispatchAgentRun).not.toHaveBeenCalled()
  })
})

describe("handleAgentRunStatusRoute (GET /v1/agent/runs/:runId)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentRunStatusRoute(reqGet("https://x/v1/agent/runs/abc", null), baseEnv(kv), "abc")
    expect(res.status).toBe(401)
  })

  it("404 for an unknown runId (no owner binding — fails closed, no oracle)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const res = await handleAgentRunStatusRoute(reqGet("https://x/v1/agent/runs/nope", "s1"), baseEnv(kv), "nope")
    expect(res.status).toBe(404)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("404 for a legacy installation-only binding (fails closed)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await kv.put(`${RUN_OWNER_PREFIX}legacy`, "42")
    stubGithubOwning42()
    const res = await handleAgentRunStatusRoute(reqGet("https://x/v1/agent/runs/legacy", "s1"), baseEnv(kv), "legacy")
    expect(res.status).toBe(404)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("404 when a different GitHub user controls the same repository (IDOR guard)", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "foreign-user")
    await seedSession(kv, "intruder", 222)
    stubGithubOwning42()
    const res = await handleAgentRunStatusRoute(
      reqGet("https://x/v1/agent/runs/foreign-user", "intruder"),
      baseEnv(kv),
      "foreign-user",
    )
    expect(res.status).toBe(404) // not 200, not the record — no existence oracle
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("404 when the bound GitHub user no longer has exact repository scope", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "foreign-repo")
    await seedSession(kv, "owner", 111)
    stubGithubOwning42(["acme/allowed"])
    const res = await handleAgentRunStatusRoute(
      reqGet("https://x/v1/agent/runs/foreign-repo", "owner"),
      baseEnv(kv),
      "foreign-repo",
    )
    expect(res.status).toBe(404)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("502 when live repository-scope authorization cannot be completed", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "scope-fault")
    await seedSession(kv, "owner", 111)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream failed", { status: 500 })),
    )
    const res = await handleAgentRunStatusRoute(
      reqGet("https://x/v1/agent/runs/scope-fault", "owner"),
      baseEnv(kv),
      "scope-fault",
    )
    expect(res.status).toBe(502)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("200 (pending) for the run's owner before a record is written", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "owned")
    await seedSession(kv, "owner", 111)
    stubGithubOwning42()
    const env = baseEnv(kv)
    const res = await handleAgentRunStatusRoute(reqGet("https://x/v1/agent/runs/owned", "owner"), env, "owned")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string; status: string }
    expect(body.runId).toBe("owned")
    expect(body.status).toBe("pending")
    expect(routeMocks.getAgentRunStatus).toHaveBeenCalledWith(env, "owned")
  })
})
