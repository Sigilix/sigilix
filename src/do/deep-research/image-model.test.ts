import { afterEach, describe, expect, it, vi } from "vitest"
import { analyzeChatImages, ChatImageAnalysisError } from "./image-model"
import type { VerifiedChatImage } from "@/src/lib/chat-image-attachment-route"
import type { Env } from "@/src/shared/types/env"

const image: VerifiedChatImage = {
  id: "11111111-1111-4111-8111-111111111111",
  filename: "architecture.png",
  mimeType: "image/png",
  size: 8,
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-17T11:00:00.000Z",
  bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("chat image analysis model", () => {
  it("sends verified bytes with exact citation metadata and returns provider usage", async () => {
    const calls: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return Response.json({
          choices: [{ message: { content: `A component diagram [attachment:${image.id}].` } }],
          usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.004 },
        })
      }),
    )

    const result = await analyzeChatImages({ OPENROUTER_API_KEY: "key" } as Env, {
      question: "What is shown?",
      images: [image],
    })

    expect(result).toMatchObject({
      text: `A component diagram [attachment:${image.id}].`,
      tokens: 25,
      costUsd: 0.004,
      attachments: [{ id: image.id, filename: "architecture.png", mimeType: "image/png", size: 8 }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.model).toBe("google/gemini-3.5-flash")
    const messages = calls[0]?.messages as Array<{ role: string; content: unknown }>
    const parts = messages[1]?.content as Array<Record<string, unknown>>
    expect(parts[0]?.text).toContain(`[attachment:${image.id}]`)
    expect(parts[1]).toEqual({
      type: "image_url",
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    })
  })

  it("uses the ordered fallback and fails honestly when every image model rejects", async () => {
    let calls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1
        if (calls === 1) return Response.json({ error: { message: "unavailable" } }, { status: 503 })
        return Response.json({
          choices: [{ message: { content: `Visible layout [attachment:${image.id}].` } }],
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        })
      }),
    )
    const result = await analyzeChatImages(
      {
        OPENROUTER_API_KEY: "key",
        SIGILIX_RESEARCH_IMAGE_MODELS: "model/first, model/second",
      } as Env,
      { question: "Describe it", images: [image] },
    )
    expect(calls).toBe(2)
    expect(result.tokens).toBe(5)

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "down" }, { status: 503 })),
    )
    await expect(
      analyzeChatImages({ OPENROUTER_API_KEY: "key", SIGILIX_RESEARCH_IMAGE_MODELS: "one,two" } as Env, {
        question: "Describe it",
        images: [image],
      }),
    ).rejects.toBeInstanceOf(ChatImageAnalysisError)
  })
})
