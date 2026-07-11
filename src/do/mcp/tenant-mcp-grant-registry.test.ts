import { describe, expect, it } from "vitest"
import { TenantMcpGrantRegistry } from "./tenant-mcp-grant-registry"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"

function makeHarness() {
  const sql = new NodeSqliteStorage()
  let now = 1_000
  const storage = {
    sql,
    transactionSync<T>(fn: () => T): T {
      return sql.transactionSync(fn)
    },
  } as unknown as DurableObjectStorage
  const registry = new TenantMcpGrantRegistry(storage, {
    now: () => now,
  })
  return {
    registry,
    storage,
    setNow(value: number) {
      now = value
    },
  }
}

const BASE_GRANT = {
  grantId: "grant-1",
  ownerScope: "session:42",
  serverId: "server-1",
  creatorSubject: "github:42",
  serverUrl: "https://mcp.linear.app/mcp",
}

const DEFAULT_POLICY = {
  version: 0,
  enabled: false,
  surfaces: {
    chat: false,
    "deep-research": false,
    cli: false,
    "pr-review": false,
    agent: false,
    "memory-index": false,
  },
  allowedReadTools: [],
  maxCallsPerRun: 0,
}

describe("TenantMcpGrantRegistry", () => {
  it("creates and durably reads a bounded, opaque pending grant", () => {
    const { registry, storage } = makeHarness()

    const created = registry.createPending(BASE_GRANT)

    expect(created).toEqual({
      outcome: "created",
      grant: {
        ...BASE_GRANT,
        status: "pending",
        policy: DEFAULT_POLICY,
        createdAt: 1_000,
        updatedAt: 1_000,
        activatedAt: null,
        failedAt: null,
        revokedAt: null,
      },
    })
    expect(new TenantMcpGrantRegistry(storage).listOpen()).toEqual([created.grant])
  })

  it("returns the existing pending or active grant for the same owner and server", () => {
    const { registry, setNow } = makeHarness()
    const first = registry.createPending(BASE_GRANT)

    setNow(2_000)
    expect(
      registry.createPending({
        ...BASE_GRANT,
        grantId: "grant-retry",
        creatorSubject: "github:someone-else",
      }),
    ).toEqual({ outcome: "existing", grant: first.grant })

    const active = registry.activate(first.grant.grantId)
    setNow(3_000)
    expect(registry.createPending({ ...BASE_GRANT, grantId: "grant-after-active" })).toEqual({
      outcome: "existing",
      grant: active,
    })
  })

  it("allows independent open grants for a different owner or server", () => {
    const { registry } = makeHarness()

    const first = registry.createPending(BASE_GRANT)
    const second = registry.createPending({ ...BASE_GRANT, grantId: "grant-2", serverId: "server-2" })
    const third = registry.createPending({
      ...BASE_GRANT,
      grantId: "grant-3",
      ownerScope: "session:99",
      creatorSubject: "github:99",
    })

    expect([first.grant.grantId, second.grant.grantId, third.grant.grantId]).toEqual(["grant-1", "grant-2", "grant-3"])
  })

  it("activates only pending grants and is idempotent without rewriting timestamps", () => {
    const { registry, setNow } = makeHarness()
    const pending = registry.createPending(BASE_GRANT).grant

    setNow(2_000)
    const active = registry.activate(pending.grantId)
    expect(active).toMatchObject({ status: "active", updatedAt: 2_000, activatedAt: 2_000 })

    setNow(3_000)
    expect(registry.activate(pending.grantId)).toEqual(active)
    expect(registry.getActive(pending.grantId)).toEqual(active)
    expect(registry.activate("missing-grant")).toBeNull()
  })

  it("fails only pending grants and never resurrects a terminal grant", () => {
    const { registry, setNow } = makeHarness()
    const pending = registry.createPending(BASE_GRANT).grant

    setNow(2_000)
    const failed = registry.fail(pending.grantId)
    expect(failed).toMatchObject({ status: "failed", updatedAt: 2_000, failedAt: 2_000 })

    setNow(3_000)
    expect(registry.fail(pending.grantId)).toEqual(failed)
    expect(registry.activate(pending.grantId)).toEqual(failed)
    expect(registry.getActive(pending.grantId)).toBeNull()
  })

  it("does not let a late failure downgrade an active grant", () => {
    const { registry, setNow } = makeHarness()
    const pending = registry.createPending(BASE_GRANT).grant
    setNow(2_000)
    const active = registry.activate(pending.grantId)

    setNow(3_000)
    expect(registry.fail(pending.grantId)).toEqual(active)
    expect(registry.getActive(pending.grantId)).toEqual(active)
  })

  it("lists only pending and active grants in deterministic order and can filter by owner", () => {
    const { registry, setNow } = makeHarness()
    const pending = registry.createPending(BASE_GRANT).grant
    setNow(2_000)
    const active = registry.createPending({
      ...BASE_GRANT,
      grantId: "grant-2",
      serverId: "server-2",
    }).grant
    registry.activate(active.grantId)
    setNow(3_000)
    const otherOwner = registry.createPending({
      ...BASE_GRANT,
      grantId: "grant-3",
      ownerScope: "session:99",
      creatorSubject: "github:99",
    }).grant
    registry.fail(otherOwner.grantId)

    expect(registry.listOpen()).toEqual([
      pending,
      expect.objectContaining({ grantId: active.grantId, status: "active" }),
    ])
    expect(registry.listOpen("session:42").map((grant) => grant.grantId)).toEqual([pending.grantId, active.grantId])
    expect(registry.listOpen("session:99")).toEqual([])
  })

  it("revokes synchronously, stays idempotent, and releases the owner/server slot", () => {
    const { registry, setNow } = makeHarness()
    const pending = registry.createPending(BASE_GRANT).grant

    setNow(2_000)
    const revoked = registry.revoke(pending.grantId)
    expect(revoked).toMatchObject({ status: "revoked", updatedAt: 2_000, revokedAt: 2_000 })
    expect(registry.listOpen()).toEqual([])

    setNow(3_000)
    expect(registry.revoke(pending.grantId)).toEqual(revoked)
    expect(registry.createPending({ ...BASE_GRANT, grantId: "grant-2" })).toMatchObject({
      outcome: "created",
      grant: { grantId: "grant-2", status: "pending" },
    })
    expect(registry.revoke("missing-grant")).toBeNull()
  })

  it("garbage-collects stale pending grants into failed audit rows only", () => {
    const { registry, setNow } = makeHarness()
    const stale = registry.createPending(BASE_GRANT).grant
    setNow(2_000)
    const active = registry.createPending({ ...BASE_GRANT, grantId: "grant-2", serverId: "server-2" }).grant
    registry.activate(active.grantId)
    const fresh = registry.createPending({ ...BASE_GRANT, grantId: "grant-3", serverId: "server-3" }).grant

    setNow(3_000)
    expect(registry.gcStalePending(1_500)).toBe(1)
    expect(registry.activate(stale.grantId)).toMatchObject({ status: "failed", failedAt: 3_000 })
    expect(registry.getActive(active.grantId)).toMatchObject({ status: "active" })
    expect(registry.listOpen().map((grant) => grant.grantId)).toEqual([active.grantId, fresh.grantId])
  })

  it("versions an independent tenant policy and rejects stale writes", () => {
    const { registry } = makeHarness()
    registry.createPending(BASE_GRANT)
    registry.activate(BASE_GRANT.grantId)
    const update = {
      version: 0,
      enabled: true,
      surfaces: { ...DEFAULT_POLICY.surfaces, cli: true },
      allowedReadTools: ["list_comments"],
      maxCallsPerRun: 1,
    }
    expect(registry.updatePolicy(BASE_GRANT.grantId, update)).toMatchObject({
      grant: { policy: { ...update, version: 1 } },
    })
    expect(registry.updatePolicy(BASE_GRANT.grantId, update)).toEqual({ error: "stale_version" })
  })

  it("rejects unstable scopes and unbounded or malformed identifiers", () => {
    const { registry } = makeHarness()

    for (const ownerScope of [
      "tenant:42",
      "session:",
      "session:anon",
      "session:anonymous",
      "session: subject-with-space",
      `session:${"x".repeat(129)}`,
    ]) {
      expect(() => registry.createPending({ ...BASE_GRANT, ownerScope })).toThrow("invalid ownerScope")
    }
    expect(() => registry.createPending({ ...BASE_GRANT, serverId: "bad server" })).toThrow("invalid serverId")
    expect(() => registry.createPending({ ...BASE_GRANT, creatorSubject: "" })).toThrow("invalid creatorSubject")
    expect(() =>
      registry.createPending({ ...BASE_GRANT, serverUrl: "https://mcp.linear.app/mcp?token=secret" }),
    ).toThrow("invalid serverUrl")
    expect(() => registry.createPending({ ...BASE_GRANT, grantId: "bad generated grant id" })).toThrow(
      "invalid grantId",
    )
    expect(() => registry.activate("bad grant id")).toThrow("invalid grantId")
    expect(() => registry.revoke("x".repeat(129))).toThrow("invalid grantId")
    expect(() => registry.listOpen("tenant:42")).toThrow("invalid ownerScope")
    expect(() => registry.gcStalePending(-1)).toThrow("invalid cutoffMs")

    registry.createPending(BASE_GRANT)
    expect(() => registry.createPending({ ...BASE_GRANT, serverId: "server-2" })).toThrow("grantId already exists")
  })
})
