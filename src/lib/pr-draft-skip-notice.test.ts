import { describe, it, expect, vi } from "vitest"
import {
  postDraftPrSkipNotice,
  renderDraftSkipNotice,
  renderDraftSkipSupersededNotice,
  supersedeDraftPrSkipNotice,
} from "@/lib/pr-draft-skip-notice"
import type { Env } from "@/shared/types/env"
import type { GitHubClient } from "@/shared/adapters/github"

function makeEnv(): { env: Env; kv: Map<string, string> } {
  const kv = new Map<string, string>()
  const env = {
    OPENCLAW_STATE: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value) },
      delete: async (key: string) => { kv.delete(key) },
    } as unknown as KVNamespace,
  } as unknown as Env
  return { env, kv }
}

function makeClient(comments: Array<{ id: number; body: string }> = []) {
  const listIssueComments = vi.fn(async () =>
    comments.map((c) => ({ ...c, user: { login: "sigilix[bot]" } })),
  )
  const getIssueComment = vi.fn(async (_owner: string, _repo: string, commentId: number) => {
    const existing = comments.find((c) => c.id === commentId)
    return existing ? { body: existing.body } : null
  })
  const createIssueComment = vi.fn(async (_owner: string, _repo: string, _pr: number, body: string) => {
    comments.push({ id: 100, body })
    return { id: 100 }
  })
  const updateIssueComment = vi.fn(async (_owner: string, _repo: string, commentId: number, body: string) => {
    const existing = comments.find((c) => c.id === commentId)
    if (existing) existing.body = body
  })
  return {
    client: {
      listIssueComments,
      getIssueComment,
      createIssueComment,
      updateIssueComment,
    } as unknown as GitHubClient,
    comments,
    listIssueComments,
    getIssueComment,
    createIssueComment,
    updateIssueComment,
  }
}

const base = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 7,
  headSha: "a".repeat(40),
}

describe("postDraftPrSkipNotice", () => {
  it("posts a visible draft-skip notice with manual review guidance", async () => {
    const { env } = makeEnv()
    const { client, createIssueComment } = makeClient()
    const out = await postDraftPrSkipNotice({ env, client, ...base })
    expect(out).toEqual({ kind: "posted", commentId: 100 })
    expect(createIssueComment).toHaveBeenCalledOnce()
    const body = createIssueComment.mock.calls[0]?.[3] as string
    expect(body).toContain("## Sigilix review skipped")
    expect(body).toContain("**Draft detected.**")
    expect(body).toContain("`/sigilix review`")
    expect(body).toContain("Commit: `aaaaaaa`")
  })

  it("uses KV to verify the cached comment and avoid re-listing for the same head", async () => {
    const { env } = makeEnv()
    const { client, createIssueComment, getIssueComment, listIssueComments } = makeClient()
    await postDraftPrSkipNotice({ env, client, ...base })
    createIssueComment.mockClear()
    getIssueComment.mockClear()
    listIssueComments.mockClear()

    const out = await postDraftPrSkipNotice({ env, client, ...base })

    expect(out).toEqual({ kind: "kv-hit", commentId: 100 })
    expect(getIssueComment).toHaveBeenCalledOnce()
    expect(listIssueComments).not.toHaveBeenCalled()
    expect(createIssueComment).not.toHaveBeenCalled()
  })

  it("restores the draft body when KV points at a superseded notice", async () => {
    const { env } = makeEnv()
    const { client, comments, updateIssueComment, listIssueComments } = makeClient()
    await postDraftPrSkipNotice({ env, client, ...base })
    comments[0]!.body = renderDraftSkipSupersededNotice(base.headSha)
    updateIssueComment.mockClear()
    listIssueComments.mockClear()

    const out = await postDraftPrSkipNotice({ env, client, ...base })

    expect(out).toEqual({ kind: "updated", commentId: 100 })
    expect(updateIssueComment).toHaveBeenCalledOnce()
    expect(listIssueComments).not.toHaveBeenCalled()
    expect(comments[0]?.body).toContain("## Sigilix review skipped")
  })

  it("updates the existing marked comment instead of spamming a new one", async () => {
    const { env } = makeEnv()
    const oldBody = renderDraftSkipNotice("b".repeat(40))
    const { client, comments, createIssueComment, updateIssueComment } = makeClient([
      { id: 42, body: oldBody },
    ])

    const out = await postDraftPrSkipNotice({ env, client, ...base })

    expect(out).toEqual({ kind: "updated", commentId: 42 })
    expect(updateIssueComment).toHaveBeenCalledOnce()
    expect(createIssueComment).not.toHaveBeenCalled()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toContain("Commit: `aaaaaaa`")
  })
})

describe("supersedeDraftPrSkipNotice", () => {
  it("marks the draft notice as superseded when the PR is ready for review", async () => {
    const { client, comments, updateIssueComment } = makeClient([
      { id: 42, body: renderDraftSkipNotice("b".repeat(40)) },
    ])

    const out = await supersedeDraftPrSkipNotice({ client, ...base })

    expect(out).toEqual({ kind: "updated", commentId: 42 })
    expect(updateIssueComment).toHaveBeenCalledOnce()
    expect(comments[0]?.body).toContain("## Sigilix review resumed")
    expect(comments[0]?.body).toContain("normal review run")
  })

  it("no-ops when there is no draft notice", async () => {
    const { client, updateIssueComment } = makeClient([])
    const out = await supersedeDraftPrSkipNotice({ client, ...base })
    expect(out).toEqual({ kind: "not-found" })
    expect(updateIssueComment).not.toHaveBeenCalled()
  })
})
