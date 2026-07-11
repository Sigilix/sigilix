import { describe, expect, it } from "vitest"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"
import {
  hashMcpOAuthState,
  MCP_OAUTH_CALLBACK_CLAIM_TTL_SECONDS,
  MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS,
  MCP_OAUTH_CALLBACK_TERMINAL_TTL_SECONDS,
  MCP_OAUTH_STATE_MAX_CHARS,
  McpOAuthCallbackRegistry,
  mcpOAuthStateHashFromUrl,
  type McpOAuthCallbackRoute,
} from "./oauth-callback-routing"

const NOW = 1_800_000_000_000
const RAW_STATE = "sdk-generated-oauth-state"

function harness() {
  const sql = new NodeSqliteStorage()
  let now = NOW
  const storage = {
    sql,
    transactionSync<T>(fn: () => T): T {
      return sql.transactionSync(fn)
    },
  } as unknown as DurableObjectStorage
  const registry = new McpOAuthCallbackRegistry(storage, () => now)
  return { registry, sql, setNow: (value: number) => (now = value) }
}

function pending(over: Partial<McpOAuthCallbackRoute> = {}): McpOAuthCallbackRoute {
  return {
    version: 2,
    stateHash: "u9Z1p5mU8_2y3YhJnQn4SfM8PkGQkUa4Qv_v7cLKdvo",
    ownerScope: "session:111",
    tenantScope: "tenant:42",
    grantId: "grant-1",
    serverId: "server-1",
    stableSubject: "user-uuid-1",
    status: "pending",
    claimId: null,
    claimExpiresAt: null,
    createdAt: NOW,
    expiresAt: NOW + MCP_OAUTH_CALLBACK_PENDING_TTL_SECONDS * 1_000,
    ...over,
  }
}

describe("MCP OAuth state hashing", () => {
  it("uses SHA-256 base64url without padding", async () => {
    expect(await hashMcpOAuthState("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0")
  })

  it("extracts exactly one bounded opaque state", async () => {
    const url = `https://provider.example/authorize?state=${RAW_STATE}`
    expect(await mcpOAuthStateHashFromUrl(url)).toBe(await hashMcpOAuthState(RAW_STATE))
    for (const invalid of [
      "not a url",
      "https://provider.example/authorize",
      "https://provider.example/authorize?state=",
      "https://provider.example/authorize?state=a&state=b",
      `https://provider.example/authorize?state=${"x".repeat(MCP_OAUTH_STATE_MAX_CHARS + 1)}`,
    ]) {
      expect(await mcpOAuthStateHashFromUrl(invalid)).toBeNull()
    }
  })
})

describe("McpOAuthCallbackRegistry", () => {
  it("atomically creates a route and refuses state rebinding", () => {
    const { registry } = harness()
    expect(registry.create(pending())).toEqual(pending())
    expect(registry.create(pending())).toEqual(pending())
    expect(registry.create(pending({ tenantScope: "tenant:99", serverId: "server-2" }))).toBeNull()
  })

  it("recovers an invalid stored record without allowing an overwrite of a valid route", () => {
    const { registry, sql } = harness()
    sql.exec(
      `INSERT INTO sigilix_mcp_oauth_route_v2
       (state_hash, version, owner_scope, tenant_scope, grant_id, server_id, stable_subject,
        status, claim_id, claim_expires_at, created_at, expires_at)
       VALUES (?, 99, 'bad', 'bad', 'bad', 'bad', 'bad', 'pending', NULL, NULL, ?, ?)`,
      pending().stateHash,
      NOW,
      NOW + 1_000,
    )
    expect(registry.create(pending())).toEqual(pending())
  })

  it("binds every lifecycle status to the same owner and stable identity", () => {
    const { registry } = harness()
    registry.create(pending())
    expect(registry.readBound(pending().stateHash, "session:222", "user-uuid-1")).toBeNull()
    expect(registry.readBound(pending().stateHash, "session:111", "user-uuid-2")).toBeNull()
    const claim = registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-1")
    expect(claim?.outcome).toBe("claimed")
    expect(registry.readBound(pending().stateHash, "session:222", "user-uuid-1")).toBeNull()
    const route = claim!.route
    expect(
      registry.finalize(route.stateHash, route.ownerScope, route.stableSubject, "claim-1", "completed"),
    ).toMatchObject({
      status: "completed",
    })
    expect(registry.readBound(pending().stateHash, "session:222", "user-uuid-1")).toBeNull()
  })

  it("admits one durable callback processor and makes duplicates wait", () => {
    const { registry } = harness()
    registry.create(pending())
    const first = registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-1")
    const duplicate = registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-2")
    expect(first).toMatchObject({ outcome: "claimed", route: { status: "processing", claimId: "claim-1" } })
    expect(duplicate).toMatchObject({ outcome: "wait", route: { claimId: "claim-1" } })
    expect(registry.finalize(pending().stateHash, "session:111", "user-uuid-1", "claim-2", "failed")).toBeNull()
  })

  it("moves the alarm to a fresh processing lease so pending cleanup cannot delete the winner", () => {
    const { registry, setNow } = harness()
    registry.create(pending())
    const claimedAt = pending().expiresAt - 1
    setNow(claimedAt)
    expect(registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-1")).toMatchObject({
      outcome: "claimed",
      route: {
        status: "processing",
        expiresAt: claimedAt + MCP_OAUTH_CALLBACK_CLAIM_TTL_SECONDS * 1_000,
      },
    })
  })

  it("retains terminal state for a full future window and makes finalize idempotent", () => {
    const { registry, setNow } = harness()
    registry.create(pending())
    const claimed = registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-1")!.route
    setNow(NOW + 1_000)
    const completed = registry.finalize(
      claimed.stateHash,
      claimed.ownerScope,
      claimed.stableSubject,
      "claim-1",
      "completed",
    )
    expect(completed).toMatchObject({
      status: "completed",
      expiresAt: NOW + 1_000 + MCP_OAUTH_CALLBACK_TERMINAL_TTL_SECONDS * 1_000,
    })
    expect(
      registry.finalize(claimed.stateHash, claimed.ownerScope, claimed.stableSubject, "claim-1", "completed"),
    ).toEqual(completed)
  })

  it("turns an expired pending route terminal for credential cleanup", () => {
    const { registry, setNow } = harness()
    registry.create(pending())
    setNow(pending().expiresAt)
    expect(registry.claim(pending().stateHash, "session:111", "user-uuid-1", "claim-1")).toMatchObject({
      outcome: "terminal",
      expired: true,
      route: { status: "failed", expiresAt: pending().expiresAt + MCP_OAUTH_CALLBACK_TERMINAL_TTL_SECONDS * 1_000 },
    })
  })

  it("keeps an expired failed route durable until cleanup explicitly succeeds", () => {
    const { registry, setNow } = harness()
    registry.create(pending())
    setNow(pending().expiresAt)
    const failed = registry.expireDue()
    expect(failed).toMatchObject({ status: "failed" })
    setNow(failed!.expiresAt)
    expect(registry.readBound(failed!.stateHash, failed!.ownerScope, failed!.stableSubject)).toEqual(failed)
    expect(registry.expireDue()).toEqual(failed)
    registry.deleteFailed(failed!.stateHash)
    expect(registry.readBound(failed!.stateHash, failed!.ownerScope, failed!.stableSubject)).toBeNull()
  })
})
