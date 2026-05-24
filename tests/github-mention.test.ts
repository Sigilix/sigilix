// GitHub @-mention reply pure helpers — response parser + reply
// formatter. The handler itself orchestrates network calls and is
// covered by integration smoke; these tests pin down the JSON-shape
// tolerance and the marker discipline.

import { describe, expect, it, vi } from "vitest"
import {
  acquireReviewDismissInProgressLock,
  dismissLatestBlockingSigilixReview,
  formatReviewDismissReply,
  formatReply,
  isReviewDismissRequest,
  parseGithubMentionResponse,
  parseReviewDismissDedupeRecord,
  releaseReviewDismissInProgressLock,
  serializeReviewDismissDedupeRecord,
  serializeReviewDismissInProgressRecord,
} from "../src/lib/github-mention"
import {
  LEGACY_REVIEW_BODY_MARKER,
  SIGILIX_REVIEW_BODY_MARKER,
} from "../src/lib/dismiss-prior-reviews"

describe("parseGithubMentionResponse", () => {
  const valid = {
    answer: "Fixed — guard now uses `<=` on `bounds.length` at `src/lib/foo.ts:42`.",
    confidence: 4,
    abstain: false,
  }

  it("parses a well-formed JSON object", () => {
    const out = parseGithubMentionResponse(JSON.stringify(valid))
    expect(out?.answer).toBe(valid.answer)
    expect(out?.confidence).toBe(4)
    expect(out?.abstain).toBe(false)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("extracts JSON from prose-wrapped output", () => {
    const text = `Here's my answer:\n\n${JSON.stringify(valid)}\n\n— Arc`
    expect(parseGithubMentionResponse(text)?.answer).toBe(valid.answer)
  })

  it("returns null on missing answer", () => {
    expect(parseGithubMentionResponse(JSON.stringify({ ...valid, answer: "" }))).toBeNull()
  })

  it("falls back to confidence 3 when confidence is out of range", () => {
    const out = parseGithubMentionResponse(JSON.stringify({ ...valid, confidence: 99 }))
    expect(out?.confidence).toBe(3)
  })

  it("falls back to confidence 3 when confidence is missing", () => {
    const obj = { answer: valid.answer, abstain: false }
    const out = parseGithubMentionResponse(JSON.stringify(obj))
    expect(out?.confidence).toBe(3)
  })

  it("coerces abstain to boolean", () => {
    const out = parseGithubMentionResponse(
      JSON.stringify({ answer: valid.answer, confidence: 2, abstain: "yes" })
    )
    expect(out?.abstain).toBe(true)
  })

  it("returns null on non-object input", () => {
    expect(parseGithubMentionResponse("[1, 2, 3]")).toBeNull()
    expect(parseGithubMentionResponse("not json")).toBeNull()
  })
})

describe("formatReply", () => {
  it("prepends the dedupe marker so Arc's own replies are detectable", () => {
    const out = formatReply({
      answer: "Fixed — guard now uses `<=` on `bounds.length`.",
      confidence: 5,
      abstain: false,
    })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("Fixed — guard now uses")
  })

  it("preserves the model's Markdown verbatim under the marker", () => {
    const answer = "Returns `null` when `x` is empty — see `src/lib/foo.ts:42`."
    const out = formatReply({ answer, confidence: 3, abstain: false })
    expect(out.endsWith(answer)).toBe(true)
  })
})

describe("isReviewDismissRequest", () => {
  it("accepts explicit dismiss command shapes only", () => {
    expect(isReviewDismissRequest("dismiss")).toBe(true)
    expect(isReviewDismissRequest("Dismiss this review.")).toBe(true)
    expect(isReviewDismissRequest("dismiss review")).toBe(true)
    expect(isReviewDismissRequest("can you dismiss this?")).toBe(false)
    expect(isReviewDismissRequest("dismiss the finding after checking this file")).toBe(false)
  })
})

describe("review dismiss dedupe records", () => {
  it("round-trips an in-progress record", () => {
    expect(parseReviewDismissDedupeRecord(serializeReviewDismissInProgressRecord())).toEqual({
      kind: "review-dismiss-in-progress",
    })
  })

  it("round-trips a tokenized in-progress lock record", () => {
    const parsed = parseReviewDismissDedupeRecord(
      serializeReviewDismissInProgressRecord("lock-token-1")
    )
    expect(parsed).toMatchObject({
      kind: "review-dismiss-in-progress",
      token: "lock-token-1",
    })
    expect(typeof parsed?.createdAt).toBe("number")
  })

  it("round-trips result records before and after a reply is posted", () => {
    const result = { kind: "dismissed" as const, reviewId: 10 }

    expect(parseReviewDismissDedupeRecord(serializeReviewDismissDedupeRecord(result))).toEqual({
      kind: "review-dismiss-result",
      result,
    })
    expect(parseReviewDismissDedupeRecord(serializeReviewDismissDedupeRecord(result, 4242))).toEqual({
      kind: "review-dismiss-result",
      result,
      replyCommentId: 4242,
    })
  })

  it("rejects malformed stored values", () => {
    expect(parseReviewDismissDedupeRecord("not json")).toBeNull()
    expect(parseReviewDismissDedupeRecord(JSON.stringify({ kind: "review-dismiss-result" }))).toBeNull()
    expect(parseReviewDismissDedupeRecord(JSON.stringify({
      kind: "review-dismiss-result",
      result: { kind: "dismissed" },
    }))).toBeNull()
  })
})

describe("review dismiss in-progress lock", () => {
  function makeKv(initial?: string): { kv: KVNamespace; store: Map<string, string> } {
    const store = new Map<string, string>()
    if (initial) store.set("gh-mention:1", initial)
    return {
      store,
      kv: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
        delete: vi.fn(async (key: string) => { store.delete(key) }),
      } as unknown as KVNamespace,
    }
  }

  it("acquires an empty key and stores a tokenized sentinel", async () => {
    const { kv, store } = makeKv()

    const lock = await acquireReviewDismissInProgressLock(kv, "gh-mention:1")

    expect(lock.acquired).toBe(true)
    if (!lock.acquired) throw new Error("expected lock")
    expect(parseReviewDismissDedupeRecord(store.get("gh-mention:1") ?? null)).toMatchObject({
      kind: "review-dismiss-in-progress",
      token: lock.token,
    })
  })

  it("does not acquire when a terminal result already exists", async () => {
    const result = { kind: "dismissed" as const, reviewId: 99 }
    const { kv } = makeKv(serializeReviewDismissDedupeRecord(result))

    const lock = await acquireReviewDismissInProgressLock(kv, "gh-mention:1")

    expect(lock).toEqual({
      acquired: false,
      record: { kind: "review-dismiss-result", result },
    })
  })

  it("clears only the matching in-progress sentinel", async () => {
    const { kv, store } = makeKv(serializeReviewDismissInProgressRecord("ours"))

    await releaseReviewDismissInProgressLock(kv, "gh-mention:1", "theirs")
    expect(store.has("gh-mention:1")).toBe(true)

    await releaseReviewDismissInProgressLock(kv, "gh-mention:1", "ours")
    expect(store.has("gh-mention:1")).toBe(false)
  })
})

describe("dismissLatestBlockingSigilixReview", () => {
  function clientWithReviews(reviews: Array<{
    id: number
    state: string
    login?: string
    body?: string
  }>) {
    return {
      listPullRequestReviews: vi.fn(async () => reviews.map((r) => ({
        id: r.id,
        state: r.state,
        user: r.login ? { login: r.login } : null,
        body: r.body ?? "",
        commitId: null,
      }))),
      dismissReview: vi.fn(async () => undefined),
    }
  }

  const base = { owner: "Arc-and-Anchor", repo: "sigilix", prNumber: 7 }

  it("dismisses the highest-id blocking Sigilix review by API", async () => {
    const client = clientWithReviews([
      { id: 13, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 11, state: "CHANGES_REQUESTED", login: "coderabbitai", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 12, state: "COMMENTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 10, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "dismissed", reviewId: 13 })
    expect(client.dismissReview).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      13,
      "Dismissed by explicit @sigilix dismiss request.",
    )
  })

  it("does not dismiss human or unmarked reviews", async () => {
    const client = clientWithReviews([
      { id: 20, state: "CHANGES_REQUESTED", login: "human", body: SIGILIX_REVIEW_BODY_MARKER },
      { id: 21, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: "missing marker" },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "not-found" })
    expect(client.dismissReview).not.toHaveBeenCalled()
  })

  it("dismisses a blocking Sigilix review with the legacy marker", async () => {
    const client = clientWithReviews([
      { id: 25, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: LEGACY_REVIEW_BODY_MARKER },
    ])

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({ kind: "dismissed", reviewId: 25 })
    expect(client.dismissReview).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      7,
      25,
      "Dismissed by explicit @sigilix dismiss request.",
    )
  })

  it("reports review-list failures instead of throwing or claiming success", async () => {
    const client = clientWithReviews([])
    client.listPullRequestReviews.mockRejectedValueOnce(new Error("secondary rate limit"))

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({
      kind: "list-failed",
      error: "secondary rate limit",
    })
    expect(client.dismissReview).not.toHaveBeenCalled()
  })

  it("reports permission/API failures instead of claiming success", async () => {
    const client = clientWithReviews([
      { id: 30, state: "CHANGES_REQUESTED", login: "sigilix[bot]", body: SIGILIX_REVIEW_BODY_MARKER },
    ])
    client.dismissReview.mockRejectedValueOnce(new Error("Resource not accessible by integration"))

    const result = await dismissLatestBlockingSigilixReview({ client, ...base })

    expect(result).toEqual({
      kind: "dismiss-failed",
      reviewId: 30,
      error: "Resource not accessible by integration",
    })
  })
})

describe("formatReviewDismissReply", () => {
  it("keeps the GitHub mention marker and honest success copy", () => {
    const out = formatReviewDismissReply({ kind: "dismissed", reviewId: 10 })
    expect(out.startsWith("<!-- sigilix:gh-mention-reply -->")).toBe(true)
    expect(out).toContain("Dismissed the latest blocking Sigilix review")
  })
})
