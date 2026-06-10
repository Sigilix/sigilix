// SIG-225 — wire tests for the two new LinearClient methods that back
// the in-thread-reply trigger:
//
//   - `getCommentParents(issueId)`  → snapshot of the issue's most-
//                                     recently-updated 100 comments
//   - `getCommentAuthor(commentId)` → focused single-comment lookup
//                                     (backstop for replica-lag / deep
//                                     thread snapshot misses)
//
// Both went out unguarded on PR #196 round 1; Sigilix bot review flagged
// the missing coverage as score-4 testing. Coverage focus per the
// review:
//   1. orderBy: updatedAt MUST appear in the GraphQL query string —
//      Linear's default ordering is createdAt ASC and silently returns
//      the OLDEST 100 comments, breaking the trigger on long threads.
//      If a future refactor drops the orderBy, this test pins the
//      contract and breaks LOUDLY.
//   2. Returned shape normalizes `parent { id } | null` to
//      `parentId: string | null` — verify the mapping.
//   3. Missing issue / missing comment → safe empty / null returns.
//   4. AbortSignal threads through to the underlying fetch call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LinearClient } from "@/lib/linear"

interface CapturedRequest {
  url: string
  body: { query: string; variables: Record<string, unknown> }
  signalProvided: boolean
}

function mockLinearFetch(args: {
  // Per-test response payload. Caller returns the `data` slice OR null
  // for the GraphQL `data.issue` / `data.comment` fields.
  responder: (req: CapturedRequest) => unknown
  status?: number
}): { captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const bodyText = typeof init?.body === "string" ? init.body : ""
    const body = JSON.parse(bodyText) as { query: string; variables: Record<string, unknown> }
    const req: CapturedRequest = {
      url,
      body,
      signalProvided: Boolean(init?.signal),
    }
    captured.push(req)
    return new Response(JSON.stringify({ data: args.responder(req) }), {
      status: args.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  })
  return { captured }
}

describe("LinearClient.getCommentParents (SIG-225 snapshot fetch)", () => {
  let client: LinearClient
  beforeEach(() => {
    client = new LinearClient({ apiKey: "test-api-key" })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("pins `orderBy: updatedAt` in the GraphQL query — contract guard", async () => {
    // CRITICAL: a future refactor that drops or changes this ordering
    // silently breaks the trigger on threads >100 comments. The query
    // is a literal in the source, so a substring match is robust.
    const { captured } = mockLinearFetch({
      responder: () => ({ issue: { comments: { nodes: [] } } }),
    })
    await client.getCommentParents("issue-id-1")
    expect(captured).toHaveLength(1)
    expect(captured[0]?.body.query).toContain("orderBy: updatedAt")
    expect(captured[0]?.body.query).toContain("first: 100")
    expect(captured[0]?.body.variables).toEqual({ id: "issue-id-1" })
  })

  it("normalizes `parent { id }` → `parentId: string | null` in returned nodes", async () => {
    // Linear's GraphQL returns the parent as a NESTED object (or null);
    // the helper flattens to `parentId` so `linear-thread-ancestor.ts`
    // doesn't have to know the GraphQL shape.
    mockLinearFetch({
      responder: () => ({
        issue: {
          comments: {
            nodes: [
              { id: "c1", parent: null, user: { name: "danny", displayName: "Danny" } },
              { id: "c2", parent: { id: "c1" }, user: { name: "sigilix", displayName: "Sigilix" } },
              { id: "c3", parent: { id: "c2" }, user: null },
            ],
          },
        },
      }),
    })
    const result = await client.getCommentParents("issue-id-1")
    expect(result).toEqual([
      { id: "c1", parentId: null, user: { name: "danny", displayName: "Danny" } },
      { id: "c2", parentId: "c1", user: { name: "sigilix", displayName: "Sigilix" } },
      { id: "c3", parentId: "c2", user: null },
    ])
  })

  it("returns an empty array when issue is missing (null) — fails closed for the helper", async () => {
    // Linear returns `data.issue: null` if the id doesn't resolve. The
    // method must not throw — the ancestor walk depends on getting an
    // array (possibly empty) so it can fail closed cleanly.
    mockLinearFetch({ responder: () => ({ issue: null }) })
    expect(await client.getCommentParents("missing-issue")).toEqual([])
  })

  it("threads AbortSignal through to fetch (used by webhook 2s timeout)", async () => {
    // The webhook handler wraps each Linear GraphQL call with
    // `AbortSignal.timeout(2000)` so the request never blocks past
    // Linear's webhook ack deadline. Verify the signal is plumbed.
    const { captured } = mockLinearFetch({
      responder: () => ({ issue: { comments: { nodes: [] } } }),
    })
    const controller = new AbortController()
    await client.getCommentParents("issue-id-1", { signal: controller.signal })
    expect(captured[0]?.signalProvided).toBe(true)
  })

  it("works without an AbortSignal (signal optional)", async () => {
    // Defensive: signal is optional so existing call sites that don't
    // care about timeout (none today, but possible later) still work.
    const { captured } = mockLinearFetch({
      responder: () => ({ issue: { comments: { nodes: [] } } }),
    })
    await client.getCommentParents("issue-id-1")
    expect(captured[0]?.signalProvided).toBe(false)
  })
})

describe("LinearClient.getCommentAuthor (SIG-225 backstop lookup)", () => {
  let client: LinearClient
  beforeEach(() => {
    client = new LinearClient({ apiKey: "test-api-key" })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("issues a single-comment GraphQL query with the comment id", async () => {
    const { captured } = mockLinearFetch({
      responder: () => ({ comment: { id: "c1", parent: null, user: null } }),
    })
    await client.getCommentAuthor("c1")
    expect(captured).toHaveLength(1)
    expect(captured[0]?.body.query).toContain("comment(id: $id)")
    expect(captured[0]?.body.variables).toEqual({ id: "c1" })
  })

  it("normalizes nested parent + returns shape consumed by webhook handler", async () => {
    mockLinearFetch({
      responder: () => ({
        comment: {
          id: "c2",
          parent: { id: "c1" },
          user: { name: "sigilix", displayName: "Sigilix" },
        },
      }),
    })
    const result = await client.getCommentAuthor("c2")
    expect(result).toEqual({
      id: "c2",
      parentId: "c1",
      user: { name: "sigilix", displayName: "Sigilix" },
    })
  })

  it("returns null when the comment is missing", async () => {
    // Linear returns `data.comment: null` when the id is unknown.
    // The webhook handler treats null parent as a non-Sigilix ancestor
    // → no trigger. Verify the null contract.
    mockLinearFetch({ responder: () => ({ comment: null }) })
    expect(await client.getCommentAuthor("missing-comment")).toBeNull()
  })

  it("threads AbortSignal through to fetch", async () => {
    const { captured } = mockLinearFetch({
      responder: () => ({ comment: { id: "c1", parent: null, user: null } }),
    })
    await client.getCommentAuthor("c1", { signal: AbortSignal.timeout(2000) })
    expect(captured[0]?.signalProvided).toBe(true)
  })
})
