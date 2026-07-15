import { describe, expect, it, vi } from "vitest"
import { chunkId } from "@/src/lib/indexer-internals"
import { repoTenantKey, type RepoIndexManifestV1 } from "@/src/lib/repo-index-manifest"
import {
  createSlackCodeCitationSession,
  extractSlackCodeCitationSelections,
  parseSlackCodeCitationMode,
  SLACK_CODE_CITATION_SCHEMA,
  SLACK_CODE_CITATION_REVALIDATION_FAILED,
  type SlackCodeCitation,
} from "@/src/lib/slack/slack-code-citations"
import type { SlackScope } from "@/src/lib/slack/slack-scope"
import type { RetrievedChunk } from "@/src/lib/retrieval"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)
const RUN_A = "1".repeat(16)
const RUN_B = "2".repeat(16)
const CONTENT = ["export function authorize() {", "  return true", "}"].join("\n")

interface FakeClient {
  getRepository: ReturnType<typeof vi.fn>
  getFileContent: ReturnType<typeof vi.fn>
}

function scope(): SlackScope {
  return {
    teamId: "T1",
    channelId: "C1",
    installationId: 42,
    repos: [
      { githubRepoId: 101, owner: "Acme", repo: "Api" },
      { githubRepoId: 102, owner: "Acme", repo: "Web" },
    ],
    linearTeam: null,
  }
}

function manifest(args: {
  githubRepoId: number
  repo: string
  headSha: string
  runId: string
  path: string
  chunkId: string
  builtMode?: "shadow" | "on"
}): RepoIndexManifestV1 {
  return {
    v: 1,
    owner: "Acme",
    repo: args.repo.toLowerCase(),
    namespace: `acme/${args.repo.toLowerCase()}`,
    githubRepoId: args.githubRepoId,
    defaultBranch: "main",
    headSha: args.headSha,
    runId: args.runId,
    fileCount: 1,
    chunkCount: 1,
    shardCount: 1,
    indexedAt: "2026-07-14T00:00:00.000Z",
    modelId: "bge-base-en-v1.5",
    embeddingDim: 768,
    chunkerVersion: 1,
    windowLines: 30,
    overlapLines: 10,
    activeIndex: {
      version: 1,
      githubRepoId: args.githubRepoId,
      builtMode: args.builtMode ?? "on",
      byPath: { [args.path]: [args.chunkId] },
    },
  }
}

function makeKv(initial: Map<string, string>): KVNamespace {
  return {
    get: vi.fn(async (key: string) => initial.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      initial.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      initial.delete(key)
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: undefined })),
  } as unknown as KVNamespace
}

function makeClient(): FakeClient {
  return {
    getRepository: vi.fn(async (_owner: string, repo: string) => ({
      id: repo.toLowerCase() === "api" ? 101 : 102,
      default_branch: "main",
    })),
    getFileContent: vi.fn(async () => CONTENT),
  }
}

async function fixture(mode: "shadow" | "on" = "on") {
  const apiChunkId = await chunkId("acme/api", {
    path: "src/auth.ts",
    lineStart: 1,
    lineEnd: 3,
    content: CONTENT,
  })
  const webChunkId = await chunkId("acme/web", {
    path: "src/auth.ts",
    lineStart: 1,
    lineEnd: 3,
    content: CONTENT,
  })
  const store = new Map<string, string>([
    [
      repoTenantKey(101),
      JSON.stringify(
        manifest({
          githubRepoId: 101,
          repo: "api",
          headSha: SHA_A,
          runId: RUN_A,
          path: "src/auth.ts",
          chunkId: apiChunkId,
          builtMode: mode,
        }),
      ),
    ],
    [
      repoTenantKey(102),
      JSON.stringify(
        manifest({
          githubRepoId: 102,
          repo: "web",
          headSha: SHA_B,
          runId: RUN_B,
          path: "src/auth.ts",
          chunkId: webChunkId,
          builtMode: mode,
        }),
      ),
    ],
  ])
  const client = makeClient()
  let currentScope: SlackScope | null = scope()
  const session = createSlackCodeCitationSession({
    mode,
    env: { OPENCLAW_STATE: makeKv(store) } as Env,
    scope: scope(),
    githubClient: client as unknown as GitHubClient,
    resolveCurrentScope: async () => currentScope,
  })
  const chunks: Record<string, RetrievedChunk> = {
    api: {
      id: apiChunkId,
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 3,
      content: CONTENT,
      score: 0.9,
      indexedHeadSha: SHA_A,
      indexRunId: RUN_A,
    },
    web: {
      id: webChunkId,
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 3,
      content: CONTENT,
      score: 0.8,
      indexedHeadSha: SHA_B,
      indexRunId: RUN_B,
    },
  }
  return {
    session,
    chunks,
    store,
    client,
    apiChunkId,
    webChunkId,
    setCurrentScope(value: SlackScope | null) {
      currentScope = value
    },
  }
}

describe("Slack code citation mode and schema", () => {
  it("parses only explicit shadow/on and keeps citations optional", () => {
    expect(parseSlackCodeCitationMode(undefined)).toBe("off")
    expect(parseSlackCodeCitationMode("ON")).toBe("off")
    expect(parseSlackCodeCitationMode("shadow")).toBe("shadow")
    expect(parseSlackCodeCitationMode("on")).toBe("on")
    expect(SLACK_CODE_CITATION_SCHEMA.required).not.toContain("citations")
  })

  it("extracts only the bounded model sidecar without changing the answer", () => {
    const one = {
      githubRepoId: 101,
      repo: "Acme/Api",
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 3,
      ref: SHA_A,
      runId: RUN_A,
      chunkId: "a".repeat(48),
    }
    expect(extractSlackCodeCitationSelections({ answer: "A", citations: [one] })).toEqual([one])
    expect(extractSlackCodeCitationSelections({ answer: "A" })).toEqual([])
    expect(extractSlackCodeCitationSelections({ answer: "A", citations: Array(50).fill(one) })).toHaveLength(24)
  })
})

describe("createSlackCodeCitationSession", () => {
  it("issues only an exact active-snapshot chunk with immutable repo, head, and run proof", async () => {
    const { session, chunks, apiChunkId } = await fixture()
    await expect(session.preflight("acme/api", "")).resolves.toEqual({ ok: true })

    const issued = await session.filterAndIssue("acme/api", [chunks.api!])

    expect(issued).toHaveLength(1)
    expect(issued[0]?.citation).toEqual({
      githubRepoId: 101,
      repo: "Acme/Api",
      path: "src/auth.ts",
      lineStart: 1,
      lineEnd: 3,
      ref: SHA_A,
      runId: RUN_A,
      chunkId: apiChunkId,
    })
  })

  it("fails closed without rejecting the tool when chunk identity computation is unavailable", async () => {
    const { session, chunks } = await fixture()
    await session.preflight("acme/api", "")
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("crypto unavailable"))
    try {
      await expect(session.filterAndIssue("acme/api", [chunks.api!])).resolves.toEqual([])
    } finally {
      digest.mockRestore()
    }
  })

  it("rejects branch retrieval and missing/mismatched proof before retrieval", async () => {
    const { session, store } = await fixture()
    await expect(session.preflight("acme/api", "dev")).resolves.toMatchObject({ ok: false })

    store.delete(repoTenantKey(101))
    await expect(session.preflight("acme/api", "")).resolves.toMatchObject({ ok: false })
  })

  it("requires active-index builtMode=on for enforcement but can inspect shadow proof in shadow mode", async () => {
    const shadow = await fixture("shadow")
    const enforcing = createSlackCodeCitationSession({
      mode: "on",
      env: { OPENCLAW_STATE: makeKv(shadow.store) } as Env,
      scope: scope(),
      githubClient: shadow.client as unknown as GitHubClient,
      resolveCurrentScope: async () => scope(),
    })

    await expect(enforcing.preflight("acme/api", "")).resolves.toMatchObject({ ok: false })
    await expect(shadow.session.preflight("acme/api", "")).resolves.toEqual({ ok: true })
  })

  it("drops chunks absent from byPath, carrying a stale run/head, or lying about content", async () => {
    const { session, chunks } = await fixture()
    await session.preflight("acme/api", "")

    const issued = await session.filterAndIssue("acme/api", [
      { ...chunks.api!, id: "f".repeat(48) },
      { ...chunks.api!, indexRunId: RUN_B },
      { ...chunks.api!, indexedHeadSha: SHA_B },
      { ...chunks.api!, content: "forged content" },
    ])

    expect(issued).toEqual([])
  })

  it("renders exact-commit repo-qualified links only after manifest, live repo, and file revalidation", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")

    const answer = await session.verifyAndRender("The guard returns true.", [citation])

    expect(answer).toContain("The guard returns true.")
    expect(answer).toContain(`https://github.com/Acme/Api/blob/${SHA_A}/src/auth.ts#L1-L3`)
    expect(answer).toContain("Acme/Api")
    expect(client.getFileContent).toHaveBeenCalledWith("Acme", "Api", "src/auth.ts", SHA_A, expect.anything())
  })

  it("keeps citation-free answers byte-for-byte and performs no verification IO", async () => {
    const { session, client } = await fixture()
    const answer = "  Preserve my bytes.  "

    await expect(session.verifyAndRender(answer, [])).resolves.toBe(answer)
    expect(client.getRepository).not.toHaveBeenCalled()
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("fails closed when verified chunks were issued but the model omits their sidecars", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    await expect(session.filterAndIssue("acme/api", [chunks.api!])).resolves.toHaveLength(1)

    await expect(session.verifyAndRender("Uncited current-code claim", [])).resolves.toBe(
      SLACK_CODE_CITATION_REVALIDATION_FAILED,
    )
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("fails closed when retrieval was attempted but no chunk passed citation proof", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    await expect(session.filterAndIssue("acme/api", [{ ...chunks.api!, id: "f".repeat(48) }])).resolves.toEqual([])

    await expect(session.verifyAndRender("Unsupported current-code claim", [])).resolves.toBe(
      SLACK_CODE_CITATION_REVALIDATION_FAILED,
    )
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("rejects a model-forged or prior-run citation without GitHub IO", async () => {
    const first = await fixture()
    await first.session.preflight("acme/api", "")
    const issued = await first.session.filterAndIssue("acme/api", [first.chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    const second = await fixture()

    await expect(second.session.verifyAndRender("Answer", [citation])).resolves.toBe(
      SLACK_CODE_CITATION_REVALIDATION_FAILED,
    )
    expect(second.client.getRepository).not.toHaveBeenCalled()
    expect(second.client.getFileContent).not.toHaveBeenCalled()
  })

  it("fails closed when the manifest rolls forward or active membership changes after issuance", async () => {
    const { session, chunks, store, client, apiChunkId } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    store.set(
      repoTenantKey(101),
      JSON.stringify(
        manifest({
          githubRepoId: 101,
          repo: "api",
          headSha: SHA_B,
          runId: RUN_B,
          path: "src/auth.ts",
          chunkId: apiChunkId,
        }),
      ),
    )

    await expect(session.verifyAndRender("Answer", [citation])).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("fails closed when the current snapshot removes the issued chunk without changing head or run", async () => {
    const { session, chunks, store, client } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    store.set(
      repoTenantKey(101),
      JSON.stringify(
        manifest({
          githubRepoId: 101,
          repo: "api",
          headSha: SHA_A,
          runId: RUN_A,
          path: "src/auth.ts",
          chunkId: "f".repeat(48),
        }),
      ),
    )

    await expect(session.verifyAndRender("Answer", [citation])).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("keeps identical paths in two repositories unambiguous", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    await session.preflight("acme/web", "")
    const [api] = await session.filterAndIssue("acme/api", [chunks.api!])
    const [web] = await session.filterAndIssue("acme/web", [chunks.web!])

    const answer = await session.verifyAndRender("They share a path.", [api!.citation, web!.citation])

    expect(answer).toContain(`github.com/Acme/Api/blob/${SHA_A}/src/auth.ts#L1-L3`)
    expect(answer).toContain(`github.com/Acme/Web/blob/${SHA_B}/src/auth.ts#L1-L3`)
    expect(client.getFileContent.mock.calls).toEqual(
      expect.arrayContaining([
        ["Acme", "Api", "src/auth.ts", SHA_A, expect.anything()],
        ["Acme", "Web", "src/auth.ts", SHA_B, expect.anything()],
      ]),
    )
  })

  it("fails the whole answer when a valid citation is paired with a forged sidecar", async () => {
    const { session, chunks } = await fixture()
    await session.preflight("acme/api", "")
    const [issued] = await session.filterAndIssue("acme/api", [chunks.api!])
    if (!issued) throw new Error("expected issued citation")

    await expect(
      session.verifyAndRender("Answer", [issued.citation, { ...issued.citation, path: "src/forged.ts" }]),
    ).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
  })

  it("fails the whole answer when one of two issued citations no longer revalidates", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    await session.preflight("acme/web", "")
    const [api] = await session.filterAndIssue("acme/api", [chunks.api!])
    const [web] = await session.filterAndIssue("acme/web", [chunks.web!])
    if (!api || !web) throw new Error("expected issued citations")
    client.getFileContent.mockImplementation(async (_owner: string, repo: string) =>
      repo.toLowerCase() === "web" ? "stale content" : CONTENT,
    )

    await expect(session.verifyAndRender("Answer", [api.citation, web.citation])).resolves.toBe(
      SLACK_CODE_CITATION_REVALIDATION_FAILED,
    )
  })

  it("rejects an exact issued sidecar when live GitHub identity changes", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    client.getRepository.mockResolvedValueOnce({ id: 999, default_branch: "main" })

    await expect(session.verifyAndRender("Answer", [citation as SlackCodeCitation])).resolves.toBe(
      SLACK_CODE_CITATION_REVALIDATION_FAILED,
    )
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("rejects a citation when the repository is removed from the live channel binding mid-run", async () => {
    const { session, chunks, client, setCurrentScope } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    setCurrentScope({ ...scope(), repos: [{ githubRepoId: 102, owner: "Acme", repo: "Web" }] })

    await expect(session.verifyAndRender("Answer", [citation])).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
    expect(client.getFileContent).not.toHaveBeenCalled()
  })

  it("rejects a citation when the repository is removed while exact-SHA content is being verified", async () => {
    const { session, chunks, client, setCurrentScope } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    client.getFileContent.mockImplementationOnce(async () => {
      setCurrentScope({ ...scope(), repos: [{ githubRepoId: 102, owner: "Acme", repo: "Web" }] })
      return CONTENT
    })

    await expect(session.verifyAndRender("Answer", [citation])).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
    expect(client.getFileContent).toHaveBeenCalledTimes(1)
  })

  it("fails closed when exact-SHA file content no longer matches the issued range", async () => {
    const { session, chunks, client } = await fixture()
    await session.preflight("acme/api", "")
    const issued = await session.filterAndIssue("acme/api", [chunks.api!])
    const citation = issued[0]?.citation
    if (!citation) throw new Error("expected issued citation")
    client.getFileContent.mockResolvedValueOnce("different content")

    await expect(session.verifyAndRender("Answer", [citation])).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
  })

  it("bounds a hung GitHub verification and returns the fail-closed answer", async () => {
    vi.useFakeTimers()
    try {
      const { session, chunks, client } = await fixture()
      await session.preflight("acme/api", "")
      const issued = await session.filterAndIssue("acme/api", [chunks.api!])
      const citation = issued[0]?.citation
      if (!citation) throw new Error("expected issued citation")
      client.getFileContent.mockImplementationOnce(() => new Promise(() => {}))

      const pending = session.verifyAndRender("Answer", [citation])
      await vi.advanceTimersByTimeAsync(5_001)

      await expect(pending).resolves.toBe(SLACK_CODE_CITATION_REVALIDATION_FAILED)
    } finally {
      vi.useRealTimers()
    }
  })
})
