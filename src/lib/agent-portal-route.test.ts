// sig-portal-agent — tests for the in-portal coding-agent routes.
// Mirrors onboarding-context-route.test.ts's session + fetch-stubbing style.
// The GitHub App installation-token mint is avoided by pre-seeding the KV token
// cache (getInstallationToken returns a still-valid cached token without
// signing a JWT), so the happy path needs no RSA private key.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  handleAgentBranchCreateRoute,
  handleAgentBranchesRoute,
  handleAgentEventIngestRoute,
  handleAgentRunCreateRoute,
  handleAgentRunDiffRoute,
  handleAgentRunEventsRoute,
  handleAgentRunStatusRoute,
} from "@/src/lib/agent-portal-route"
import { base64urlEncode, createSession } from "@/src/lib/auth-session"
import type { Env } from "@/src/shared/types/env"

const routeMocks = vi.hoisted(() => ({
  dispatchAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
  getAgentRunEvents: vi.fn(),
  appendAgentRunEvent: vi.fn(),
  getValidGithubToken: vi.fn(),
  renderChatSurfaceMemoryForPrompt: vi.fn(),
}))

vi.mock("@/src/lib/agent-runner/dispatch", () => ({
  dispatchAgentRun: routeMocks.dispatchAgentRun,
  getAgentRunStatus: routeMocks.getAgentRunStatus,
  getAgentRunEvents: routeMocks.getAgentRunEvents,
  appendAgentRunEvent: routeMocks.appendAgentRunEvent,
}))

vi.mock("@/src/lib/github-user-token", () => ({
  getValidGithubToken: routeMocks.getValidGithubToken,
}))

// Surface memory apply — the chat-surface helper is exercised for real in
// agent-memory-chat-surface.test.ts; here we mock it to pin the ROUTE's wiring
// (it is called with the trusted session + authorized target, and its output is
// injected as grounding only when non-empty).
vi.mock("@/src/lib/agent-memory", () => ({
  renderChatSurfaceMemoryForPrompt: routeMocks.renderChatSurfaceMemoryForPrompt,
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
      if (url.startsWith("https://api.github.com/repos/acme/api/pulls/7/files?")) {
        return new Response(
          JSON.stringify([
            { filename: "src/a.ts", status: "modified", additions: 5, deletions: 2, patch: "@@ -1 +1 @@\n-old\n+new" },
            { filename: "src/b.ts", status: "added", additions: 10, deletions: 0, patch: "@@ -0,0 +1 @@\n+added" },
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
  routeMocks.getAgentRunEvents.mockReset()
  routeMocks.getAgentRunEvents.mockResolvedValue({ events: [], cursor: 0 })
  routeMocks.appendAgentRunEvent.mockReset()
  routeMocks.appendAgentRunEvent.mockResolvedValue({ ok: true, seq: 1 })
  routeMocks.getValidGithubToken.mockReset()
  routeMocks.getValidGithubToken.mockResolvedValue("ghu_refreshed_token")
  routeMocks.renderChatSurfaceMemoryForPrompt.mockReset()
  routeMocks.renderChatSurfaceMemoryForPrompt.mockResolvedValue({ block: "" })
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

  it("injects resolved org∪repo∪seat memory as grounding, resolved from the trusted session (not the prompt)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const memoryBlock = "## Team & repository guidance\n- [org policy — must follow] Require a rollback plan."
    routeMocks.renderChatSurfaceMemoryForPrompt.mockResolvedValue({ block: memoryBlock })
    const env = baseEnv(kv, {
      OPENCLAW_AGENT_RUNNER_MODE: "on",
      SIGILIX_PORTAL_AGENT_RUNNER_MODE: "on",
      OLLAMA_API_KEY: "model-key",
    })
    const res = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix the bug" }),
      env,
    )
    expect(res.status).toBe(200)
    // installationId + repo come from the authorized target; the seat identity is
    // the trusted session — NEVER the message/prompt content.
    expect(routeMocks.renderChatSurfaceMemoryForPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 42,
        repo: { owner: "acme", name: "api" },
        session: expect.objectContaining({ record: expect.objectContaining({ githubUserId: 111 }) }),
      }),
    )
    // The resolved block is forwarded to the runner as assembled grounding context.
    expect(routeMocks.dispatchAgentRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ grounding: memoryBlock }),
    )
  })

  it("omits grounding when the memory apply flag is off (helper returns '') — a true no-op", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    routeMocks.renderChatSurfaceMemoryForPrompt.mockResolvedValue({ block: "" }) // flag off / nothing to apply
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
    expect(routeMocks.dispatchAgentRun).toHaveBeenCalledTimes(1)
    const dispatchArg = routeMocks.dispatchAgentRun.mock.calls[0]![1] as Record<string, unknown>
    expect(dispatchArg).not.toHaveProperty("grounding")
  })

  it("surfaces the helper's display-only provenance on the run response (flag on); omits it otherwise", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const provenance = {
      items: [{ id: "o1", label: "no raw SQL", scope: "org" }],
      total: 1,
      orgCount: 1,
      repoCount: 0,
      suppressCount: 0,
    }
    routeMocks.renderChatSurfaceMemoryForPrompt.mockResolvedValue({ block: "## guidance", provenance })
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
    const body = (await res.json()) as Record<string, unknown>
    expect(body.provenance).toEqual(provenance)

    // Helper returns no provenance (flag off) → no field on the response.
    routeMocks.dispatchAgentRun.mockClear()
    routeMocks.renderChatSurfaceMemoryForPrompt.mockResolvedValue({ block: "## guidance" })
    const res2 = await handleAgentRunCreateRoute(
      reqPost("https://x/v1/agent/runs", "s1", { installationId: 42, repo: "acme/api", prompt: "fix" }),
      env,
    )
    const body2 = (await res2.json()) as Record<string, unknown>
    expect("provenance" in body2).toBe(false)
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

describe("handleAgentRunDiffRoute (GET /v1/agent/runs/:runId/diff)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentRunDiffRoute(reqGet("https://x/v1/agent/runs/abc/diff", null), baseEnv(kv), "abc")
    expect(res.status).toBe(401)
  })

  it("404 for an unknown runId (no owner binding — no oracle)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubOwning42()
    const res = await handleAgentRunDiffRoute(reqGet("https://x/v1/agent/runs/nope/diff", "s1"), baseEnv(kv), "nope")
    expect(res.status).toBe(404)
  })

  it("404 when a different GitHub user owns the run (IDOR guard)", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "foreign")
    await seedSession(kv, "intruder", 222)
    stubGithubOwning42()
    const res = await handleAgentRunDiffRoute(
      reqGet("https://x/v1/agent/runs/foreign/diff", "intruder"),
      baseEnv(kv),
      "foreign",
    )
    expect(res.status).toBe(404)
    expect(routeMocks.getAgentRunStatus).not.toHaveBeenCalled()
  })

  it("ready:false before the run has opened a PR", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "run1")
    await seedSession(kv, "owner", 111)
    stubGithubOwning42()
    routeMocks.getAgentRunStatus.mockResolvedValue({ status: "started" })
    const env = baseEnv(kv)
    const res = await handleAgentRunDiffRoute(reqGet("https://x/v1/agent/runs/run1/diff", "owner"), env, "run1")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ready: boolean; status: string }
    expect(body.ready).toBe(false)
    expect(body.status).toBe("started")
  })

  it("returns the opened PR's diff files with summed additions/deletions", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "run7")
    await seedSession(kv, "owner", 111)
    await seedInstallationToken(kv, 42)
    stubGithubOwning42()
    routeMocks.getAgentRunStatus.mockResolvedValue({
      status: "opened",
      prUrl: "https://github.com/acme/api/pull/7",
    })
    const env = baseEnv(kv)
    const res = await handleAgentRunDiffRoute(reqGet("https://x/v1/agent/runs/run7/diff", "owner"), env, "run7")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ready: boolean
      prNumber: number
      files: { path: string; additions: number; deletions: number; patch?: string }[]
      additions: number
      deletions: number
    }
    expect(body.ready).toBe(true)
    expect(body.prNumber).toBe(7)
    expect(body.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(body.additions).toBe(15)
    expect(body.deletions).toBe(2)
    expect(body.files[0]!.patch).toContain("+new")
  })

  it("ready:false when the run's prUrl points outside its bound repository (cross-repo guard)", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "runX")
    await seedSession(kv, "owner", 111)
    await seedInstallationToken(kv, 42)
    stubGithubOwning42()
    routeMocks.getAgentRunStatus.mockResolvedValue({
      status: "opened",
      prUrl: "https://github.com/acme/other/pull/9",
    })
    const env = baseEnv(kv)
    const res = await handleAgentRunDiffRoute(reqGet("https://x/v1/agent/runs/runX/diff", "owner"), env, "runX")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ready: boolean }
    expect(body.ready).toBe(false)
  })
})

describe("handleAgentRunEventsRoute (GET /v1/agent/runs/:runId/events)", () => {
  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentRunEventsRoute(reqGet("https://x/v1/agent/runs/a/events", null), baseEnv(kv), "a")
    expect(res.status).toBe(401)
  })

  it("404 when a different GitHub user owns the run (IDOR guard)", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "foreign")
    await seedSession(kv, "intruder", 222)
    stubGithubOwning42()
    const res = await handleAgentRunEventsRoute(
      reqGet("https://x/v1/agent/runs/foreign/events", "intruder"),
      baseEnv(kv),
      "foreign",
    )
    expect(res.status).toBe(404)
    expect(routeMocks.getAgentRunEvents).not.toHaveBeenCalled()
  })

  it("returns events after the given cursor for the owner", async () => {
    const kv = makeKV()
    await seedRunOwner(kv, "run1")
    await seedSession(kv, "owner", 111)
    stubGithubOwning42()
    routeMocks.getAgentRunEvents.mockResolvedValue({
      events: [{ seq: 3, ts: 1, type: "file-edit", path: "a.ts", patch: "@@", additions: 1, deletions: 0 }],
      cursor: 3,
    })
    const env = baseEnv(kv)
    const res = await handleAgentRunEventsRoute(
      reqGet("https://x/v1/agent/runs/run1/events?after=2", "owner"),
      env,
      "run1",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: { seq: number }[]; cursor: number }
    expect(body.cursor).toBe(3)
    expect(body.events).toHaveLength(1)
    expect(routeMocks.getAgentRunEvents).toHaveBeenCalledWith(env, "run1", 2)
  })
})

describe("handleAgentEventIngestRoute (POST /internal/agent-runs/:runId/events)", () => {
  function ingestReq(runId: string, secret: string | null, body: unknown): Request {
    const headers = new Headers({ "content-type": "application/json" })
    if (secret !== null) headers.set("x-sigilix-run-secret", secret)
    return new Request(`https://x/internal/agent-runs/${runId}/events`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  }

  const RID = "11111111-1111-4111-8111-111111111111"
  const editBody = { type: "file-edit", path: "a.ts", patch: "@@ -1 +1 @@", additions: 1, deletions: 0 }

  it("400 on a non-UUID runId (blocks DO fan-out before any storage touch)", async () => {
    const res = await handleAgentEventIngestRoute(ingestReq("run1", "s3cr3t", editBody), baseEnv(makeKV()), "run1")
    expect(res.status).toBe(400)
    expect(routeMocks.appendAgentRunEvent).not.toHaveBeenCalled()
  })

  it("403 without the run secret", async () => {
    const res = await handleAgentEventIngestRoute(ingestReq(RID, null, editBody), baseEnv(makeKV()), RID)
    expect(res.status).toBe(403)
    expect(routeMocks.appendAgentRunEvent).not.toHaveBeenCalled()
  })

  it("400 on a malformed body", async () => {
    const res = await handleAgentEventIngestRoute(
      ingestReq(RID, "s3cr3t", { type: "file-edit", path: "a.ts" }),
      baseEnv(makeKV()),
      RID,
    )
    expect(res.status).toBe(400)
    expect(routeMocks.appendAgentRunEvent).not.toHaveBeenCalled()
  })

  it("400 on an over-large patch", async () => {
    const res = await handleAgentEventIngestRoute(
      ingestReq(RID, "s3cr3t", { ...editBody, patch: "x".repeat(200_001) }),
      baseEnv(makeKV()),
      RID,
    )
    expect(res.status).toBe(400)
    expect(routeMocks.appendAgentRunEvent).not.toHaveBeenCalled()
  })

  it("202 and appends when the secret matches", async () => {
    routeMocks.appendAgentRunEvent.mockResolvedValue({ ok: true, seq: 7 })
    const env = baseEnv(makeKV())
    const res = await handleAgentEventIngestRoute(ingestReq(RID, "s3cr3t", editBody), env, RID)
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ok: boolean; seq: number }
    expect(body).toEqual({ ok: true, seq: 7 })
    expect(routeMocks.appendAgentRunEvent).toHaveBeenCalledWith(env, RID, "s3cr3t", {
      ts: expect.any(Number),
      type: "file-edit",
      path: "a.ts",
      patch: "@@ -1 +1 @@",
      additions: 1,
      deletions: 0,
    })
  })

  it("403 identically for a wrong secret AND an unknown run (no oracle)", async () => {
    routeMocks.appendAgentRunEvent.mockResolvedValue({ ok: false })
    const res = await handleAgentEventIngestRoute(ingestReq(RID, "wrong", editBody), baseEnv(makeKV()), RID)
    expect(res.status).toBe(403)
  })
})

describe("handleAgentBranchCreateRoute (POST /v1/agent/branches)", () => {
  /** Stub scope + git-ref endpoints; `refsStatus` controls the create result. */
  function stubGithubForCreate(refsStatus = 201) {
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
          return new Response(JSON.stringify({ repositories: [{ full_name: "acme/api" }] }), {
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
        if (url === "https://api.github.com/repos/acme/api/git/ref/heads/main") {
          return new Response(JSON.stringify({ object: { sha: "base-sha-123" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url === "https://api.github.com/repos/acme/api/git/refs") {
          return new Response(JSON.stringify(refsStatus === 201 ? { ref: "refs/heads/feature/new" } : {}), {
            status: refsStatus,
            headers: { "content-type": "application/json" },
          })
        }
        throw new Error(`unexpected fetch: ${url}`)
      }),
    )
  }

  const good = { installationId: 42, repo: "acme/api", name: "feature/new" }

  it("401 without a session", async () => {
    const kv = makeKV()
    const res = await handleAgentBranchCreateRoute(reqPost("https://x/v1/agent/branches", null, good), baseEnv(kv))
    expect(res.status).toBe(401)
  })

  it("400 on an invalid branch name", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    const res = await handleAgentBranchCreateRoute(
      reqPost("https://x/v1/agent/branches", "s1", { ...good, name: "bad name!" }),
      baseEnv(kv),
    )
    expect(res.status).toBe(400)
  })

  it("403 when the user does not control the repo", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    stubGithubForCreate()
    // scope returns acme/api only; ask to create on acme/other → not owned
    const res = await handleAgentBranchCreateRoute(
      reqPost("https://x/v1/agent/branches", "s1", { ...good, repo: "acme/other" }),
      baseEnv(kv),
    )
    expect(res.status).toBe(403)
  })

  it("201 creates the branch off the default base", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await seedInstallationToken(kv, 42)
    stubGithubForCreate(201)
    const res = await handleAgentBranchCreateRoute(reqPost("https://x/v1/agent/branches", "s1", good), baseEnv(kv))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { name: string; created: boolean; from: string }
    expect(body).toEqual({ name: "feature/new", created: true, from: "main" })
  })

  it("409 when the branch already exists (GitHub 422)", async () => {
    const kv = makeKV()
    await seedSession(kv, "s1")
    await seedInstallationToken(kv, 42)
    stubGithubForCreate(422)
    const res = await handleAgentBranchCreateRoute(reqPost("https://x/v1/agent/branches", "s1", good), baseEnv(kv))
    expect(res.status).toBe(409)
  })
})
