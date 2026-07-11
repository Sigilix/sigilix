import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { handleMcpMemoryExpireJob } from "./mcp-memory-jobs"

const JOB = {
  type: "mcp-memory-expire" as const,
  installationId: 42,
  memoryId: "a".repeat(64),
  expectedExpiresAt: Date.parse("2026-07-11T00:00:00.000Z"),
}

afterEach(() => vi.useRealTimers())

function environment(response: Response): {
  env: Env
  names: string[]
  requests: Request[]
  send: ReturnType<typeof vi.fn>
} {
  const names: string[] = []
  const requests: Request[] = []
  const send = vi.fn(async () => undefined)
  const namespace = {
    idFromName(name: string) {
      names.push(name)
      return { toString: () => name } as unknown as DurableObjectId
    },
    get() {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new Request(input, init))
          return response.clone()
        },
      } as unknown as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
  return {
    env: { MCP_CONNECTIONS: namespace, OPENCLAW_JOBS: { send } } as unknown as Env,
    names,
    requests,
    send,
  }
}

describe("MCP memory expiry queue", () => {
  it("routes to the exact tenant and reschedules an early delivery by absolute expiry", async () => {
    vi.useFakeTimers()
    vi.setSystemTime("2026-07-10T23:59:55.000Z")
    const setup = environment(
      new Response(JSON.stringify({ outcome: "early", rescheduleAt: JOB.expectedExpiresAt }), { status: 200 }),
    )

    await handleMcpMemoryExpireJob(JOB, setup.env)

    expect(setup.names).toEqual(["tenant:42"])
    expect(new URL(setup.requests[0]!.url).pathname).toBe("/broker/memory/expire")
    expect(await setup.requests[0]!.json()).toEqual({
      memoryId: JOB.memoryId,
      expectedExpiresAt: JOB.expectedExpiresAt,
    })
    expect(setup.send).toHaveBeenCalledWith(JOB, { delaySeconds: 5 })
  })

  it("acks terminal outcomes without another queue message", async () => {
    const setup = environment(new Response(JSON.stringify({ outcome: "deleted" }), { status: 200 }))

    await handleMcpMemoryExpireJob(JOB, setup.env)

    expect(setup.send).not.toHaveBeenCalled()
  })

  it("retries non-success responses and rejects malformed jobs before routing", async () => {
    const unavailable = environment(new Response("unavailable", { status: 503 }))
    await expect(handleMcpMemoryExpireJob(JOB, unavailable.env)).rejects.toThrow("expiry failed (503)")

    const malformed = environment(new Response(JSON.stringify({ outcome: "missing" }), { status: 200 }))
    await expect(handleMcpMemoryExpireJob({ ...JOB, installationId: -1 }, malformed.env)).rejects.toThrow(
      "invalid MCP memory expiry job",
    )
    expect(malformed.names).toEqual([])
  })
})
