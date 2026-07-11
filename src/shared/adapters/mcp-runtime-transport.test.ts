import { describe, expect, it, vi } from "vitest"
import { postBoundedMcpJson } from "./mcp-runtime-transport"

function stub(fetch: (request: Request) => Promise<Response>): DurableObjectStub {
  return { fetch: vi.fn(fetch) } as unknown as DurableObjectStub
}

describe("postBoundedMcpJson", () => {
  it("bounds a stub that ignores Request.signal", async () => {
    vi.useFakeTimers()
    try {
      const target = stub(() => new Promise(() => undefined))
      let result: unknown = "pending"
      void postBoundedMcpJson(target, "/runtime", {}, { timeoutMs: 50 }).then((value) => {
        result = value
      })
      await vi.advanceTimersByTimeAsync(51)
      expect(result).toMatchObject({ status: null, errorName: "AbortError", timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not contact a stub after the caller deadline has already expired", async () => {
    const target = stub(async () => new Response("{}"))
    const controller = new AbortController()
    controller.abort()
    await expect(
      postBoundedMcpJson(target, "/runtime", {}, { timeoutMs: 50, signal: controller.signal }),
    ).resolves.toMatchObject({ status: null, errorName: "AbortError", timedOut: false })
    expect(target.fetch).not.toHaveBeenCalled()
  })

  it("rejects an actually streamed body over the byte cap", async () => {
    const target = stub(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"value":"123456"}'))
              controller.close()
            },
          }),
        ),
    )
    await expect(
      postBoundedMcpJson(target, "/runtime", {}, { timeoutMs: 50, maxResponseBytes: 4 }),
    ).resolves.toMatchObject({ status: null, errorName: "McpResponseRejected" })
  })
})
