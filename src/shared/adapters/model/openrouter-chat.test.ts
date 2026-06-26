import { describe, it, expect, vi, afterEach } from "vitest"
import { chat } from "@/src/shared/adapters/model/openrouter-chat"
import { isPermanentFailure } from "@/src/lib/ensemble/adapters/model-provider-internals"
import { ProviderRateLimitError, isProviderRateLimit } from "@/src/shared/adapters/model/provider-errors"
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

/** Error-response mock that includes a real `headers.get` so rate-limit parsing works. */
function mockFetchError(status: number, retryAfterHeader?: string): ReturnType<typeof vi.fn> {
  return vi.fn(async () => {
    const headersMap = new Map<string, string>()
    if (retryAfterHeader !== undefined) headersMap.set("retry-after", retryAfterHeader)
    return {
      ok: false,
      status,
      headers: { get: (name: string): string | null => headersMap.get(name.toLowerCase()) ?? null },
      text: async () => `${status} error body`,
    } as unknown as Response
  })
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

  it("salvages a complete body when only the [DONE] sentinel was lost (finish_reason:stop present)", async () => {
    // SIG-449 rework: the salvage exists for ONE case — a COMPLETE generation whose only
    // defect is a dropped [DONE] (edge idle-timeout / disconnect AFTER the model finished).
    // finish_reason:"stop" proves completion, so we return the content rather than throwing
    // it away (the pre-rework throw was the dominant "specialist unavailable" cause).
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"},"finish_reason":null}]}\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n',
        // NB: no "data: [DONE]\n" — the sentinel was lost after the model completed.
      ]),
    )
    const r = await chat({ ...base, format: {} })
    expect(r.message.content).toBe('{"ok":true}')
  })

  it("THROWS on a mid-generation cut — content present but NO finish_reason (recall P0 guard)", async () => {
    // The critical guard: a stream cut mid-review (no finish_reason) must NEVER be salvaged.
    // jsonrepair would auto-close the truncated JSON into a structurally-valid 0-finding
    // verdict counted as full coverage — a SILENT false clean review. It must throw →
    // transient → retry (an honest re-roll / degraded-coverage disclosure instead).
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":"partial"}}]}\n']))
    await expect(chat({ ...base, format: {} })).rejects.toThrow(/truncated|DONE/)
  })

  it("a truncated REVIEW (summary present, findings array cut, no finish_reason) never escapes the adapter", async () => {
    // End-to-end recall-safety for the exact danger case: a real review cut right at the
    // `findings` array (the schema emits findings LAST). Without the finish_reason gate,
    // jsonrepair + parsePrReviewResponse would surface this as a 0-finding "clean" sign-off.
    // With the gate, chat() throws so the truncated body never reaches the parser.
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"SQL injection + auth bypass\\",\\"confidence\\":5,\\"findings\\":["},"finish_reason":null}]}\n',
        // stream cut here — no finish_reason:stop, no [DONE].
      ]),
    )
    await expect(chat({ ...base, format: {} })).rejects.toThrow(/truncated|DONE/)
  })

  it("applies the same gate on the FREE-FORM (synth, format:undefined) path — mid-cut throws", async () => {
    // The salvage gate reads choice.finish_reason, not args.format, so it protects the
    // free-form synthesizer call too: a cut synth stream (no finish_reason) must throw
    // rather than salvage a partial summary that could be posted as the merged review.
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":"partial synth"}}]}\n']))
    await expect(chat(base)).rejects.toThrow(/truncated|DONE/)
  })

  it("still throws when the stream ends with NO content to salvage (empty + no completion)", async () => {
    // Chunks arrived but nothing was emitted before the cut — nothing to parse; surface a
    // transient error and let the retry ladder re-run (asserted below).
    vi.stubGlobal("fetch", mockFetch(['data: {"choices":[{"delta":{"content":""}}]}\n']))
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

  it("maps non-streaming tool calls into the shared ChatResult shape", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "file_grep", arguments: '{"query":"removedHelper"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    })) as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal("fetch", f)

    const result = await chat({
      ...base,
      tools: [
        {
          type: "function",
          function: {
            name: "file_grep",
            description: "Search files",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        },
      ],
    })

    expect(result.hasToolCalls).toBe(true)
    expect(result.message.tool_calls?.[0]?.function.name).toBe("file_grep")
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 })
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.stream).toBe(false)
    expect(body.tools).toHaveLength(1)
    expect(body.parallel_tool_calls).toBe(true)
    expect(body.response_format).toBeUndefined()
  })

  it("throws when chatEnabled is off", async () => {
    await expect(chat({ ...base, chatEnabled: "off" })).rejects.toThrow(/disabled/)
  })

  // ─── SIG-417: usage.cost capture ──────────────────────────────────

  it("captures usage.cost from the final stream chunk into costUsd", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.0123}}\n',
        "data: [DONE]\n",
      ]),
    )
    const r = await chat({ ...base, format: {} })
    expect(r.usage?.costUsd).toBe(0.0123)
    expect(r.usage?.inputTokens).toBe(10)
  })

  it("omits costUsd on the stream path when usage.cost is absent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([
        'data: {"choices":[{"delta":{"content":"x"}}]}\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n',
        "data: [DONE]\n",
      ]),
    )
    const r = await chat({ ...base, format: {} })
    expect(r.usage?.costUsd).toBeUndefined()
  })

  it("captures usage.cost from the non-streaming tool completion into costUsd", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }],
        usage: { prompt_tokens: 11, completion_tokens: 3, cost: 0.0044 },
      }),
    })) as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal("fetch", f)
    const result = await chat({
      ...base,
      tools: [{ type: "function", function: { name: "noop", description: "d", parameters: { type: "object" } } }],
    })
    expect(result.usage?.costUsd).toBe(0.0044)
    expect(result.usage?.inputTokens).toBe(11)
  })

  it("omits costUsd on the tool path when usage.cost is absent", async () => {
    const f = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "", tool_calls: [] } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    })) as unknown as ReturnType<typeof vi.fn>
    vi.stubGlobal("fetch", f)
    const result = await chat({
      ...base,
      tools: [{ type: "function", function: { name: "noop", description: "d", parameters: { type: "object" } } }],
    })
    expect(result.usage?.costUsd).toBeUndefined()
  })

  // ─── SIG-455 (PR B Task 2): ProviderRateLimitError on 429/503 ───────────

  it("429 with Retry-After: 5 → throws ProviderRateLimitError with retryAfterMs===5000", async () => {
    vi.stubGlobal("fetch", mockFetchError(429, "5"))
    const err = await chat(base).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isProviderRateLimit(err)).toBe(true)
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(5000)
    expect((err as ProviderRateLimitError).message).toMatch(/OpenRouter HTTP 429/)
  })

  it("503 with no Retry-After header → throws ProviderRateLimitError with retryAfterMs===20000 (default)", async () => {
    vi.stubGlobal("fetch", mockFetchError(503))
    const err = await chat(base).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isProviderRateLimit(err)).toBe(true)
    expect((err as ProviderRateLimitError).retryAfterMs).toBe(20_000)
    expect((err as ProviderRateLimitError).message).toMatch(/OpenRouter HTTP 503/)
  })

  it("500 → plain Error (NOT ProviderRateLimitError), message still OpenRouter HTTP 500", async () => {
    vi.stubGlobal("fetch", mockFetchError(500))
    const err = await chat(base).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(isProviderRateLimit(err)).toBe(false)
    expect((err as Error).message).toMatch(/OpenRouter HTTP 500/)
  })
})
