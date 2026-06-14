import { describe, it, expect, vi, afterEach } from "vitest"
import { chat } from "@/src/shared/adapters/model/openrouter-chat"
import { isPermanentFailure } from "@/src/lib/ensemble/adapters/model-provider-internals"
import type { ChatArgs } from "@/src/shared/ports/model"

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
}

function mockFetch(frames: string[], opts?: { ok?: boolean; status?: number }): ReturnType<typeof vi.fn> {
  const ok = opts?.ok ?? true
  const status = opts?.status ?? 200
  return vi.fn(
    async () => ({ ok, status, body: ok ? sseStream(frames) : null, text: async () => "boom" }) as unknown as Response,
  )
}

const base: ChatArgs = {
  model: "openai/o3",
  apiKey: "k",
  messages: [{ role: "user", content: "hi" }],
  chatEnabled: "on",
}

afterEach(() => vi.unstubAllGlobals())

describe("openrouter-chat", () => {
  it("accumulates content deltas + maps usage, skips heartbeats, honors [DONE]", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
        ": OPENROUTER PROCESSING\n",
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
        "data: [DONE]\n",
      ]),
    )
    const r = await chat({ ...base, format: { type: "object" } })
    expect(r.message.content).toBe("Hello")
    expect(r.usage?.inputTokens).toBe(10)
    expect(r.usage?.outputTokens).toBe(5)
    expect(r.hasToolCalls).toBe(false)
  })

  it("counts thinkingChars from `reasoning` deltas, only when present", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"reasoning":"abcd"}}]}\n',
        'data: {"choices":[{"delta":{"content":"x"}}]}\n',
        "data: [DONE]\n",
      ]),
    )
    const r = await chat({ ...base, format: {} })
    expect(r.thinkingChars).toBe(4)
  })

  it("omits thinkingChars when the model returns no reasoning (o-series may not)", async () => {
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":"x"}}]}\n', "data: [DONE]\n"]))
    const r = await chat({ ...base, format: {} })
    expect(r.thinkingChars).toBeUndefined()
  })

  it("sends response_format + reasoning.effort + stream + max_tokens under `format`", async () => {
    const f = mockFetch(['data: {"choices":[{"delta":{"content":"x"}}]}\n', "data: [DONE]\n"])
    vi.stubGlobal("fetch", f)
    await chat({ ...base, format: { a: 1 }, reasoning: "medium" })
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.response_format.type).toBe("json_schema")
    expect(body.reasoning).toEqual({ effort: "medium" })
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBeGreaterThan(0)
  })

  it("does NOT send reasoning or response_format on a format-less call (mirrors ollama think rule)", async () => {
    const f = mockFetch(['data: {"choices":[{"delta":{"content":"x"}}]}\n', "data: [DONE]\n"])
    vi.stubGlobal("fetch", f)
    await chat({ ...base, reasoning: "high" })
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.reasoning).toBeUndefined()
    expect(body.response_format).toBeUndefined()
  })

  it("reassembles a `data:` frame split across two stream chunks", async () => {
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"con', 'tent":"split"}}]}\n', "data: [DONE]\n"]))
    const r = await chat({ ...base, format: {} })
    expect(r.message.content).toBe("split")
  })

  it("throws when the stream ends without a [DONE] terminator (truncated)", async () => {
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":"partial"}}]}\n']))
    await expect(chat({ ...base, format: {} })).rejects.toThrow(/truncated|DONE/)
  })

  it("the truncation error is classified TRANSIENT (retryable), not permanent", async () => {
    // Load-bearing: the retry layer keys off the message text. A truncated stream must
    // re-run, so its message must NOT match the permanent (HTTP-4xx) classifier.
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":"partial"}}]}\n']))
    const reason = await chat({ ...base, format: {} }).then(
      () => "no-throw",
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    )
    expect(isPermanentFailure(reason, "specialist_did_not_parse")).toBe(false)
  })

  it("throws with the status on an HTTP error", async () => {
    vi.stubGlobal("fetch", mockFetch([], { ok: false, status: 500 }))
    await expect(chat(base)).rejects.toThrow(/HTTP 500/)
  })

  it("throws on a top-level SSE error chunk", async () => {
    vi.stubGlobal("fetch", mockFetch(['data: {"error":{"message":"rate limited"}}\n']))
    await expect(chat(base)).rejects.toThrow(/stream error/)
  })

  it("rejects tool calls on the OpenRouter route", async () => {
    await expect(
      chat({ ...base, tools: [{ type: "function", function: { name: "f", description: "d", parameters: {} } }] }),
    ).rejects.toThrow(/tool/)
  })

  it("throws when chatEnabled is off", async () => {
    await expect(chat({ ...base, chatEnabled: "off" })).rejects.toThrow(/disabled/)
  })
})
