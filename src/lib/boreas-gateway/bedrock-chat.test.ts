// #158 — unit coverage for the AWS Bedrock fallback leg SCAFFOLD (disabled at
// launch; see the file header in bedrock-chat.ts for why). Covers the
// configuration gate, the OpenAI<->Converse translation (pure functions), and
// a full attempt against a stubbed Bedrock endpoint (never a real AWS call).

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  attemptBedrockLeg,
  isBedrockConfigured,
  openAiMessagesToConverse,
  converseResponseToOpenAi,
} from "@/src/lib/boreas-gateway/bedrock-chat"

afterEach(() => {
  vi.unstubAllGlobals()
})

const CREDS = { region: "us-east-1", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "shh-secret-value" }

describe("isBedrockConfigured", () => {
  it("requires region + accessKeyId + secretAccessKey + a model id — ALL of them", () => {
    expect(isBedrockConfigured(CREDS, "anthropic.claude-3")).toBe(true)
    expect(isBedrockConfigured(undefined, "anthropic.claude-3")).toBe(false)
    expect(isBedrockConfigured(CREDS, undefined)).toBe(false)
    expect(isBedrockConfigured({ ...CREDS, region: undefined }, "anthropic.claude-3")).toBe(false)
    expect(isBedrockConfigured({ ...CREDS, accessKeyId: "" }, "anthropic.claude-3")).toBe(false)
  })
})

describe("openAiMessagesToConverse", () => {
  it("separates system messages from user/assistant turns", () => {
    const { system, converseMessages } = openAiMessagesToConverse([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ])
    expect(system).toEqual([{ text: "be terse" }])
    expect(converseMessages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
      { role: "assistant", content: [{ text: "hello" }] },
    ])
  })

  it("folds an unknown role (e.g. 'tool') into 'user' rather than dropping it", () => {
    const { converseMessages } = openAiMessagesToConverse([{ role: "tool", content: "result: 42" }])
    expect(converseMessages).toEqual([{ role: "user", content: [{ text: "result: 42" }] }])
  })

  it("extracts text from an OpenAI content-part array", () => {
    const { converseMessages } = openAiMessagesToConverse([
      {
        role: "user",
        content: [
          { type: "text", text: "part one " },
          { type: "text", text: "part two" },
        ],
      },
    ])
    expect(converseMessages).toEqual([{ role: "user", content: [{ text: "part one part two" }] }])
  })

  it("returns empty arrays for a non-array messages field", () => {
    expect(openAiMessagesToConverse(undefined)).toEqual({ system: [], converseMessages: [] })
  })

  it("merges adjacent same-role turns instead of emitting consecutive same-role messages (Converse requires strict alternation)", () => {
    const { converseMessages } = openAiMessagesToConverse([
      { role: "user", content: "first" },
      { role: "tool", content: "tool result" }, // folds into "user" — adjacent to the turn above
      { role: "assistant", content: "reply" },
    ])
    expect(converseMessages).toEqual([
      { role: "user", content: [{ text: "first\ntool result" }] },
      { role: "assistant", content: [{ text: "reply" }] },
    ])
  })

  it("drops a turn that ends up with empty text after merging (Converse rejects empty content blocks)", () => {
    const { converseMessages } = openAiMessagesToConverse([
      { role: "user", content: "" },
      { role: "assistant", content: "hi" },
    ])
    expect(converseMessages).toEqual([{ role: "assistant", content: [{ text: "hi" }] }])
  })
})

describe("converseResponseToOpenAi", () => {
  it("translates a Converse response into a single OpenAI chat.completion object", () => {
    const got = converseResponseToOpenAi(
      {
        output: { message: { content: [{ text: "hello " }, { text: "world" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      "anthropic.claude-3",
    )
    expect(got.object).toBe("chat.completion")
    expect(got.model).toBe("anthropic.claude-3")
    expect(got.choices).toEqual([
      { index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" },
    ])
    expect(got.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
  })

  it("maps max_tokens to a length finish_reason", () => {
    const got = converseResponseToOpenAi({ output: { message: { content: [] } }, stopReason: "max_tokens" }, "m")
    expect((got.choices as Array<{ finish_reason: string }>)[0]?.finish_reason).toBe("length")
  })
})

describe("attemptBedrockLeg", () => {
  it("signs the request (Authorization header present, no plaintext secret in it) and translates the response", async () => {
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/)
      expect(headers.authorization).not.toContain(CREDS.secretAccessKey)
      return new Response(
        JSON.stringify({ output: { message: { content: [{ text: "hi from bedrock" }] } }, stopReason: "end_turn" }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", f)

    const result = await attemptBedrockLeg(
      { messages: [{ role: "user", content: "hi" }] },
      "anthropic.claude-3",
      CREDS,
      5000,
    )

    expect(result.response.status).toBe(200)
    const body = (await result.response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    expect(body.choices?.[0]?.message?.content).toBe("hi from bedrock")
  })

  it("never throws — a network failure is synthesized into a generic 502 with no credential leak", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("bedrock unreachable")
      }),
    )
    const result = await attemptBedrockLeg({ messages: [] }, "anthropic.claude-3", CREDS, 5000)
    expect(result.response.status).toBe(502)
    const text = await result.response.text()
    expect(text).not.toContain(CREDS.secretAccessKey)
  })

  it("turns a non-2xx Bedrock response into a generic failure without leaking the AWS error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("AccessDeniedException: arn:aws:iam::123456789012:user/x is not authorized", { status: 403 }),
      ),
    )
    const result = await attemptBedrockLeg({ messages: [] }, "anthropic.claude-3", CREDS, 5000)
    expect(result.response.status).toBe(403)
    const text = await result.response.text()
    expect(text).not.toContain("123456789012")
    expect(text).not.toContain("AccessDeniedException")
  })
})
