import { describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { buildResearchMcpRuntime } from "./mcp-runtime"

function makeEnv(handler: (request: Request) => Promise<Response> | Response): {
  env: Env
  names: string[]
} {
  const names: string[] = []
  const stub = {
    fetch: vi.fn(async (request: Request) => {
      return handler(request as unknown as Request)
    }),
  }
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

describe("research MCP runtime binding", () => {
  it("does not create an MCP namespace for anonymous or invalid creators", () => {
    const { env, names } = makeEnv(() => json({ tools: [] }))
    expect(buildResearchMcpRuntime(env, "session:anon", "run-1")).toBeUndefined()
    expect(buildResearchMcpRuntime(env, "tenant:-1", "run-1")).toBeUndefined()
    expect(buildResearchMcpRuntime(env, "session:111", "bad run id")).toBeUndefined()
    expect(names).toEqual([])
  })

  it("uses the exact creator namespace and independently rejects forged catalog capabilities", async () => {
    const { env, names } = makeEnv(() =>
      json({
        tools: [
          {
            serverId: "linear-1",
            vendor: "linear",
            name: "list_comments",
            description: "REMOTE DESCRIPTION MUST NOT WIN",
            inputSchema: {
              type: "object",
              description: "remote prompt",
              properties: { issueId: { type: "string", description: "remote prompt" } },
            },
          },
          { serverId: "linear-1", vendor: "linear", name: "create_issue", inputSchema: { type: "object" } },
          { serverId: "custom-1", vendor: "custom", name: "list_comments", inputSchema: { type: "object" } },
        ],
      }),
    )
    const runtime = buildResearchMcpRuntime(env, "session:111", "run-1")!
    expect(await runtime.catalog("chat")).toEqual([
      {
        serverId: "linear-1",
        vendor: "linear",
        name: "list_comments",
        description: "Read Linear comments visible to the connected account.",
        inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
      },
    ])
    expect(names).toEqual(["session:111"])
  })

  it("posts an exact invocation tuple and accepts only sanitized text evidence", async () => {
    let invokeBody: unknown
    const { env } = makeEnv(async (request) => {
      if (new URL(request.url).pathname === "/runtime/catalog") return json({ tools: [] })
      invokeBody = await request.json()
      return json({
        result: {
          untrusted: true,
          content: [
            { type: "text", text: "comment data", annotations: { audience: ["assistant"] } },
            { type: "image", data: "secret" },
          ],
          truncated: false,
          structuredContent: { secret: true },
        },
      })
    })
    const runtime = buildResearchMcpRuntime(env, "tenant:99", "run-7")!
    await expect(
      runtime.invoke({
        surface: "deep-research",
        serverId: "linear-1",
        toolName: "list_comments",
        arguments: { issueId: "SIG-193" },
      }),
    ).resolves.toEqual({ untrusted: true, content: [{ type: "text", text: "comment data" }], truncated: false })
    expect(invokeBody).toEqual({
      runId: "run-7",
      surface: "deep-research",
      serverId: "linear-1",
      toolName: "list_comments",
      arguments: { issueId: "SIG-193" },
    })
  })
})
