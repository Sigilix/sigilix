// sig-mcp-connections-p1 — McpConnectionsAgent DO tests.
//
// Per the task brief, the SDK/transport is MOCKED: `agents/mcp/client`'s
// MCPClientManager is Cloudflare's dependency to test, not ours. What's
// "genuinely new" here (the scope doc's own framing) is the DO's thin
// orchestration around it — id generation, state→HTTP-status mapping, the
// defense-in-depth SSRF re-check, tool-count derivation, and the
// establishConnection-after-callback wiring — so these tests exercise that
// logic against a scripted fake MCPClientManager that mirrors the SDK's real
// discriminated-union return shapes.

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Env } from "@/src/shared/types/env"

// ── fake MCPClientManager (mocks the SDK/transport, per the task brief) ──

interface FakeServerRow {
  id: string
  name: string
  server_url: string
}

type ConnectScript =
  | { state: "authenticating"; authUrl: string }
  | { state: "failed"; error: string }
  | { state: "connected" }

/** Module-level script the fake constructor reads at instantiation. Reset in
 *  beforeEach so every test controls its own connect/callback outcome. */
let nextConnectResult: ConnectScript = { state: "connected" }
let nextCallbackResult: { serverId?: string; authSuccess: boolean; authError?: string } = {
  serverId: "srv-1",
  authSuccess: true,
}
let registerServerSpy = vi.fn()
let removeServerSpy = vi.fn()
let establishConnectionSpy = vi.fn()

class FakeMCPClientManager {
  private rows = new Map<string, FakeServerRow>()
  private states = new Map<string, string>()
  mcpConnections: Record<string, { connectionState: string }> = new Proxy(
    {},
    {
      get: (_t, id: string) => {
        const state = this.states.get(id)
        return state ? { connectionState: state } : undefined
      },
    },
  )

  constructor(
    public name: string,
    public version: string,
    public options: unknown,
  ) {}

  async restoreConnectionsFromStorage(): Promise<void> {}

  async registerServer(id: string, opts: { url: string; name: string; callbackUrl?: string }): Promise<string> {
    registerServerSpy(id, opts)
    this.rows.set(id, { id, name: opts.name, server_url: opts.url })
    this.states.set(id, "connecting")
    return id
  }

  async connectToServer(id: string): Promise<ConnectScript> {
    if (nextConnectResult.state === "connected") this.states.set(id, "connected")
    if (nextConnectResult.state === "authenticating") this.states.set(id, "authenticating")
    if (nextConnectResult.state === "failed") this.states.set(id, "failed")
    return nextConnectResult
  }

  async discoverIfConnected(id: string): Promise<{ success: boolean; state: string }> {
    if (this.states.get(id) === "connected") this.states.set(id, "ready")
    return { success: true, state: this.states.get(id) ?? "failed" }
  }

  listTools(filter?: { serverId?: string }): unknown[] {
    if (filter?.serverId && this.states.get(filter.serverId) === "ready")
      return [{ name: "tool_a" }, { name: "tool_b" }]
    return []
  }

  listServers(): FakeServerRow[] {
    return Array.from(this.rows.values())
  }

  async removeServer(id: string): Promise<void> {
    removeServerSpy(id)
    this.rows.delete(id)
    this.states.delete(id)
  }

  async handleCallbackRequest(): Promise<{ serverId?: string; authSuccess: boolean; authError?: string }> {
    return nextCallbackResult
  }

  async establishConnection(id: string): Promise<void> {
    establishConnectionSpy(id)
    this.states.set(id, "ready")
  }
}

vi.mock("agents/mcp/client", () => ({ MCPClientManager: FakeMCPClientManager }))

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe
// at module scope too, but keeping it explicit here documents the ordering).
const { McpConnectionsAgent } = await import("./mcp-connections-do")

// ── fake DO state (KV-only — the fake manager needs no real SQLite) ──

function makeDoState(): DurableObjectState {
  const store = new Map<string, unknown>()
  return {
    id: { toString: () => "mcp-connections-instance-1" },
    storage: {
      async get<T>(k: string): Promise<T | undefined> {
        return store.get(k) as T | undefined
      },
      async put<T>(k: string, v: T): Promise<void> {
        store.set(k, v)
      },
      async delete(k: string): Promise<boolean> {
        return store.delete(k)
      },
    },
  } as unknown as DurableObjectState
}

function makeInstance() {
  return new McpConnectionsAgent(makeDoState(), {} as Env)
}

function connectRequest(body: unknown): Request {
  return new Request("https://mcp-connections.do/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  nextConnectResult = { state: "connected" }
  nextCallbackResult = { serverId: "srv-1", authSuccess: true }
  registerServerSpy = vi.fn()
  removeServerSpy = vi.fn()
  establishConnectionSpy = vi.fn()
})

describe("McpConnectionsAgent — POST /connect", () => {
  it("happy path: connects, discovers tools, returns status=connected with a toolCount", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(
      connectRequest({
        url: "https://example.com/mcp",
        name: "Example",
        callbackUrl: "https://api.sigilix.ai/mcp/oauth/callback",
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; id: string; toolCount: number }
    expect(body.status).toBe("connected")
    expect(body.toolCount).toBe(2)
    expect(typeof body.id).toBe("string")
    expect(registerServerSpy).toHaveBeenCalledTimes(1)
  })

  it("auth_required path: returns the SDK's authUrl without discovering tools", async () => {
    nextConnectResult = { state: "authenticating", authUrl: "https://provider.example/authorize?x=1" }
    const instance = makeInstance()
    const res = await instance.fetch(connectRequest({ url: "https://example.com/mcp", callbackUrl: "https://cb" }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; authUrl: string }
    expect(body.status).toBe("auth_required")
    expect(body.authUrl).toBe("https://provider.example/authorize?x=1")
  })

  it("failed connect: removes the just-registered server and returns status=error", async () => {
    nextConnectResult = { state: "failed", error: "server unreachable" }
    const instance = makeInstance()
    const res = await instance.fetch(connectRequest({ url: "https://example.com/mcp", callbackUrl: "https://cb" }))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { status: string; error: string }
    expect(body.status).toBe("error")
    expect(removeServerSpy).toHaveBeenCalledTimes(1)
  })

  it("SSRF: rejects a private/localhost URL BEFORE ever calling registerServer (defense-in-depth, independent of routes.ts's own guard)", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(connectRequest({ url: "http://127.0.0.1:8080/mcp", callbackUrl: "https://cb" }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { status: string; error: string }
    expect(body.status).toBe("error")
    expect(body.error).toContain("blocked url")
    expect(registerServerSpy).not.toHaveBeenCalled()
  })

  it("SSRF: rejects a metadata-service URL", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(
      connectRequest({ url: "http://169.254.169.254/latest/meta-data", callbackUrl: "https://cb" }),
    )
    expect(res.status).toBe(400)
    expect(registerServerSpy).not.toHaveBeenCalled()
  })

  it("400s on a missing url without touching the SDK", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(connectRequest({ callbackUrl: "https://cb" }))
    expect(res.status).toBe(400)
    expect(registerServerSpy).not.toHaveBeenCalled()
  })
})

describe("McpConnectionsAgent — GET /list + DELETE /servers/:id", () => {
  it("lists a connected server with its name, url, status, and tool count", async () => {
    const instance = makeInstance()
    await instance.fetch(connectRequest({ url: "https://example.com/mcp", name: "Example", callbackUrl: "https://cb" }))

    const res = await instance.fetch(new Request("https://mcp-connections.do/list"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      servers: Array<{ id: string; name: string; url: string; status: string; toolCount: number }>
    }
    expect(body.servers).toHaveLength(1)
    expect(body.servers[0]).toMatchObject({
      name: "Example",
      url: "https://example.com/mcp",
      status: "ready",
      toolCount: 2,
    })
  })

  it("disconnect removes the server and purges it from the list", async () => {
    const instance = makeInstance()
    const connectRes = await instance.fetch(
      connectRequest({ url: "https://example.com/mcp", callbackUrl: "https://cb" }),
    )
    const { id } = (await connectRes.json()) as { id: string }

    const delRes = await instance.fetch(new Request(`https://mcp-connections.do/servers/${id}`, { method: "DELETE" }))
    expect(delRes.status).toBe(200)
    expect(removeServerSpy).toHaveBeenCalledWith(id)

    const listRes = await instance.fetch(new Request("https://mcp-connections.do/list"))
    const body = (await listRes.json()) as { servers: unknown[] }
    expect(body.servers).toHaveLength(0)
  })

  it("disconnecting an unknown id 404s without calling removeServer (no existence leak)", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(
      new Request("https://mcp-connections.do/servers/does-not-exist", { method: "DELETE" }),
    )
    expect(res.status).toBe(404)
    expect(removeServerSpy).not.toHaveBeenCalled()
  })

  it("an empty list never errors (fresh DO instance)", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(new Request("https://mcp-connections.do/list"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { servers: unknown[] }
    expect(body.servers).toEqual([])
  })
})

describe("McpConnectionsAgent — GET /oauth-callback", () => {
  it("on success, establishes the connection so the server shows ready/tools on the next list", async () => {
    nextCallbackResult = { serverId: "srv-1", authSuccess: true }
    const instance = makeInstance()
    const res = await instance.fetch(new Request("https://mcp-connections.do/oauth-callback?code=abc&state=xyz"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authSuccess: boolean; serverId: string }
    expect(body.authSuccess).toBe(true)
    expect(establishConnectionSpy).toHaveBeenCalledWith("srv-1")
  })

  it("on failure, propagates authSuccess=false without calling establishConnection", async () => {
    nextCallbackResult = { authSuccess: false, authError: "access_denied" }
    const instance = makeInstance()
    const res = await instance.fetch(
      new Request("https://mcp-connections.do/oauth-callback?error=access_denied&state=xyz"),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { authSuccess: boolean; authError: string }
    expect(body.authSuccess).toBe(false)
    expect(body.authError).toBe("access_denied")
    expect(establishConnectionSpy).not.toHaveBeenCalled()
  })
})

describe("McpConnectionsAgent — unknown route", () => {
  it("404s anything it doesn't recognize", async () => {
    const instance = makeInstance()
    const res = await instance.fetch(new Request("https://mcp-connections.do/nope"))
    expect(res.status).toBe(404)
  })
})
