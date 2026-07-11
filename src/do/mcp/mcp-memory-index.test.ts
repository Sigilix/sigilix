import { describe, expect, it } from "vitest"
import { NodeSqliteStorage } from "@/src/test-shims/cloudflare-workers-shim"
import {
  MCP_MEMORY_DIMENSIONS,
  MCP_MEMORY_MAX_PER_GRANT,
  MCP_MEMORY_MAX_PER_TENANT,
  TenantMcpMemoryIndex,
  canonicalMcpInputHash,
  scoreMcpMemoryRecords,
} from "./mcp-memory-index"

function embedding(value: number): number[] {
  return Array.from({ length: MCP_MEMORY_DIMENSIONS }, (_, index) => (index === 0 ? value : 0))
}

function memoryIndex(): TenantMcpMemoryIndex {
  const sql = new NodeSqliteStorage()
  return new TenantMcpMemoryIndex({
    sql,
    transactionSync: <T>(callback: () => T) => sql.transactionSync(callback),
  } as unknown as DurableObjectStorage)
}

function writeArgs(overrides: Partial<Parameters<TenantMcpMemoryIndex["writeIfAuthorized"]>[0]> = {}) {
  return {
    id: "mem-1",
    installationId: 42,
    grantId: "grant-1",
    provider: "linear" as const,
    toolName: "list_comments",
    inputHash: "a".repeat(64),
    content: "first result",
    embedding: embedding(1),
    sourceAt: 1_000,
    expiresAt: 2_000,
    policyVersion: 3,
    ...overrides,
  }
}

describe("TenantMcpMemoryIndex", () => {
  it("stores no raw arguments and idempotently replaces the same provenance identity", () => {
    const index = memoryIndex()

    expect(index.writeIfAuthorized(writeArgs(), () => true)).toEqual({ outcome: "stored" })
    expect(
      index.writeIfAuthorized(
        writeArgs({ content: "fresh result", embedding: embedding(2), sourceAt: 1_500, expiresAt: 2_500 }),
        () => true,
      ),
    ).toEqual({ outcome: "replaced" })

    const rows = index.listCandidates(42, ["grant-1"], 1_600)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      installationId: 42,
      grantId: "grant-1",
      provider: "linear",
      toolName: "list_comments",
      inputHash: "a".repeat(64),
      content: "fresh result",
      sourceAt: 1_500,
      expiresAt: 2_500,
      policyVersion: 3,
    })
    expect(rows[0]?.embedding[0]).toBeCloseTo(2)
    expect(JSON.stringify(rows[0])).not.toContain("arguments")
  })

  it("checks authorization inside the same transaction and stores nothing when denied", () => {
    const index = memoryIndex()

    expect(index.writeIfAuthorized(writeArgs(), () => false)).toEqual({ outcome: "denied" })
    expect(index.listCandidates(42, ["grant-1"], 1_100)).toEqual([])
  })

  it("hard-bounds unique rows per grant while allowing an existing identity to refresh at capacity", () => {
    const index = memoryIndex()
    for (let i = 0; i < MCP_MEMORY_MAX_PER_GRANT; i += 1) {
      expect(
        index.writeIfAuthorized(writeArgs({ id: `g-${i}`, inputHash: i.toString(16).padStart(64, "0") }), () => true)
          .outcome,
      ).toBe("stored")
    }

    expect(index.writeIfAuthorized(writeArgs({ id: "overflow", inputHash: "f".repeat(64) }), () => true)).toEqual({
      outcome: "capacity",
    })
    expect(
      index.writeIfAuthorized(writeArgs({ id: "g-0", inputHash: "0".repeat(64), content: "replacement" }), () => true),
    ).toEqual({ outcome: "replaced" })
  })

  it("hard-bounds the whole tenant across grants", () => {
    const index = memoryIndex()
    for (let i = 0; i < MCP_MEMORY_MAX_PER_TENANT; i += 1) {
      const grant = `grant-${Math.floor(i / MCP_MEMORY_MAX_PER_GRANT)}`
      expect(
        index.writeIfAuthorized(
          writeArgs({ id: `t-${i}`, grantId: grant, inputHash: i.toString(16).padStart(64, "0") }),
          () => true,
        ).outcome,
      ).toBe("stored")
    }
    expect(
      index.writeIfAuthorized(
        writeArgs({ id: "tenant-overflow", grantId: "grant-extra", inputHash: "e".repeat(64) }),
        () => true,
      ),
    ).toEqual({ outcome: "capacity" })
  })

  it("enforces expiry, replaces TTL on refresh, and ignores stale expiry messages", () => {
    const index = memoryIndex()
    index.writeIfAuthorized(writeArgs(), () => true)
    index.writeIfAuthorized(writeArgs({ sourceAt: 1_500, expiresAt: 3_000 }), () => true)

    expect(index.expireRecord(42, "mem-1", 2_000, 2_100)).toEqual({ outcome: "stale" })
    expect(index.listCandidates(42, ["grant-1"], 2_100)).toHaveLength(1)
    expect(index.expireRecord(42, "mem-1", 3_000, 2_900)).toEqual({ outcome: "early", rescheduleAt: 3_000 })
    expect(index.expireRecord(42, "mem-1", 3_000, 3_000)).toEqual({ outcome: "deleted" })
    expect(index.listCandidates(42, ["grant-1"], 3_000)).toEqual([])
  })

  it("atomically purges every row for a revoked grant without touching another grant", () => {
    const index = memoryIndex()
    index.writeIfAuthorized(writeArgs(), () => true)
    index.writeIfAuthorized(writeArgs({ id: "mem-2", grantId: "grant-2", inputHash: "b".repeat(64) }), () => true)

    expect(index.purgeGrant("grant-1")).toBe(1)
    expect(index.listCandidates(42, ["grant-1", "grant-2"], 1_100).map((row) => row.grantId)).toEqual(["grant-2"])
  })

  it("canonicalizes object order before hashing inputs", async () => {
    const first = await canonicalMcpInputHash({ z: [2, { b: true, a: null }], a: "x" })
    const second = await canonicalMcpInputHash({ a: "x", z: [2, { a: null, b: true }] })
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

  it("scores compact embeddings deterministically and excludes malformed vectors", () => {
    const index = memoryIndex()
    index.writeIfAuthorized(writeArgs({ id: "near", embedding: embedding(1) }), () => true)
    index.writeIfAuthorized(
      writeArgs({ id: "far", inputHash: "b".repeat(64), embedding: [0, 1, ...Array(766).fill(0)] }),
      () => true,
    )
    const scored = scoreMcpMemoryRecords(index.listCandidates(42, ["grant-1"], 1_100), embedding(1))
    expect(scored.map((item) => item.record.id)).toEqual(["near", "far"])
    expect(scored[0]?.score).toBeCloseTo(1)
    expect(scored[1]?.score).toBeCloseTo(0)
  })
})
