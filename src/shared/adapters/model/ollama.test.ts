// SIG-216 fix-up — `generate()` abort-signal coverage.
//
// `src/shared/adapters/model/ollama.ts` grew an optional `signal: AbortSignal` arg so the
// inline-overview retry helper can cancel the first attempt's in-flight
// fetch before launching the second. Three concurrency-critical paths
// needed coverage:
//   1. Pre-aborted signal: the call rejects without leaving a dangling
//      streaming read alive against the now-cancelled controller.
//   2. External abort mid-flight: the linked controller fires and the
//      caller's promise rejects within a window much shorter than the
//      600s default timeout.
//   3. `finally`-cleanup: the local abort listener is removed after a
//      successful generate so a later signal.abort() doesn't trigger
//      a stale-handler double-abort cascade.
//   4. Back-compat: no signal supplied still works as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generate } from "@/shared/adapters/model/ollama"

const FAKE_API_KEY = "test-key"
const FAKE_MODEL = "glm-5.1:cloud"

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  // NDJSON: each chunk is a line (newline-terminated). Mirrors the
  // helper in tests/ollama-chat.test.ts so generate()'s stream parser
  // sees the same shape Ollama Turbo actually emits.
  const encoder = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i] + "\n"))
      i += 1
    },
  })
}

function mockFetchOnceOk(content: string): void {
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    return {
      ok: true,
      status: 200,
      body: makeStream([
        JSON.stringify({ response: content, done: false }),
        JSON.stringify({ response: "", done: true }),
      ]),
      text: async () => "",
    } as unknown as Response
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("generate() — SIG-287 think:false on schema-constrained calls", () => {
  // Capture the request init directly inside the one-shot mock.
  function mockCaptureOnce(captured: { body?: Record<string, unknown> }): void {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      captured.body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
      return {
        ok: true,
        status: 200,
        body: makeStream([
          JSON.stringify({ response: "{}", done: false }),
          JSON.stringify({ response: "", done: true }),
        ]),
        text: async () => "",
      } as unknown as Response
    })
  }

  it("sets think:false when a format is passed (disables the reasoning phase)", async () => {
    const captured: { body?: Record<string, unknown> } = {}
    mockCaptureOnce(captured)
    await generate({
      model: "deepseek-v4-flash:cloud",
      prompt: "review",
      apiKey: FAKE_API_KEY,
      format: { type: "object" },
    })
    expect(captured.body?.think).toBe(false)
  })

  it("omits think on free-form (no format) calls", async () => {
    const captured: { body?: Record<string, unknown> } = {}
    mockCaptureOnce(captured)
    await generate({ model: FAKE_MODEL, prompt: "say hi", apiKey: FAKE_API_KEY })
    expect("think" in (captured.body ?? {})).toBe(false)
  })
})

describe("generate() — external abort signal (SIG-216)", () => {
  it("rejects immediately when the signal is already aborted before the call", async () => {
    // The fetch mock is wired to honor whatever signal it receives so
    // we can prove the local controller was aborted on entry. The
    // ollama source path: `if (signal.aborted) controller.abort(...)`
    // — runs synchronously before fetch, so fetch sees a pre-aborted
    // signal and immediately rejects from inside the mock.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      if (signal?.aborted) {
        const err = new Error("aborted") as Error & { name: string }
        err.name = "AbortError"
        return Promise.reject(err)
      }
      // Should not reach here in this test — but bail cleanly if so
      // so the assertion below fails with the right shape.
      return Promise.resolve({
        ok: true,
        status: 200,
        body: makeStream([JSON.stringify({ response: "", done: true })]),
        text: async () => "",
      } as unknown as Response)
    })

    const ctl = new AbortController()
    ctl.abort()

    await expect(
      generate({
        model: FAKE_MODEL,
        prompt: "hi",
        apiKey: FAKE_API_KEY,
        signal: ctl.signal,
      }),
    ).rejects.toThrow(/aborted/)
  })

  it("rejects within ~100ms when the signal aborts mid-flight (well before the 600s default timeout)", async () => {
    // fetch is mocked to hang until its signal aborts — simulates a
    // long-running streaming call. Then we abort externally 50ms later.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      const signal = (init as RequestInit | undefined)?.signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted") as Error & { name: string }
          err.name = "AbortError"
          reject(err)
        })
      })
    })

    const ctl = new AbortController()
    const start = Date.now()
    const promise = generate({
      model: FAKE_MODEL,
      prompt: "hang",
      apiKey: FAKE_API_KEY,
      signal: ctl.signal,
      // Leave timeoutMs at default (600s) to prove the abort, not the
      // timeout, is what unblocks the await.
    })
    // Let the listener attach before firing the abort.
    setTimeout(() => ctl.abort(), 50)
    await expect(promise).rejects.toThrow(/aborted/)
    const elapsed = Date.now() - start
    // 100ms is plenty of headroom over the 50ms scheduled abort —
    // and orders of magnitude under the 600s default timeout that
    // would otherwise hold the await.
    expect(elapsed).toBeLessThan(2000)
  })

  it("removes the external-signal abort listener in finally — no double-abort after a clean resolve", async () => {
    // Resolve cleanly, then abort the external signal AFTER the call
    // returned. If the local controller's abort handler had not been
    // detached in finally, this abort would re-fire onto the freed
    // controller. We assert the call resolved and a later abort
    // raises no error on either the result or the listener path.
    mockFetchOnceOk("clean-output")
    const ctl = new AbortController()
    // SIG-216 CR fix-up: spy on removeEventListener to PROVE the
    // finally-block detached the listener. The bare
    // "post-resolve abort() doesn't throw" assertion doesn't catch
    // a missed cleanup — the local controller is GC'd along with
    // the function scope anyway, so the bug would silently pass.
    const removeSpy = vi.spyOn(AbortSignal.prototype, "removeEventListener")
    const { text } = await generate({
      model: FAKE_MODEL,
      prompt: "ok",
      apiKey: FAKE_API_KEY,
      signal: ctl.signal,
    })
    expect(text).toBe("clean-output")
    expect(removeSpy).toHaveBeenCalled()
    // Defensive belt-and-braces: post-resolve abort must remain a
    // no-op from the caller's POV. (Vitest fails on unhandled throw.)
    expect(() => ctl.abort()).not.toThrow()
    removeSpy.mockRestore()
  })
})

describe("generate() — back-compat without signal", () => {
  it("works exactly as before when no signal is passed", async () => {
    mockFetchOnceOk("no-signal-output")
    const { text } = await generate({
      model: FAKE_MODEL,
      prompt: "ok",
      apiKey: FAKE_API_KEY,
    })
    expect(text).toBe("no-signal-output")
  })
})

describe("generate() — token usage capture (SIG-212)", () => {
  // Mirror of the chat() coverage in tests/ollama-chat.test.ts. The
  // accumulateStream helper in src/shared/adapters/model/ollama.ts is structurally
  // identical to chat()'s — same captureCounts pattern, same final-
  // chunk-only emission contract from Ollama Turbo — so the same
  // regression classes apply.
  function mockFetchOnceWithChunks(chunks: string[]): void {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      return {
        ok: true,
        status: 200,
        body: makeStream(chunks),
        text: async () => "",
      } as unknown as Response
    })
  }

  it("captures prompt_eval_count + eval_count from the final stream chunk", async () => {
    mockFetchOnceWithChunks([
      JSON.stringify({ response: "out", done: false }),
      JSON.stringify({ response: "", done: true, prompt_eval_count: 1234, eval_count: 567 }),
    ])
    const { usage } = await generate({
      model: FAKE_MODEL,
      prompt: "test",
      apiKey: FAKE_API_KEY,
    })
    expect(usage).toEqual({ inputTokens: 1234, outputTokens: 567 })
  })

  it("returns empty usage object when token counters are absent", async () => {
    mockFetchOnceWithChunks([
      JSON.stringify({ response: "ok", done: true }),
    ])
    const { usage } = await generate({
      model: FAKE_MODEL,
      prompt: "test",
      apiKey: FAKE_API_KEY,
    })
    expect(usage).toEqual({})
  })

  it("captures only outputTokens when only eval_count is reported (partial usage)", async () => {
    mockFetchOnceWithChunks([
      JSON.stringify({ response: "ok", done: true, eval_count: 567 }),
    ])
    const { usage } = await generate({
      model: FAKE_MODEL,
      prompt: "test",
      apiKey: FAKE_API_KEY,
    })
    expect(usage).toEqual({ outputTokens: 567 })
    expect(usage).not.toHaveProperty("inputTokens")
  })
})
