import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import type { VerifiedChatVideo } from "@/src/lib/chat-image-attachment-route"
import { analyzeChatVideo, ChatVideoAnalysisError } from "./video-model"

const tokenMock = vi.hoisted(() => vi.fn(async () => "vertex-token"))

vi.mock("@/src/lib/boreas-gateway/vertex-token", () => ({
  getVertexAccessToken: tokenMock,
}))

const video: VerifiedChatVideo = {
  id: "11111111-1111-4111-8111-111111111111",
  filename: "walkthrough.mp4",
  mimeType: "video/mp4",
  size: 24,
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-17T11:00:00.000Z",
  installationId: 99,
  bytes: Uint8Array.of(0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d),
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  tokenMock.mockClear()
})

describe("chat video analysis model", () => {
  it("sends verified private bytes to the pinned Vertex model and formats a cited approximate timeline", async () => {
    const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> })
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "A developer opens the repository settings.",
                      timeline: [
                        { approximateStartSeconds: 0, observation: "The settings page is visible." },
                        { approximateStartSeconds: 4.2, observation: "Repository access is selected." },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, totalTokenCount: 150 },
        })
      }),
    )

    const result = await analyzeChatVideo({} as Env, ctx, { question: "What happens?", video })

    expect(tokenMock).toHaveBeenCalledWith(expect.anything(), ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      "https://aiplatform.googleapis.com/v1/projects/sigilix-496118/locations/global/publishers/google/models/gemini-2.5-flash-lite:generateContent",
    )
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer vertex-token")
    expect(JSON.stringify(calls[0]!.body)).toContain("video/mp4")
    expect(JSON.stringify(calls[0]!.body)).toContain("MEDIA_RESOLUTION_LOW")
    expect(result).toMatchObject({
      tokens: 150,
      attachment: { id: video.id, filename: video.filename, mimeType: video.mimeType },
    })
    expect(result.text).toContain(`A developer opens the repository settings. [video:${video.id}]`)
    expect(result.text).toContain(`model-estimated ~00:04 — Repository access is selected. [video:${video.id}]`)
  })

  it("fails closed on quota errors or malformed structured evidence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 })),
    )
    await expect(analyzeChatVideo({} as Env, ctx, { question: "What happens?", video })).rejects.toBeInstanceOf(
      ChatVideoAnalysisError,
    )

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          candidates: [{ content: { parts: [{ text: '{"summary":"ok","timeline":[{"observation":""}]}' }] } }],
          usageMetadata: { totalTokenCount: 10 },
        }),
      ),
    )
    await expect(analyzeChatVideo({} as Env, ctx, { question: "What happens?", video })).rejects.toBeInstanceOf(
      ChatVideoAnalysisError,
    )
  })

  it("rejects empty bytes before minting a token or calling Vertex", async () => {
    await expect(
      analyzeChatVideo({} as Env, ctx, {
        question: "What happens?",
        video: { ...video, size: 0, bytes: new Uint8Array() },
      }),
    ).rejects.toBeInstanceOf(ChatVideoAnalysisError)
    expect(tokenMock).not.toHaveBeenCalled()
  })
})
