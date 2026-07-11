import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentMcpCapabilityDO, type AgentMcpCapabilityRecord } from "./agent-mcp-capability"
import { sha256Hex } from "@/src/lib/auth-bearer"
import type { Env } from "@/src/shared/types/env"

const RUN_ID = "11111111-1111-4111-8111-111111111111"

function makeDo(options: { deleteAlarmFails?: boolean; deleteAllFails?: boolean } = {}): {
  capability: AgentMcpCapabilityDO
  store: Map<string, unknown>
  alarm: () => number | null
} {
  interface TestStorage {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    deleteAll(): Promise<void>
    deleteAlarm(): Promise<void>
    setAlarm(timestamp: number): Promise<void>
    transaction<T>(fn: (transaction: TestStorage) => Promise<T>): Promise<T>
  }
  const store = new Map<string, unknown>()
  let alarmAt: number | null = null
  let transactionTail = Promise.resolve()
  const storage: TestStorage = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(store.get(key)) as T | undefined
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, structuredClone(value))
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key)
    },
    async deleteAll(): Promise<void> {
      if (options.deleteAllFails) throw new Error("storage delete failed")
      store.clear()
    },
    async deleteAlarm(): Promise<void> {
      if (options.deleteAlarmFails) throw new Error("alarm delete failed")
      alarmAt = null
    },
    async setAlarm(timestamp: number): Promise<void> {
      alarmAt = timestamp
    },
    async transaction<T>(fn: (transaction: typeof storage) => Promise<T>): Promise<T> {
      const previous = transactionTail
      let release!: () => void
      transactionTail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        return await fn(storage)
      } finally {
        release()
      }
    },
  }
  const ctx = { storage, id: { toString: () => RUN_ID } } as unknown as DurableObjectState
  return { capability: new AgentMcpCapabilityDO(ctx, {} as Env), store, alarm: () => alarmAt }
}

async function record(rawCapability = "a".repeat(64)): Promise<AgentMcpCapabilityRecord> {
  return {
    version: 1,
    capabilityHash: await sha256Hex(rawCapability),
    runId: RUN_ID,
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
        inputSchema: { type: "object" },
      },
    ],
    expiresAt: Date.now() + 60_000,
    maxCalls: 4,
    callsUsed: 0,
    catalogReadsUsed: 0,
  }
}

afterEach(() => vi.useRealTimers())

describe("AgentMcpCapabilityDO", () => {
  it("persists only the digest, exact case-preserved binding, and expiry alarm", async () => {
    const raw = "b".repeat(64)
    const { capability, store, alarm } = makeDo()
    const value = await record(raw)

    expect(await capability.initialize(value)).toBe(true)

    const persisted = store.get("capability") as AgentMcpCapabilityRecord
    expect(JSON.stringify(persisted)).not.toContain(raw)
    expect(persisted.capabilityHash).toBe(await sha256Hex(raw))
    expect(persisted).toMatchObject({ owner: "Sigilix", repo: "Portal", installationId: 42, surface: "agent" })
    expect(alarm()).toBe(value.expiresAt)
  })

  it("rejects a capability whose persisted lifetime exceeds the 15-minute ceiling", async () => {
    const { capability, store, alarm } = makeDo()
    const value = await record()
    value.expiresAt = Date.now() + 15 * 60_000 + 1_000

    expect(await capability.initialize(value)).toBe(false)
    expect(store.size).toBe(0)
    expect(alarm()).toBeNull()
  })

  it("rejects another digest and never returns the stored digest", async () => {
    const { capability } = makeDo()
    await capability.initialize(await record())

    expect(await capability.authorize(await sha256Hex("c".repeat(64)), "revalidate")).toEqual({
      ok: false,
      reason: "mismatch",
    })
    const authorized = await capability.authorize(await sha256Hex("a".repeat(64)), "revalidate")
    expect(authorized.ok).toBe(true)
    expect(JSON.stringify(authorized)).not.toContain("capabilityHash")
  })

  it("atomically enforces one global four-call budget across every tool", async () => {
    const { capability } = makeDo()
    const hash = await sha256Hex("a".repeat(64))
    await capability.initialize(await record())

    const admitted = await Promise.all(Array.from({ length: 5 }, () => capability.authorize(hash, "invoke")))

    expect(admitted.filter((result) => result.ok)).toHaveLength(4)
    expect(admitted.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "budget" }])
  })

  it("bounds catalog reads separately without spending the invoke budget", async () => {
    const { capability } = makeDo()
    const hash = await sha256Hex("a".repeat(64))
    await capability.initialize(await record())

    for (let count = 0; count < 8; count += 1) expect((await capability.authorize(hash, "catalog")).ok).toBe(true)
    expect(await capability.authorize(hash, "catalog")).toEqual({ ok: false, reason: "budget" })
    expect((await capability.authorize(hash, "invoke")).ok).toBe(true)
  })

  it("expires fail-closed and clears state even if terminal finally never ran", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-11T18:00:00.000Z"))
    const { capability, store } = makeDo()
    const value = await record()
    value.expiresAt = Date.now() + 1_000
    await capability.initialize(value)
    vi.setSystemTime(new Date(Date.now() + 1_001))

    expect(await capability.authorize(await sha256Hex("a".repeat(64)), "revalidate")).toEqual({
      ok: false,
      reason: "expired",
    })
    expect(store.size).toBe(0)
  })

  it("terminal revoke and the alarm both delete every persisted field", async () => {
    const first = makeDo()
    await first.capability.initialize(await record())
    await first.capability.revoke()
    expect(first.store.size).toBe(0)
    expect(first.alarm()).toBeNull()

    const second = makeDo()
    await second.capability.initialize(await record())
    await second.capability.alarm()
    expect(second.store.size).toBe(0)
    expect(second.alarm()).toBeNull()

    const third = makeDo({ deleteAlarmFails: true })
    await third.capability.initialize(await record())
    await expect(third.capability.revoke()).rejects.toThrow("alarm delete failed")
    expect(third.store.size).toBe(0)

    const fourth = makeDo({ deleteAllFails: true })
    await fourth.capability.initialize(await record())
    await expect(fourth.capability.revoke()).rejects.toThrow("storage delete failed")
    expect(fourth.store.size).toBe(0)
    expect(await fourth.capability.authorize(await sha256Hex("a".repeat(64)), "revalidate")).toEqual({
      ok: false,
      reason: "missing",
    })
  })
})
