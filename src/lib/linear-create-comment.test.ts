// SIG-225 follow-up — verify LinearClient.createComment threads an
// optional `parentId` into the GraphQL input so the bot's reply lands
// inside the same Linear thread as the user's source comment instead
// of posting as a new top-level comment on the issue.
//
// Founder reported the symptom on the first SIG-225 dogfood test
// (2026-05-26): the bot DID fire on the thread-followup trigger but
// its response appeared as a top-level comment under the issue
// description, not nested under the existing thread. Root cause:
// `mention-reply.ts` always called `linear.createComment(issueId,
// body)` without forwarding the source comment's parentId. This
// suite pins the contract that fixes that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LinearClient } from "@/src/lib/linear"

interface CapturedRequest {
  body: { query: string; variables: { input: Record<string, unknown> } }
}

function mockCommentCreateFetch(): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const body = JSON.parse(bodyText) as { query: string; variables: { input: Record<string, unknown> } }
    captured.push({ body })
    return new Response(
      JSON.stringify({ data: { commentCreate: { success: true, comment: { id: "new-comment-id" } } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
  return { captured }
}

describe("LinearClient.createComment — parentId pass-through (SIG-225 follow-up)", () => {
  let client: LinearClient
  beforeEach(() => {
    client = new LinearClient({ apiKey: "test-key" })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("includes parentId in the GraphQL input when supplied (thread-followup path)", () => {
    const { captured } = mockCommentCreateFetch()
    return client.createComment("issue-1", "Hello inside the thread", "parent-comment-1").then(() => {
      expect(captured).toHaveLength(1)
      expect(captured[0]?.body.variables.input).toEqual({
        issueId: "issue-1",
        body: "Hello inside the thread",
        parentId: "parent-comment-1",
      })
    })
  })

  it("omits parentId entirely when not supplied (legacy top-level path)", () => {
    // Top-of-thread mention path: the source comment has no parent so
    // the bot's reply lives at the issue root. The GraphQL input MUST
    // omit `parentId` entirely (NOT set it to `null`/`undefined`) —
    // Linear's CommentCreateInput treats `null` differently from
    // absent + we don't want to thread something that wasn't asked.
    const { captured } = mockCommentCreateFetch()
    return client.createComment("issue-1", "Hello at issue root").then(() => {
      expect(captured).toHaveLength(1)
      const input = captured[0]?.body.variables.input
      expect(input).toEqual({ issueId: "issue-1", body: "Hello at issue root" })
      expect("parentId" in (input ?? {})).toBe(false)
    })
  })

  it("omits parentId when an empty string is supplied (defense against false-y plumbing)", () => {
    // Defensive: if the caller computes `data.parent?.id` and gets
    // back an empty string, we should treat that as "no parent" and
    // NOT include an empty parentId in the GraphQL payload (Linear's
    // server would reject or misroute).
    const { captured } = mockCommentCreateFetch()
    return client.createComment("issue-1", "body", "").then(() => {
      const input = captured[0]?.body.variables.input
      expect(input).toEqual({ issueId: "issue-1", body: "body" })
      expect("parentId" in (input ?? {})).toBe(false)
    })
  })
})
