import { describe, expect, it, vi } from "vitest"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"
import type { Env } from "@/src/shared/types/env"
import { McpOAuthCallbackDoHandler } from "./oauth-callback-do-handler"

function harness(failBody: unknown, seedExpired = true) {
  const sql = new NodeSqliteStorage()
  const setAlarm = vi.fn(async () => undefined)
  const storage = {
    sql,
    transactionSync<T>(fn: () => T): T {
      return sql.transactionSync(fn)
    },
    setAlarm,
  } as unknown as DurableObjectStorage
  const calls: Array<{ scope: string; path: string; method: string }> = []
  const namespace = {
    idFromName: (scope: string) => ({ toString: () => scope }) as unknown as DurableObjectId,
    get: (id: DurableObjectId) =>
      ({
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          const call = { scope: id.toString(), path: new URL(request.url).pathname, method: request.method }
          calls.push(call)
          if (call.scope === "tenant:42" && call.path.endsWith("/fail")) {
            return new Response(JSON.stringify(failBody))
          }
          return new Response(JSON.stringify({ ok: true }))
        },
      }) as unknown as DurableObjectStub,
  } as unknown as DurableObjectNamespace
  const handler = new McpOAuthCallbackDoHandler(storage, { MCP_CONNECTIONS: namespace } as Env)
  const now = Date.now()
  if (seedExpired) {
    sql.exec(
      `INSERT INTO sigilix_mcp_oauth_route_v2
       (state_hash, version, owner_scope, tenant_scope, grant_id, server_id, stable_subject,
        status, claim_id, claim_expires_at, created_at, expires_at)
       VALUES (?, 2, 'session:111', 'tenant:42', 'grant-1', 'server-1', '111',
               'pending', NULL, NULL, ?, ?)`,
      "a".repeat(43),
      now - 2_000,
      now - 1_000,
    )
  }
  return { handler, calls, setAlarm }
}

describe("McpOAuthCallbackDoHandler alarm cleanup", () => {
  it.each([
    ["active grant", { grant: { status: "active" } }],
    ["ambiguous success", { ok: true }],
  ])("revokes an %s instead of treating POST /fail HTTP 200 as cleanup", async (_name, failBody) => {
    const { handler, calls } = harness(failBody)

    await handler.alarm()

    expect(calls).toEqual(
      expect.arrayContaining([
        { scope: "session:111", path: "/servers/server-1", method: "DELETE" },
        { scope: "tenant:42", path: "/grants/grant-1/fail", method: "POST" },
        { scope: "tenant:42", path: "/broker/servers/grant-1", method: "DELETE" },
      ]),
    )
  })
})

describe("McpOAuthCallbackDoHandler lifecycle", () => {
  it("validates create payloads and serves a bound create/read/claim/finalize lifecycle", async () => {
    const { handler, setAlarm } = harness({ grant: { status: "failed" } }, false)
    const now = Date.now()
    const route = {
      version: 2,
      stateHash: "a".repeat(43),
      ownerScope: "session:111",
      tenantScope: "tenant:42",
      grantId: "grant-1",
      serverId: "server-1",
      stableSubject: "111",
      status: "pending",
      claimId: null,
      claimExpiresAt: null,
      createdAt: now,
      expiresAt: now + 60_000,
    }
    const post = (action: string, body: unknown) =>
      handler.handle(
        action,
        new Request(`https://mcp-connections.do/oauth-route/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )

    expect((await post("create", { ...route, ownerScope: "wrong" })).status).toBe(400)
    expect((await post("create", route)).status).toBe(201)
    expect(setAlarm).toHaveBeenCalledWith(route.expiresAt)
    expect(
      (await post("read", { stateHash: route.stateHash, ownerScope: "session:222", stableSubject: "111" })).status,
    ).toBe(404)

    const claimed = await post("claim", {
      stateHash: route.stateHash,
      ownerScope: route.ownerScope,
      stableSubject: route.stableSubject,
      claimId: "claim-1",
    })
    expect(claimed.status).toBe(200)
    expect(await claimed.json()).toMatchObject({ outcome: "claimed", route: { claimId: "claim-1" } })

    const finalized = await post("finalize", {
      stateHash: route.stateHash,
      ownerScope: route.ownerScope,
      stableSubject: route.stableSubject,
      claimId: "claim-1",
      status: "completed",
    })
    expect(finalized.status).toBe(200)
    const finalizedBody = (await finalized.json()) as { route: { status: string; expiresAt: number } }
    expect(finalizedBody).toMatchObject({ route: { status: "completed" } })
    expect(setAlarm).toHaveBeenLastCalledWith(finalizedBody.route.expiresAt)

    const terminal = await post("claim", {
      stateHash: route.stateHash,
      ownerScope: route.ownerScope,
      stableSubject: route.stableSubject,
      claimId: "claim-2",
    })
    expect(terminal.status).toBe(200)
    expect(await terminal.json()).toMatchObject({ outcome: "terminal", expired: false })
  })
})
