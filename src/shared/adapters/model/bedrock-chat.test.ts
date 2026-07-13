// Bedrock-ensemble migration — the Bedrock Converse adapter's contract tests:
// routing (registry-based id detection), the packed credential envelope, the
// request translation (system extraction, schema instruction, tool mapping,
// alternating-turn merging), SigV4 signing on the wire, the response mapping —
// and above all the COST computation (Bedrock reports no `usage.cost`; a $0
// here would flow into `usage_ledger.cost_usd` and silently disarm the
// SIGILIX_RATE_LIMIT_MODE=enforce gate, so the non-zero cases are pinned to
// exact arithmetic).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  chat as bedrockChat,
  bedrockConverseUrl,
  chatMessagesToConverse,
  packBedrockApiKey,
  unpackBedrockApiKey,
} from "./bedrock-chat"
import { chat as routedChat, isBedrockModel } from "./index"
import { isProviderRateLimit } from "./provider-errors"
import { isPermanentFailure } from "@/src/lib/ensemble/adapters/model-provider-internals"
import { MODEL_PRICING } from "@/src/shared/domain/model-pricing"
import type { ChatMessage } from "@/src/shared/ports/model"

const CREDS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret/Example+Key", region: "us-east-1" }
const PACKED = packBedrockApiKey(CREDS)

function converseOk(overrides?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      output: { message: { role: "assistant", content: [{ text: "hello" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 1_000_000, outputTokens: 500_000, totalTokens: 1_500_000 },
      ...overrides,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const baseArgs = {
  apiKey: PACKED,
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ] as ChatMessage[],
  chatEnabled: "on" as const,
}

describe("isBedrockModel — the vendor/geo registry", () => {
  it("matches the migrated lineup + the logic candidates (incl. the us. inference profile)", () => {
    for (const id of [
      "deepseek.v3.2",
      "zai.glm-5",
      "nvidia.nemotron-super-3-120b",
      "us.anthropic.claude-sonnet-5",
      "mistral.mistral-large-3-675b-instruct",
      "anthropic.claude-3-5-sonnet-20240620-v1:0", // ":"-versioned base id
    ]) {
      expect(isBedrockModel(id), id).toBe(true)
    }
  })
  it("never matches OpenRouter ids or Ollama tags — dots and colons alone don't discriminate", () => {
    for (const id of [
      "deepseek/deepseek-v4-flash", // OpenRouter slash id
      "z-ai/glm-5.1", // OpenRouter id WITH a dot
      "glm-5.1:cloud", // Ollama tag WITH a dot before the colon
      "deepseek-v4-pro:cloud", // Ollama tag
      "llama3.2:3b", // Ollama tag with dots
      "nomic-embed-text", // bare tag, no dot
    ]) {
      expect(isBedrockModel(id), id).toBe(false)
    }
  })
})

describe("packed credential envelope", () => {
  it("round-trips", () => {
    expect(unpackBedrockApiKey(PACKED)).toEqual(CREDS)
  })
  it("rejects a non-envelope key with a permanent (HTTP-400-worded) error that never echoes the input", () => {
    for (const bad of ["sk-or-v1-realkey", "{}", JSON.stringify({ v: 2, ...CREDS })]) {
      let message = ""
      try {
        unpackBedrockApiKey(bad)
      } catch (e) {
        message = e instanceof Error ? e.message : String(e)
      }
      expect(message).toContain("Bedrock HTTP 400")
      expect(message).not.toContain("realkey")
      expect(isPermanentFailure(message, "parse_label")).toBe(true)
    }
  })
})

describe("chatMessagesToConverse — request translation", () => {
  it("extracts system, folds tool replies into user toolResult blocks, and merges adjacent same-role turns", () => {
    const { system, converseMessages } = chatMessagesToConverse([
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "user", content: "q2" }, // adjacent same-role → merged into one turn
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "read", arguments: '{"p":1}' } }] },
      { role: "tool", content: "result", tool_call_id: "t1" },
    ])
    expect(system).toEqual([{ text: "sys" }])
    expect(converseMessages).toEqual([
      { role: "user", content: [{ text: "q1" }, { text: "q2" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "read", input: { p: 1 } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ text: "result" }] } }] },
    ])
  })
  it("pairs SYNTHETIC ids when the provider omitted both call.id and tool_call_id (Converse rejects unpaired results)", () => {
    const { converseMessages } = chatMessagesToConverse([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "a", arguments: {} } }, { function: { name: "b", arguments: {} } }],
      },
      { role: "tool", content: "ra" }, // pairs with a's synthetic id, by ordering
      { role: "tool", content: "rb" },
    ])
    const assistant = converseMessages[1]!
    const results = converseMessages[2]!
    const useIds = assistant.content.map((b) => ("toolUse" in b ? b.toolUse.toolUseId : "?"))
    const resultIds = results.content.map((b) => ("toolResult" in b ? b.toolResult.toolUseId : "?"))
    expect(resultIds).toEqual(useIds)
  })
})

describe("bedrock chat — the wire call", () => {
  it("signs with SigV4 and POSTs the Converse body to the region's runtime host", async () => {
    mockFetch.mockResolvedValue(converseOk())
    await bedrockChat({ model: "deepseek.v3.2", ...baseArgs })
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]! as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/deepseek.v3.2/converse")
    expect(init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//)
    expect(init.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/)
    const body = JSON.parse(init.body) as { system: Array<{ text: string }>; messages: unknown[] }
    expect(body.system[0]).toEqual({ text: "sys" })
    expect(body.messages).toEqual([{ role: "user", content: [{ text: "hi" }] }])
  })

  it("URI-encodes inference-profile ids in the path", () => {
    expect(bedrockConverseUrl("us-east-1", "anthropic.claude-3-5-sonnet-v1:0")).toContain(
      "/model/anthropic.claude-3-5-sonnet-v1%3A0/converse",
    )
  })

  it("injects the JSON-Schema instruction as a system block on format calls", async () => {
    mockFetch.mockResolvedValue(converseOk())
    await bedrockChat({ model: "deepseek.v3.2", ...baseArgs, format: { type: "object" } })
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as {
      system: Array<{ text: string }>
    }
    expect(body.system).toHaveLength(2)
    expect(body.system[1]!.text).toContain("SINGLE JSON object")
    expect(body.system[1]!.text).toContain('{"type":"object"}')
  })

  it("embeds a SANITIZED schema (integer min/max stripped) ONLY for an Anthropic Bedrock id", async () => {
    mockFetch.mockResolvedValue(converseOk())
    const schema = {
      type: "object",
      properties: { score: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["score"],
    }
    await bedrockChat({ model: "us.anthropic.claude-sonnet-5", ...baseArgs, format: schema })
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as {
      system: Array<{ text: string }>
    }
    const instruction = body.system[1]!.text
    expect(instruction).not.toContain('"minimum"')
    expect(instruction).not.toContain('"maximum"')
    expect(instruction).toContain('{"type":"object","properties":{"score":{"type":"integer"}},"required":["score"]}')
  })

  it("embeds the ORIGINAL schema unchanged for a non-Anthropic Bedrock id (not sanitized)", async () => {
    mockFetch.mockResolvedValue(converseOk())
    const schema = {
      type: "object",
      properties: { score: { type: "integer", minimum: 1, maximum: 5 } },
      required: ["score"],
    }
    await bedrockChat({ model: "deepseek.v3.2", ...baseArgs, format: schema })
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as {
      system: Array<{ text: string }>
    }
    expect(body.system[1]!.text).toContain(JSON.stringify(schema))
  })

  it("maps tools to Converse toolConfig and returned toolUse blocks to tool_calls", async () => {
    mockFetch.mockResolvedValue(
      converseOk({
        output: { message: { content: [{ toolUse: { toolUseId: "t9", name: "grep", input: { q: "x" } } }] } },
        stopReason: "tool_use",
      }),
    )
    const res = await bedrockChat({
      model: "deepseek.v3.2",
      ...baseArgs,
      tools: [{ type: "function", function: { name: "grep", description: "d", parameters: { type: "object" } } }],
    })
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body) as {
      toolConfig: { tools: Array<{ toolSpec: { name: string; inputSchema: { json: unknown } } }> }
    }
    expect(body.toolConfig.tools[0]!.toolSpec.name).toBe("grep")
    expect(res.hasToolCalls).toBe(true)
    expect(res.message.tool_calls).toEqual([{ id: "t9", function: { name: "grep", arguments: { q: "x" } } }])
  })

  it("computes a NON-ZERO costUsd from the pricing table (Bedrock reports no cost) — exact arithmetic", async () => {
    mockFetch.mockResolvedValue(converseOk()) // 1M in / 0.5M out
    const res = await bedrockChat({ model: "deepseek.v3.2", ...baseArgs })
    const price = MODEL_PRICING["deepseek.v3.2"]!
    // 1M input tokens × $0.62/MTok + 0.5M output × $1.85/MTok = $1.545
    const expected = 1 * price.inputPerMTokUsd + 0.5 * price.outputPerMTokUsd
    expect(res.usage?.inputTokens).toBe(1_000_000)
    expect(res.usage?.outputTokens).toBe(500_000)
    expect(res.usage?.costUsd).toBeCloseTo(expected, 10)
    expect(res.usage?.costUsd).toBeGreaterThan(0)
  })

  it("OMITS costUsd (never zero-fills) when Bedrock reported no token counts", async () => {
    mockFetch.mockResolvedValue(converseOk({ usage: {} }))
    const res = await bedrockChat({ model: "deepseek.v3.2", ...baseArgs })
    expect(res.usage?.costUsd).toBeUndefined()
  })

  it("throws ProviderRateLimitError on 429 with the Retry-After delay", async () => {
    mockFetch.mockResolvedValue(new Response("throttled", { status: 429, headers: { "retry-after": "7" } }))
    const err = await bedrockChat({ model: "deepseek.v3.2", ...baseArgs }).catch((e: unknown) => e)
    expect(isProviderRateLimit(err)).toBe(true)
    if (isProviderRateLimit(err)) {
      expect(err.retryAfterMs).toBe(7_000)
      expect(err.message).toContain("Bedrock HTTP 429")
    }
  })

  it("wraps 403 as `Bedrock HTTP 403` — classified PERMANENT by the shared taxonomy", async () => {
    mockFetch.mockResolvedValue(new Response("AccessDenied", { status: 403 }))
    const err = await bedrockChat({ model: "us.anthropic.claude-sonnet-5", ...baseArgs }).catch((e: unknown) => e)
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toContain("Bedrock HTTP 403")
    expect(isPermanentFailure(message, "parse_label")).toBe(true)
  })

  it("throws (transient wording, no HTTP token) on a max_tokens stop instead of salvaging a truncated verdict", async () => {
    mockFetch.mockResolvedValue(converseOk({ stopReason: "max_tokens" }))
    const err = await bedrockChat({ model: "deepseek.v3.2", ...baseArgs }).catch((e: unknown) => e)
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toContain("maxTokens")
    expect(isPermanentFailure(message, "parse_label")).toBe(false)
  })

  it("honors the chatEnabled kill-switch BEFORE any network call", async () => {
    await expect(bedrockChat({ model: "deepseek.v3.2", ...baseArgs, chatEnabled: "off" })).rejects.toThrow(
      /chat disabled/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("the barrel router dispatches a Bedrock id to this adapter (and never to OpenRouter/Ollama hosts)", async () => {
    mockFetch.mockResolvedValue(converseOk())
    await routedChat({ model: "zai.glm-5", ...baseArgs })
    expect(String(mockFetch.mock.calls[0]![0])).toContain("bedrock-runtime.us-east-1.amazonaws.com")
  })
})
