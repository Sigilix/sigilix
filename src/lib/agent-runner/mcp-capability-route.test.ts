import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { AgentMcpCapabilityAuthorization, AgentMcpCapabilityContext } from "@/src/do/agent-mcp-capability"
import { tryHandleAgentMcpMachineRoute } from "./mcp-capability-route"
import type { Env } from "@/src/shared/types/env"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222"
const CAPABILITY = "a".repeat(64)
const CAPABILITY_HASH = "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"

function context(runId = RUN_ID): AgentMcpCapabilityContext {
  return {
    version: 1,
    runId,
    installationId: 42,
    owner: "Sigilix",
    repo: "Portal",
    surface: "agent",
    tools: [
      {
        localName: "mcp_0",
        grantId: "grant-1",
        vendor: "linear",
        toolName: "list_comments",
        description: "Read Linear comments visible to the connected account.",
        inputSchema: { type: "object", properties: { issueId: { type: "string" } } },
      },
    ],
    expiresAt: Date.now() + 60_000,
    maxCalls: 4,
    callsUsed: 0,
    catalogReadsUsed: 0,
  }
}

function harness(
  options: {
    postCallDenied?: boolean
    postCallContext?: AgentMcpCapabilityContext
    catalogTools?: unknown[]
    brokerInvoke?: Response
  } = {},
): {
  env: Env
  uses: string[]
  tenantNames: string[]
  brokerCalls: Array<{ path: string; body: Record<string, unknown> }>
} {
  const uses: string[] = []
  const tenantNames: string[] = []
  const brokerCalls: Array<{ path: string; body: Record<string, unknown> }> = []
  let authorizeCount = 0
  const capabilityContext = context()
  const capabilityStub = {
    async authorize(hash: string, use: string): Promise<AgentMcpCapabilityAuthorization> {
      authorizeCount += 1
      uses.push(use)
      if (hash !== CAPABILITY_HASH) return { ok: false, reason: "mismatch" }
      if (options.postCallDenied && authorizeCount > 1 && use === "revalidate") {
        return { ok: false, reason: "missing" }
      }
      if (options.postCallContext && authorizeCount > 1 && use === "revalidate") {
        return { ok: true, context: options.postCallContext }
      }
      return { ok: true, context: capabilityContext }
    },
  }
  const tenantStub = {
    async fetch(request: Request): Promise<Response> {
      const body = (await request.json()) as Record<string, unknown>
      const path = new URL(request.url).pathname
      brokerCalls.push({ path, body })
      if (path.endsWith("/catalog")) {
        return Response.json({
          tools: options.catalogTools ?? [
            { serverId: "grant-1", vendor: "linear", name: "list_comments", inputSchema: { type: "object" } },
          ],
          partial: false,
        })
      }
      return (
        options.brokerInvoke ??
        Response.json({
          result: {
            untrusted: true,
            content: [{ type: "text", text: "ticket comment" }],
            truncated: false,
          },
        })
      )
    },
  }
  const env = {
    AGENT_MCP_CAPABILITY: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) =>
        id.name === RUN_ID ? capabilityStub : { authorize: async () => ({ ok: false, reason: "missing" }) },
    },
    MCP_CONNECTIONS: {
      idFromName: (name: string) => {
        tenantNames.push(name)
        return { name }
      },
      get: () => tenantStub,
    },
  } as unknown as Env
  return { env, uses, tenantNames, brokerCalls }
}

function routeFetch(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const response = await tryHandleAgentMcpMachineRoute(request, env, new URL(request.url))
    return response ?? new Response("not found", { status: 404 })
  }) as typeof fetch
}

afterEach(() => vi.restoreAllMocks())

describe("agent MCP machine route", () => {
  it("completes the pinned SDK handshake, lists exact tools, and returns delimited untrusted data", async () => {
    const { env, tenantNames, brokerCalls } = harness()
    const transport = new StreamableHTTPClientTransport(
      new URL(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`),
      {
        requestInit: { headers: { "x-sigilix-mcp-capability": CAPABILITY } },
        fetch: routeFetch(env),
      },
    )
    const client = new Client({ name: "sigilix-agent-test", version: "1.0.0" })

    await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
    const listed = await client.listTools()
    const called = await client.callTool({ name: "mcp_0", arguments: { issueId: "SIG-566" } })
    await client.close()

    expect(listed.tools).toMatchObject([{ name: "mcp_0" }])
    expect(called.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("BEGIN_UNTRUSTED_MCP_DATA"),
      }),
    ])
    expect(JSON.stringify(called)).toContain("Linear/list_comments")
    expect(JSON.stringify(called)).toContain("ticket comment")
    expect(tenantNames).toEqual(["tenant:42", "tenant:42"])
    expect(brokerCalls[1]).toEqual({
      path: "/broker/runtime/agent/invoke",
      body: {
        runId: RUN_ID,
        serverId: "grant-1",
        toolName: "list_comments",
        arguments: { issueId: "SIG-566" },
      },
    })
  })

  it("returns the same generic 401 for absent, wrong, and cross-run replay", async () => {
    const { env } = harness()
    const bodies: string[] = []
    const attempts: Array<readonly [string, string]> = [
      [RUN_ID, ""],
      [RUN_ID, "b".repeat(64)],
      [OTHER_RUN_ID, CAPABILITY],
    ]
    for (const [runId, capability] of attempts) {
      const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${runId}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sigilix-mcp-capability": capability },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      })
      expect(response.status).toBe(401)
      bodies.push(await response.text())
    }
    expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: "unauthorized" })]))
  })

  it("authenticates notifications and unknown JSON-RPC methods before dispatch", async () => {
    const { env } = harness()
    for (const message of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 9, method: "unknown/method", params: {} },
    ]) {
      const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: "unauthorized" })
    }
  })

  it("uses no stale bytes when capability revocation wins after the provider read", async () => {
    const { env } = harness({ postCallDenied: true })
    const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sigilix-mcp-capability": CAPABILITY },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "mcp_0", arguments: {} },
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("ticket comment")
  })

  it("discards provider bytes when the exact repo binding changes mid-call", async () => {
    const { env } = harness({ postCallContext: { ...context(), repo: "Other" } })
    const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sigilix-mcp-capability": CAPABILITY },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "mcp_0", arguments: {} },
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("ticket comment")
  })

  it("fails soft to an empty catalog when live tenant policy exposes no tool", async () => {
    const { env } = harness({ catalogTools: [] })
    const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sigilix-mcp-capability": CAPABILITY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { tools: [] } })
  })

  it("turns provider timeout/failure into one MCP tool error so coding can continue", async () => {
    const { env } = harness({ brokerInvoke: Response.json({ error: "tool_timeout" }, { status: 504 }) })
    const response = await routeFetch(env)(`https://api.sigilix.ai/internal/agent-runs/${RUN_ID}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sigilix-mcp-capability": CAPABILITY },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mcp_0", arguments: {} } }),
    })

    const body = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toContain("Continue without it")
  })
})
