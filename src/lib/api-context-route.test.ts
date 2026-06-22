// SIG-494 — POST /v1/context route: auth gating, validation, body cap, the honest
// null-grounding case (200, not an error), 500 only on an unexpected throw, and the
// graceful App-configured vs index-only-degrade fetcher resolution. gatherAgentContext +
// the GitHub App seams are mocked (their own suites cover them).

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("./agent-context", () => ({ gatherAgentContext: vi.fn() }))
vi.mock("@/src/shared/adapters/github/github-installation", () => ({ resolveInstallation: vi.fn() }))
vi.mock("@/src/lib/ensemble/adapters/review-sink", () => ({ buildClient: vi.fn() }))

import { handleAgentContextRoute } from "./api-context-route"
import { gatherAgentContext } from "./agent-context"
import { resolveInstallation } from "@/src/shared/adapters/github/github-installation"
import { buildClient } from "@/src/lib/ensemble/adapters/review-sink"
import type { Env } from "@/src/shared/types/env"

const mockGather = vi.mocked(gatherAgentContext)
const mockResolve = vi.mocked(resolveInstallation)
const mockBuild = vi.mocked(buildClient)
const TOKEN = "ctx-secret"

const env = (key?: string, extra: Partial<Env> = {}): Env =>
  ({ OPENCLAW_SIGILIX_API_KEY: key, ...extra }) as unknown as Env
const appEnv = (extra: Partial<Env> = {}): Env =>
  env(TOKEN, {
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "pk",
    OPENCLAW_GITHUB_INSTALLATION_MAP: '{"o/r":"42"}',
    ...extra,
  })

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/context", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const validBody = { owner: "o", repo: "r", query: "where is auth" }
const okResult = {
  context: "GROUNDED",
  telemetry: {
    namespace: "o/r",
    chunkCount: 3,
    graphAvailable: true,
    symbolsExpanded: 2,
    callersRendered: 1,
    superseded: 1,
    contextChars: 8,
  },
}

let getFileContentMock: ReturnType<typeof vi.fn>

function mockClient(getBranch: () => Promise<{ headSha: string; treeSha: string } | null>) {
  mockBuild.mockResolvedValue({
    getRepository: vi.fn(async () => ({ default_branch: "main", id: 1 })),
    getBranch: vi.fn(getBranch),
    getFileContent: getFileContentMock,
  } as never)
}

/** Pull the fetcher the route handed to gatherAgentContext (gather is mocked, so the
 *  closure is never invoked unless we call it ourselves). */
function capturedFetcher(): (path: string) => Promise<string | null> {
  return (mockGather.mock.calls[0]?.[0] as { fetchFileContent: (p: string) => Promise<string | null> }).fetchFileContent
}

beforeEach(() => {
  vi.clearAllMocks()
  mockResolve.mockReturnValue({ ok: true, installationId: 42 } as never)
  getFileContentMock = vi.fn(async () => "file")
  mockClient(async () => ({ headSha: "abc", treeSha: "t" }))
  mockGather.mockResolvedValue(okResult as never)
})

describe("handleAgentContextRoute — auth + validation", () => {
  it("503 when the key is unset (inert)", async () => {
    expect((await handleAgentContextRoute(req(validBody), env(undefined))).status).toBe(503)
    expect(mockGather).not.toHaveBeenCalled()
  })
  it("401 on a bad bearer", async () => {
    expect((await handleAgentContextRoute(req(validBody, "nope"), env(TOKEN))).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleAgentContextRoute(req("{nope", TOKEN), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing query", async () => {
    const { query: _q, ...noQuery } = validBody
    expect((await handleAgentContextRoute(req(noQuery), env(TOKEN))).status).toBe(400)
  })
  it("413 on an oversized body (before grounding)", async () => {
    const huge = { ...validBody, query: "x".repeat(70_000) }
    const res = await handleAgentContextRoute(req(huge), env(TOKEN))
    expect(res.status).toBe(413)
    expect(mockGather).not.toHaveBeenCalled()
  })
})

describe("handleAgentContextRoute — retrieval", () => {
  it("200 with the packed context + telemetry", async () => {
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ context: "GROUNDED", telemetry: okResult.telemetry })
  })
  it("200 with null context when nothing grounded (honest, NOT an error)", async () => {
    mockGather.mockResolvedValue({
      context: null,
      telemetry: { ...okResult.telemetry, chunkCount: 0, contextChars: 0 },
    } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(((await res.json()) as { context: unknown }).context).toBeNull()
  })
  it("500 only on an unexpected engine throw", async () => {
    mockGather.mockRejectedValue(new Error("boom"))
    expect((await handleAgentContextRoute(req(validBody), appEnv())).status).toBe(500)
  })
  it("builds the App client + a file fetcher when configured + installed", async () => {
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), 42)
    const call = mockGather.mock.calls[0]?.[0] as { fetchFileContent?: unknown }
    expect(typeof call.fetchFileContent).toBe("function")
  })
  it("the App fetcher reads files at the resolved default-branch HEAD sha", async () => {
    await handleAgentContextRoute(req(validBody), appEnv())
    await capturedFetcher()("src/x.ts")
    expect(getFileContentMock).toHaveBeenCalledWith("o", "r", "src/x.ts", "abc")
  })
  it("falls back to the default-branch NAME as ref when getBranch returns null", async () => {
    mockClient(async () => null)
    await handleAgentContextRoute(req(validBody), appEnv())
    await capturedFetcher()("src/x.ts")
    expect(getFileContentMock).toHaveBeenCalledWith("o", "r", "src/x.ts", "main")
  })
  it("degrades to index-only (no buildClient) when the App is unconfigured", async () => {
    const res = await handleAgentContextRoute(req(validBody), env(TOKEN)) // no APP_ID / PRIVATE_KEY
    expect(res.status).toBe(200)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockGather).toHaveBeenCalled()
  })
  it("degrades to index-only when the App is not installed on the repo", async () => {
    mockResolve.mockReturnValue({ ok: false } as never)
    const res = await handleAgentContextRoute(req(validBody), appEnv())
    expect(res.status).toBe(200)
    expect(mockBuild).not.toHaveBeenCalled()
    expect(mockGather).toHaveBeenCalled()
  })
})
