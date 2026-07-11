import { describe, expect, it, vi } from "vitest"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"
import type { Env } from "@/src/shared/types/env"
import { McpOAuthCallbackDoHandler } from "./oauth-callback-do-handler"

function harness(failBody: unknown) {
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
