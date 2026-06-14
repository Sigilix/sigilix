import { describe, expect, it, vi } from "vitest"
import { makeKvTelemetrySink } from "@/src/lib/agent-telemetry-kv"
import type { AgentLoopTelemetryRecordInput } from "@/src/lib/agent-loop"

describe("makeKvTelemetrySink", () => {
  it("persists Linear retrieval proof fields for production smoke debugging", async () => {
    let storedValue: string | null = null
    const kv = {
      put: vi.fn(async (_key: string, value: string) => {
        storedValue = value
      }),
    } as unknown as KVNamespace

    await makeKvTelemetrySink(kv).record({
      schemaVersion: 2,
      model: "glm-5.1:cloud",
      surface: "linear-mention",
      commentId: "comment-1",
      agentInitialUserMessage: "[INDEXED REPOS] 'sigilix/sigilix'",
      singleShotPrompt: "single shot",
      singleShotSchema: { type: "object" },
      promptBuilderVersion: "linear-mention-reply-v7",
      promptBuilderSource: "source",
      turns: 1,
      toolCalls: [
        {
          name: "retrieve_codebase",
          ok: true,
          elapsedMs: 12,
          argsHash: "abc",
          result: { ok: true, repo: "sigilix/sigilix", count: 2 },
        },
      ],
      totalMs: 25,
      finalAnswer: { answer: "found", confidence: 5, abstain: false },
      linearMentionRetrieval: {
        availableRepos: ["sigilix/sigilix"],
        mappedRepo: "sigilix/sigilix",
        repoStatus: "mapped_indexed",
        initialRetrievalNamespace: "sigilix/sigilix",
        initialChunkCount: 1,
        calledRetrieveCodebase: true,
        retrieveCodebaseCallCount: 1,
        retrievalNamespace: "sigilix/sigilix",
        chunkCount: 2,
        toolRetrievals: [{ ok: true, repo: "sigilix/sigilix", count: 2 }],
      },
    } as AgentLoopTelemetryRecordInput)

    expect(kv.put).toHaveBeenCalledOnce()
    const stored = JSON.parse(storedValue ?? "{}") as {
      linearMentionRetrieval?: {
        availableRepos: string[]
        mappedRepo: string
        repoStatus: string
        calledRetrieveCodebase: boolean
        retrievalNamespace: string
        chunkCount: number
      }
    }
    expect(stored.linearMentionRetrieval).toMatchObject({
      availableRepos: ["sigilix/sigilix"],
      mappedRepo: "sigilix/sigilix",
      repoStatus: "mapped_indexed",
      calledRetrieveCodebase: true,
      retrievalNamespace: "sigilix/sigilix",
      chunkCount: 2,
    })
  })
})
