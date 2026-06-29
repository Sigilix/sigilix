// SIG-545 B1: admin-agent-run-route tests — bearer auth + the provider-key
// allow-list that picks OLLAMA_API_KEY / OPENROUTER_API_KEY from the resolved
// baseUrl host (so a hostile baseUrl can't exfiltrate a key).
//
// dispatchAgentRun / getAgentRunStatus are mocked: these tests assert the route's
// request parsing, auth, and the exact `model` object handed to dispatch — not the
// container plumbing (covered in dispatch.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/src/lib/agent-runner/dispatch", () => ({
  dispatchAgentRun: vi.fn(),
  getAgentRunStatus: vi.fn(),
}))

import { handleAdminAgentRunRoute, handleAdminAgentStatusRoute } from "@/src/lib/agent-runner/admin-agent-run-route"
import { dispatchAgentRun, getAgentRunStatus } from "@/src/lib/agent-runner/dispatch"
import type { Env } from "@/src/shared/types/env"

const mockDispatch = vi.mocked(dispatchAgentRun)
const mockStatus = vi.mocked(getAgentRunStatus)

const ADMIN_TOKEN = "admin-secret-token"
const OLLAMA_KEY = "sk-ollama-secret"
const OPENROUTER_KEY = "sk-openrouter-secret"

const VALID_BODY = { owner: "Sigilix", repo: "sigilix", installationId: 134811639 }

function makeEnv(over?: Record<string, unknown>): Env {
  return {
    OPENCLAW_ADMIN_TOKEN: ADMIN_TOKEN,
    OLLAMA_API_KEY: OLLAMA_KEY,
    OPENROUTER_API_KEY: OPENROUTER_KEY,
    ...over,
  } as unknown as Env
}

function postReq(body: unknown, token: string | null = ADMIN_TOKEN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token !== null) headers["authorization"] = `Bearer ${token}`
  return new Request("https://w.dev/admin/agent-run", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

/** The `input.model` object handed to dispatchAgentRun on the first (only) call. */
function modelArg(): Record<string, unknown> {
  return (mockDispatch.mock.calls[0]![1] as { model: Record<string, unknown> }).model
}

describe("handleAdminAgentRunRoute — auth + request validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDispatch.mockResolvedValue({ runId: "r1", dispatched: false })
  })

  it("503 when the admin token is not configured", async () => {
    const res = await handleAdminAgentRunRoute(postReq(VALID_BODY), makeEnv({ OPENCLAW_ADMIN_TOKEN: undefined }))
    expect(res.status).toBe(503)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("401 when the bearer header is missing", async () => {
    const res = await handleAdminAgentRunRoute(postReq(VALID_BODY, null), makeEnv())
    expect(res.status).toBe(401)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("401 when the bearer token is wrong", async () => {
    const res = await handleAdminAgentRunRoute(postReq(VALID_BODY, "wrong"), makeEnv())
    expect(res.status).toBe(401)
  })

  it("400 when the body is not JSON", async () => {
    const res = await handleAdminAgentRunRoute(postReq("not json at all"), makeEnv())
    expect(res.status).toBe(400)
  })

  it("400 when owner / repo / installationId is missing", async () => {
    const res = await handleAdminAgentRunRoute(postReq({ owner: "Sigilix" }), makeEnv())
    expect(res.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })
})

describe("handleAdminAgentRunRoute — provider-key allow-list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDispatch.mockResolvedValue({ runId: "r1", dispatched: true })
  })

  it("defaults to Ollama Turbo (glm-5.2:cloud @ ollama.com/v1) with OLLAMA_API_KEY", async () => {
    const res = await handleAdminAgentRunRoute(postReq(VALID_BODY), makeEnv())
    expect(res.status).toBe(200)
    expect(modelArg()).toEqual({ id: "glm-5.2:cloud", baseUrl: "https://ollama.com/v1", key: OLLAMA_KEY })
  })

  it("an openrouter.ai baseUrl override selects OPENROUTER_API_KEY", async () => {
    await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { id: "z-ai/glm-5.2", baseUrl: "https://openrouter.ai/api/v1" } }),
      makeEnv(),
    )
    expect(modelArg()).toEqual({ id: "z-ai/glm-5.2", baseUrl: "https://openrouter.ai/api/v1", key: OPENROUTER_KEY })
  })

  it("400 on an un-allow-listed host (the key is never sent to an arbitrary host)", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "https://attacker.example/v1" } }),
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("400 on a substring-lookalike host (openrouter.ai.attacker.example)", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "https://openrouter.ai.attacker.example/v1" } }),
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("400 on a userinfo-spoofed host (selection uses hostname, not userinfo)", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "https://ollama.com@attacker.example/v1" } }),
      makeEnv(),
    )
    expect(res.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("accepts an uppercase host (case-normalized) and selects OLLAMA_API_KEY", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "https://OLLAMA.COM/v1" } }),
      makeEnv(),
    )
    expect(res.status).toBe(200)
    expect(modelArg().key).toBe(OLLAMA_KEY)
  })

  it("400 on a non-https baseUrl", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "http://ollama.com/v1" } }),
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })

  it("normalizes a trailing slash so the loop never builds a double slash", async () => {
    await handleAdminAgentRunRoute(postReq({ ...VALID_BODY, model: { baseUrl: "https://ollama.com/v1/" } }), makeEnv())
    expect(modelArg().baseUrl).toBe("https://ollama.com/v1")
  })

  it("503 when the selected provider key is not set", async () => {
    const res = await handleAdminAgentRunRoute(
      postReq({ ...VALID_BODY, model: { baseUrl: "https://openrouter.ai/api/v1" } }),
      makeEnv({ OPENROUTER_API_KEY: undefined }),
    )
    expect(res.status).toBe(503)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it("response body carries only { runId, dispatched } — never the model key", async () => {
    const res = await handleAdminAgentRunRoute(postReq(VALID_BODY), makeEnv())
    const text = await res.text()
    expect(text).not.toContain(OLLAMA_KEY)
    expect(text).not.toContain(OPENROUTER_KEY)
    expect(JSON.parse(text)).toEqual({ runId: "r1", dispatched: true })
  })
})

describe("handleAdminAgentStatusRoute", () => {
  beforeEach(() => vi.clearAllMocks())

  it("503 when the admin token is not configured", async () => {
    const req = new Request("https://w.dev/admin/agent-run-status?runId=r1", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    const res = await handleAdminAgentStatusRoute(req, makeEnv({ OPENCLAW_ADMIN_TOKEN: undefined }))
    expect(res.status).toBe(503)
    expect(mockStatus).not.toHaveBeenCalled()
  })

  it("401 on a wrong bearer token", async () => {
    const req = new Request("https://w.dev/admin/agent-run-status?runId=r1", {
      headers: { authorization: "Bearer wrong" },
    })
    const res = await handleAdminAgentStatusRoute(req, makeEnv())
    expect(res.status).toBe(401)
  })

  it("400 when runId is missing", async () => {
    const req = new Request("https://w.dev/admin/agent-run-status", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    const res = await handleAdminAgentStatusRoute(req, makeEnv())
    expect(res.status).toBe(400)
  })

  it("returns the run record JSON for a valid request", async () => {
    mockStatus.mockResolvedValue({ runId: "r1", status: "opened", prUrl: "https://github.com/x/y/pull/1" })
    const req = new Request("https://w.dev/admin/agent-run-status?runId=r1", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    const res = await handleAdminAgentStatusRoute(req, makeEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ runId: "r1", status: "opened", prUrl: "https://github.com/x/y/pull/1" })
  })
})
