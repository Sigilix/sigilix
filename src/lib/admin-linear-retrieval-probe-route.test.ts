import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockRetrieveChunks } = vi.hoisted(() => ({ mockRetrieveChunks: vi.fn() }))

vi.mock("@/src/lib/retrieval", async () => {
  const actual = await vi.importActual<typeof import("@/src/lib/retrieval")>("@/src/lib/retrieval")
  return {
    ...actual,
    retrieveChunks: mockRetrieveChunks,
  }
})

import { handleAdminLinearRetrievalProbeRoute } from "@/src/lib/admin-linear-retrieval-probe-route"
import type { Env } from "@/src/shared/types/env"

const TOKEN = "admin-token"

type Page = { keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }

function manifest(owner: string, repo: string): string {
  return JSON.stringify({
    v: 1,
    owner,
    repo,
    headSha: "abc123",
    runId: "run-1",
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-06-14T00:00:00.000Z",
    modelId: "m",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
  })
}

function makeEnv(keys: Record<string, string> = {}): Env {
  return {
    OPENCLAW_ADMIN_TOKEN: TOKEN,
    OPENCLAW_TEAM_GITHUB_REPO_MAP: JSON.stringify({
      SIG: { owner: "Sigilix", repo: "sigilix" },
    }),
    OPENCLAW_STATE: {
      list: async (opts: { prefix?: string }): Promise<Page> => {
        const prefix = opts.prefix ?? ""
        return {
          keys: Object.keys(keys)
            .filter((name) => name.startsWith(prefix))
            .map((name) => ({ name })),
          list_complete: true,
        }
      },
      get: async (key: string): Promise<string | null> => keys[key] ?? null,
    } as unknown as KVNamespace,
    OPENCLAW_CODE_INDEX: {} as VectorizeIndex,
  } as Env
}

function post(body: unknown, auth = `Bearer ${TOKEN}`): Request {
  return new Request("https://x/admin/linear-retrieval-probe", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mockRetrieveChunks.mockReset()
})

describe("handleAdminLinearRetrievalProbeRoute", () => {
  it("401 on missing or wrong bearer", async () => {
    const env = makeEnv()
    expect((await handleAdminLinearRetrievalProbeRoute(post({ teamKey: "SIG" }, ""), env)).status).toBe(401)
    expect((await handleAdminLinearRetrievalProbeRoute(post({ teamKey: "SIG" }, "Bearer nope"), env)).status).toBe(401)
  })

  it("uses the retrieve_codebase tool path and returns proof fields for an indexed mapped team", async () => {
    mockRetrieveChunks.mockResolvedValue([
      {
        path: "src/lib/mention-reply.ts",
        lineStart: 1,
        lineEnd: 12,
        score: 0.93,
        content: "export async function handleMention() {}",
      },
    ])
    const env = makeEnv({ "repo-index-manifest:sigilix/sigilix": manifest("Sigilix", "sigilix") })

    const res = await handleAdminLinearRetrievalProbeRoute(
      post({
        teamKey: "SIG",
        issueTitle: "Linear mention retrieval",
        question: "Where is handleMention implemented?",
      }),
      env,
    )

    expect(res.status).toBe(200)
    expect(mockRetrieveChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        teamKey: "sigilix/sigilix",
        text: "Linear mention retrieval\n\nWhere is handleMention implemented?",
        env,
      }),
    )
    await expect(res.json()).resolves.toMatchObject({
      availableRepos: ["sigilix/sigilix"],
      mappedRepo: "sigilix/sigilix",
      repoStatus: "mapped_indexed",
      calledRetrieveCodebase: true,
      retrievalNamespace: "sigilix/sigilix",
      chunkCount: 1,
      reason: "retrieval_succeeded",
    })
  })

  it("distinguishes a mapped-but-not-indexed team without calling retrieval", async () => {
    const res = await handleAdminLinearRetrievalProbeRoute(
      post({
        teamKey: "SIG",
        issueTitle: "Linear mention retrieval",
        question: "Where is handleMention implemented?",
      }),
      makeEnv(),
    )

    expect(res.status).toBe(200)
    expect(mockRetrieveChunks).not.toHaveBeenCalled()
    await expect(res.json()).resolves.toMatchObject({
      availableRepos: [],
      mappedRepo: "sigilix/sigilix",
      repoStatus: "mapped_not_indexed",
      calledRetrieveCodebase: false,
      retrievalNamespace: null,
      chunkCount: 0,
      reason: "mapped_repo_not_indexed",
    })
  })
})
