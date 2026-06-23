// POST /v1/blast-radius route: auth gating, validation, the body / array caps, and the
// graph result (or graceful empty) passed through as a 200. The graph client
// (`blastRadiusByNamesFor`) is mocked — its real per-tenant DO behavior is covered by the
// repo-graph suites; here we pin the HTTP contract.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/src/lib/repo-graph-client", () => ({ blastRadiusByNamesFor: vi.fn() }))

import { handleBlastRadiusApiRoute } from "./api-blast-radius-route"
import { blastRadiusByNamesFor } from "@/src/lib/repo-graph-client"
import type { Env } from "@/src/shared/types/env"

const mockBlastRadius = vi.mocked(blastRadiusByNamesFor)
const TOKEN = "blast-secret"

const env = (key?: string): Env => ({ OPENCLAW_SIGILIX_API_KEY: key }) as unknown as Env

function req(body: unknown, token: string | null = TOKEN): Request {
  return new Request("https://api.sigilix.ai/v1/blast-radius", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const validBody = { owner: "o", repo: "r", names: ["handleFoo"], paths: ["src/foo.ts"] }

const result = {
  callerPaths: ["src/bar.ts", "src/baz.ts"],
  importDependents: ["src/qux.ts"],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBlastRadius.mockResolvedValue(result)
})

describe("handleBlastRadiusApiRoute — auth + validation", () => {
  it("503 when the key is unset (inert)", async () => {
    expect((await handleBlastRadiusApiRoute(req(validBody), env(undefined))).status).toBe(503)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("401 on a missing bearer", async () => {
    expect((await handleBlastRadiusApiRoute(req(validBody, null), env(TOKEN))).status).toBe(401)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("401 on a bad bearer", async () => {
    expect((await handleBlastRadiusApiRoute(req(validBody, "nope"), env(TOKEN))).status).toBe(401)
  })
  it("400 on invalid JSON", async () => {
    expect((await handleBlastRadiusApiRoute(req("{nope", TOKEN), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing owner", async () => {
    const { owner: _o, ...noOwner } = validBody
    const res = await handleBlastRadiusApiRoute(req(noOwner), env(TOKEN))
    expect(res.status).toBe(400)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("400 on a missing repo", async () => {
    const { repo: _r, ...noRepo } = validBody
    expect((await handleBlastRadiusApiRoute(req(noRepo), env(TOKEN))).status).toBe(400)
  })
  it("400 on a missing names", async () => {
    const { names: _n, ...noNames } = validBody
    const res = await handleBlastRadiusApiRoute(req(noNames), env(TOKEN))
    expect(res.status).toBe(400)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("400 on an empty names array", async () => {
    expect((await handleBlastRadiusApiRoute(req({ ...validBody, names: [] }), env(TOKEN))).status).toBe(400)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("400 on a missing paths", async () => {
    const { paths: _p, ...noPaths } = validBody
    expect((await handleBlastRadiusApiRoute(req(noPaths), env(TOKEN))).status).toBe(400)
  })
  it("400 on an empty paths array", async () => {
    expect((await handleBlastRadiusApiRoute(req({ ...validBody, paths: [] }), env(TOKEN))).status).toBe(400)
  })
  it("400 when names holds a non-string entry", async () => {
    expect((await handleBlastRadiusApiRoute(req({ ...validBody, names: [1] }), env(TOKEN))).status).toBe(400)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
})

describe("handleBlastRadiusApiRoute — body / array caps", () => {
  it("413 on an oversized envelope (before the graph query runs)", async () => {
    const huge = { ...validBody, names: ["x".repeat(70_000)] }
    const res = await handleBlastRadiusApiRoute(req(huge), env(TOKEN))
    expect(res.status).toBe(413)
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
  it("413 on an over-long array inside a well-formed body", async () => {
    // Under the 64KB body cap (short strings) but over the 500-entry array cap.
    const big = { ...validBody, names: Array.from({ length: 501 }, (_, i) => `s${i}`) }
    const res = await handleBlastRadiusApiRoute(req(big), env(TOKEN))
    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large")
    expect(mockBlastRadius).not.toHaveBeenCalled()
  })
})

describe("handleBlastRadiusApiRoute — results pass through as 200", () => {
  it("200 with the caller + import-dependent paths", async () => {
    const res = await handleBlastRadiusApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(mockBlastRadius).toHaveBeenCalledWith(env(TOKEN), validBody.owner, validBody.repo, {
      changedNames: validBody.names,
      changedPaths: validBody.paths,
    })
  })
  it("200 empty when the repo isn't indexed (graceful, not an error)", async () => {
    mockBlastRadius.mockResolvedValue({ callerPaths: [], importDependents: [] })
    const res = await handleBlastRadiusApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ callerPaths: [], importDependents: [] })
  })
  it("200 empty on a graph-client failure (soft-fail, never a 500)", async () => {
    mockBlastRadius.mockRejectedValue(new Error("DO unavailable"))
    const res = await handleBlastRadiusApiRoute(req(validBody), env(TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ callerPaths: [], importDependents: [] })
  })
})
