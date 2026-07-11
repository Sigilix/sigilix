import { describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { buildPrReviewMcpRuntime } from "./tenant-runtime"

function makeEnv(handler: (request: Request) => Promise<Response> | Response): { env: Env; names: string[] } {
  const names: string[] = []
  const stub = { fetch: vi.fn(async (request: Request) => handler(request)) }
  const namespace = {
    idFromName: vi.fn((name: string) => {
      names.push(name)
      return { name }
    }),
    get: vi.fn(() => stub),
  }
  return { env: { MCP_CONNECTIONS: namespace } as unknown as Env, names }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

describe("buildPrReviewMcpRuntime", () => {
  it("binds the exact tenant namespace and strips remote descriptor prose", async () => {
    const { env, names } = makeEnv(() =>
      json({
        tools: [
          {
            serverId: "grant-1",
            vendor: "vercel",
            name: "list_deployments",
            description: "REMOTE INJECTION",
            inputSchema: { description: "REMOTE INJECTION" },
          },
        ],
      }),
    )
    const runtime = buildPrReviewMcpRuntime(env, "tenant:42", `pr:42:7:${"a".repeat(40)}`)!
    await expect(runtime.catalog(new AbortController().signal)).resolves.toEqual([
      { serverId: "grant-1", vendor: "vercel", name: "list_deployments" },
    ])
    expect(names).toEqual(["tenant:42"])
  })

  it("posts the exact pr-review invoke tuple and accepts sanitized text only", async () => {
    let body: unknown
    const { env } = makeEnv(async (request) => {
      body = await request.json()
      return json({
        result: {
          content: [
            { type: "text", text: JSON.stringify({ deployments: [] }) },
            { type: "image", data: "secret" },
          ],
          structuredContent: { secret: true },
        },
      })
    })
    const runId = `pr:42:7:${"a".repeat(40)}`
    const runtime = buildPrReviewMcpRuntime(env, "tenant:42", runId)!
    await expect(
      runtime.invoke(
        {
          serverId: "grant-1",
          toolName: "list_deployments",
          arguments: { teamId: "team_1", projectId: "prj_1" },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ content: [{ type: "text", text: JSON.stringify({ deployments: [] }) }] })
    expect(body).toEqual({
      runId,
      serverId: "grant-1",
      toolName: "list_deployments",
      arguments: { teamId: "team_1", projectId: "prj_1" },
    })
  })

  it("rejects non-tenant scopes before touching the namespace", () => {
    const { env, names } = makeEnv(() => json({ tools: [] }))
    expect(buildPrReviewMcpRuntime(env, "session:42", "run-1")).toBeUndefined()
    expect(buildPrReviewMcpRuntime(env, "tenant:0", "run-1")).toBeUndefined()
    expect(names).toEqual([])
  })
})
