import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ChatDisabledError,
  chat,
  isChatDisabledError,
} from "../src/shared/adapters/model/ollama-chat"

const FAKE_API_KEY = "test-key"
const FAKE_MODEL = "glm-5.1:cloud"

function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  // NDJSON: each chunk is a line (newline-terminated).
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

function mockFetchOnce(stream: ReadableStream<Uint8Array> | null, opts: { ok?: boolean; status?: number; text?: string } = {}): void {
  const ok = opts.ok ?? true
  const status = opts.status ?? 200
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    return {
      ok,
      status,
      body: stream,
      text: async () => opts.text ?? "",
    } as unknown as Response
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ChatDisabledError + isChatDisabledError", () => {
  it("isChatDisabledError matches its own class", () => {
    const e = new ChatDisabledError()
    expect(isChatDisabledError(e)).toBe(true)
  })

  it("isChatDisabledError rejects unrelated errors", () => {
    expect(isChatDisabledError(new Error("boom"))).toBe(false)
    expect(isChatDisabledError("string")).toBe(false)
    expect(isChatDisabledError(null)).toBe(false)
  })
})

describe("chat() — kill switch", () => {
  it("throws ChatDisabledError synchronously when chatEnabled='off' (no network call)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await expect(
      chat({ model: FAKE_MODEL, apiKey: FAKE_API_KEY, messages: [], chatEnabled: "off" })
    ).rejects.toBeInstanceOf(ChatDisabledError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("proceeds normally when chatEnabled='on'", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "hi" }, done: true }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "say hi" }],
      chatEnabled: "on",
    })
    expect(result.message.content).toBe("hi")
  })

  it("proceeds when chatEnabled is undefined (default = enabled)", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "go" }],
    })
    expect(result.message.content).toBe("ok")
  })
})

describe("chat() — SIG-287 think:false on schema-constrained calls", () => {
  // Capture the request init directly inside the one-shot mock — re-spying
  // `fetch` via a helper would detach a separately-created spy from the call.
  function mockCaptureOnce(captured: { body?: Record<string, unknown> }): void {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      captured.body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
      return {
        ok: true,
        status: 200,
        body: makeStream([JSON.stringify({ message: { role: "assistant", content: "{}" }, done: true })]),
        text: async () => "",
      } as unknown as Response
    })
  }

  it("sets think:false (disables the reasoning phase) when a format is passed", async () => {
    const captured: { body?: Record<string, unknown> } = {}
    mockCaptureOnce(captured)
    await chat({
      model: "deepseek-v4-flash:cloud",
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "review" }],
      chatEnabled: "on",
      format: { type: "object" },
    })
    expect(captured.body?.think).toBe(false)
  })

  it("omits think on free-form (no format) calls — those keep the model's default thinking", async () => {
    const captured: { body?: Record<string, unknown> } = {}
    mockCaptureOnce(captured)
    await chat({
      model: "deepseek-v4-flash:cloud",
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "chat" }],
      chatEnabled: "on",
    })
    expect("think" in (captured.body ?? {})).toBe(false)
  })
})

describe("chat() — content accumulation (delta)", () => {
  it("concatenates content across multiple chunks", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: ", " }, done: false }),
        JSON.stringify({ message: { role: "assistant", content: "world!" }, done: true }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "greet" }],
    })
    expect(result.message.content).toBe("Hello, world!")
    expect(result.hasToolCalls).toBe(false)
    expect(result.message.tool_calls).toBeUndefined()
  })

  it("returns hasToolCalls=false on content-only response", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "answer" }, done: true }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    expect(result.hasToolCalls).toBe(false)
  })
})

describe("chat() — tool_calls accumulation (snapshot, NOT delta)", () => {
  it("uses the LAST chunk's tool_calls as the truth (replace, don't append)", async () => {
    // Three chunks each carrying a complete snapshot. The last snapshot
    // is the only one we keep — appending would produce 6 calls.
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_partial_1", function: { name: "fetch_pr", arguments: '{"owner":"a"' } },
            ],
          },
          done: false,
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_partial_2", function: { name: "fetch_pr", arguments: '{"owner":"a","repo":"b"' } },
              { id: "call_partial_3", function: { name: "retrieve_codebase", arguments: '{"query":"x"}' } },
            ],
          },
          done: false,
        }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "final_1", function: { name: "fetch_pr", arguments: '{"owner":"a","repo":"b","number":1}' } },
              { id: "final_2", function: { name: "retrieve_codebase", arguments: '{"query":"clampRange","repo":"x"}' } },
            ],
          },
          done: true,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "do it" }],
      tools: [
        { type: "function", function: { name: "fetch_pr", description: "", parameters: {} } },
      ],
    })
    expect(result.hasToolCalls).toBe(true)
    expect(result.message.tool_calls).toHaveLength(2)
    expect(result.message.tool_calls?.[0]?.id).toBe("final_1")
    expect(result.message.tool_calls?.[1]?.id).toBe("final_2")
  })

  it("preserves arguments as a STRING when Ollama returns it as JSON string", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", function: { name: "fetch_pr", arguments: '{"owner":"a","repo":"b","number":1}' } },
            ],
          },
          done: true,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    expect(typeof result.message.tool_calls?.[0]?.function.arguments).toBe("string")
  })

  it("preserves arguments as an OBJECT when Ollama returns it as object", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", function: { name: "fetch_pr", arguments: { owner: "a", repo: "b", number: 1 } } },
            ],
          },
          done: true,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    expect(typeof result.message.tool_calls?.[0]?.function.arguments).toBe("object")
    expect(result.message.tool_calls?.[0]?.function.arguments).toEqual({ owner: "a", repo: "b", number: 1 })
  })

  it("does NOT throw on malformed JSON in arguments — passes raw to caller", async () => {
    // Codex round-5: chat() must NOT parse/validate. The agent loop's
    // parseToolArguments handles parse failures via the bad-args retry path.
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", function: { name: "fetch_pr", arguments: "{not valid json" } },
            ],
          },
          done: true,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    // Should reach here without throwing; arguments is the raw bad string.
    expect(result.message.tool_calls?.[0]?.function.arguments).toBe("{not valid json")
  })

  it("hasToolCalls=true with tool_calls present, false on empty/missing array", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: { role: "assistant", content: "", tool_calls: [] },
          done: true,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    // Empty tool_calls array unambiguously means final-answer (Codex round-3).
    expect(result.hasToolCalls).toBe(false)
  })
})

describe("chat() — error chunks throw", () => {
  it("throws when an upstream chunk has an `error` field", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false }),
        JSON.stringify({ error: "model crashed" }),
      ])
    )
    await expect(
      chat({ model: FAKE_MODEL, apiKey: FAKE_API_KEY, messages: [] })
    ).rejects.toThrow(/Ollama stream error: model crashed/)
  })

  it("throws on HTTP non-2xx with status code in message", async () => {
    mockFetchOnce(null, { ok: false, status: 503, text: "service unavailable" })
    await expect(
      chat({ model: FAKE_MODEL, apiKey: FAKE_API_KEY, messages: [] })
    ).rejects.toThrow(/Ollama HTTP 503/)
  })
})

describe("chat() — timeout + signal", () => {
  it("times out after timeoutMs (internal AbortController)", async () => {
    // Mock fetch as never-resolving to force the timeout to fire.
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted") as Error & { name: string }
          err.name = "AbortError"
          reject(err)
        })
      })
    })
    await expect(
      chat({
        model: FAKE_MODEL,
        apiKey: FAKE_API_KEY,
        messages: [],
        timeoutMs: 50,
      })
    ).rejects.toThrow(/aborted/)
  })

  it("respects external signal — fetch sees abort when external fires", async () => {
    let observedSignal: AbortSignal | undefined
    vi.spyOn(globalThis, "fetch").mockImplementationOnce((_url, init) => {
      observedSignal = (init as RequestInit | undefined)?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        observedSignal?.addEventListener("abort", () => {
          const err = new Error("aborted") as Error & { name: string }
          err.name = "AbortError"
          reject(err)
        })
      })
    })
    const externalCtrl = new AbortController()
    const promise = chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
      signal: externalCtrl.signal,
      timeoutMs: 60_000,
    })
    // Give the fetch a moment to set up the signal listener.
    await new Promise((r) => setTimeout(r, 10))
    externalCtrl.abort()
    await expect(promise).rejects.toThrow(/aborted/)
  })
})

describe("chat() — request shape", () => {
  it("includes tools array when tools provided", async () => {
    let captured: Record<string, unknown> | null = null
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      captured = JSON.parse(((init as RequestInit | undefined)?.body as string) ?? "{}")
      return {
        ok: true,
        status: 200,
        body: makeStream([
          JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }),
        ]),
        text: async () => "",
      } as unknown as Response
    })
    await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "fetch_pr", description: "Get a PR", parameters: { type: "object" } } },
      ],
    })
    expect(captured).not.toBeNull()
    const c = captured as Record<string, unknown>
    expect(c.tools).toEqual([
      { type: "function", function: { name: "fetch_pr", description: "Get a PR", parameters: { type: "object" } } },
    ])
    expect(c.stream).toBe(true)
  })

  it("OMITS tools field entirely when tools is empty array (forced final-answer turn shape)", async () => {
    let captured: Record<string, unknown> | null = null
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (_url, init) => {
      captured = JSON.parse(((init as RequestInit | undefined)?.body as string) ?? "{}")
      return {
        ok: true,
        status: 200,
        body: makeStream([
          JSON.stringify({ message: { role: "assistant", content: "final" }, done: true }),
        ]),
        text: async () => "",
      } as unknown as Response
    })
    await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
      tools: [],
      format: { type: "object", properties: { answer: { type: "string" } } },
    })
    const c = captured as Record<string, unknown>
    expect(c.tools).toBeUndefined()
    expect(c.format).toEqual({ type: "object", properties: { answer: { type: "string" } } })
  })

  it("uses temperature 0 when format is set, 0.2 otherwise", async () => {
    let captured: Record<string, unknown> = {}
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      captured = JSON.parse(((init as RequestInit | undefined)?.body as string) ?? "{}")
      return {
        ok: true,
        status: 200,
        body: makeStream([
          JSON.stringify({ message: { role: "assistant", content: "x" }, done: true }),
        ]),
        text: async () => "",
      } as unknown as Response
    })
    await chat({ model: FAKE_MODEL, apiKey: FAKE_API_KEY, messages: [] })
    expect((captured.options as { temperature: number }).temperature).toBe(0.2)
    await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
      format: { type: "object" },
    })
    expect((captured.options as { temperature: number }).temperature).toBe(0)
  })
})

describe("chat() — token usage capture (SIG-212)", () => {
  // The capture path: Ollama emits `prompt_eval_count` + `eval_count` on
  // the final `done: true` chunk; accumulateStream translates those into
  // ChatResult.usage.{inputTokens, outputTokens}. Without these tests, a
  // field-rename in the Ollama API or a regression in captureCounts
  // silently zeros downstream token data while every other test passes.
  it("captures prompt_eval_count + eval_count from the final stream chunk", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "hi" }, done: false }),
        JSON.stringify({
          message: { role: "assistant", content: "" },
          done: true,
          prompt_eval_count: 1234,
          eval_count: 567,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [{ role: "user", content: "test" }],
    })
    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 567 })
  })

  it("returns empty usage object when token counters are absent (non-Ollama / degenerate response)", async () => {
    mockFetchOnce(
      makeStream([
        JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    // Empty object, NOT undefined and NOT zero-filled. Downstream
    // aggregators distinguish "absent" (no provider data) from a real
    // zero count.
    expect(result.usage).toEqual({})
  })

  it("captures only inputTokens when only prompt_eval_count is reported (partial usage)", async () => {
    // Defensive: Ollama could report one counter but not the other on a
    // degenerate response. The shape must omit the missing field rather
    // than zero-fill, per LlmUsage semantics.
    mockFetchOnce(
      makeStream([
        JSON.stringify({
          message: { role: "assistant", content: "ok" },
          done: true,
          prompt_eval_count: 1234,
        }),
      ])
    )
    const result = await chat({
      model: FAKE_MODEL,
      apiKey: FAKE_API_KEY,
      messages: [],
    })
    expect(result.usage).toEqual({ inputTokens: 1234 })
    expect(result.usage).not.toHaveProperty("outputTokens")
  })
})
