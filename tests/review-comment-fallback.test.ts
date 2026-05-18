// ARC-279 — synth-body-as-PR-comment fallback tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockCreateIssueComment } = vi.hoisted(() => ({
  mockCreateIssueComment: vi.fn(),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  postReviewCommentFallback,
  renderReviewCommentFallback,
} from "../src/lib/review-comment-fallback"
import { GitHubClient } from "../src/lib/github"
import type { Env } from "../src/index"

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockCreateIssueComment.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  // Targeted spy restoration only (matches the dismiss-prior-reviews
  // test pattern); `vi.restoreAllMocks` would strip the
  // GitHubClient mock factory and break the next test.
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errSpy.mockRestore()
})

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
  reads: string[]
  writes: Array<{ key: string; value: string; opts?: unknown }>
}
function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const reads: string[] = []
  const writes: Array<{ key: string; value: string; opts?: unknown }> = []
  const kv = {
    async get(key: string): Promise<string | null> {
      reads.push(key)
      return store.get(key) ?? null
    },
    async put(key: string, value: string, opts?: unknown): Promise<void> {
      writes.push({ key, value, opts })
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, reads, writes }
}

const SYNTH_BODY = "<!-- openclaw:pr-review -->\n\n### Sigilix Summary\n\nLooks fine."

describe("renderReviewCommentFallback", () => {
  it("prepends the fallback marker + warning header above the synth body", () => {
    const out = renderReviewCommentFallback({
      body: SYNTH_BODY,
      submitPath: "inline-anchored",
      headSha: "abc1234567890",
    })
    expect(out).toContain("<!-- sigilix:review-comment-fallback -->")
    expect(out).toContain("[!WARNING]")
    expect(out).toContain("Sigilix couldn't post this as a formal review")
    expect(out).toContain("`inline-anchored` submit returned 2xx")
    expect(out).toContain("abc1234") // 7-char SHA suffix
    expect(out).toContain("/sigilix review")
    // Synth body sits below the header.
    expect(out).toContain("### Sigilix Summary")
    expect(out).toContain("Looks fine.")
  })

  it("preserves the `openclaw:pr-review` marker that ships with the synth body (dismiss-prior + review-memory find it)", () => {
    const out = renderReviewCommentFallback({
      body: SYNTH_BODY,
      submitPath: "anchorless-fallback",
      headSha: "deadbeef",
    })
    expect(out).toContain("<!-- openclaw:pr-review -->")
    expect(out.match(/<!-- openclaw:pr-review -->/g)?.length).toBe(1)
  })

  it("injects the `openclaw:pr-review` marker if the synth body is missing it (defensive)", () => {
    // Should not happen in practice — every formatReviewBody output
    // includes the marker — but if a future path forgets, the
    // fallback re-injects so downstream pipelines still work.
    const out = renderReviewCommentFallback({
      body: "Summary text only, no marker.",
      submitPath: "phase3",
      headSha: "abc1234",
    })
    expect(out).toContain("<!-- openclaw:pr-review -->")
    expect(out).toContain("Summary text only, no marker.")
  })

  it("renders the submit path name in the header (inline-anchored / anchorless-fallback / phase3)", () => {
    for (const path of ["inline-anchored", "anchorless-fallback", "phase3"] as const) {
      const out = renderReviewCommentFallback({ body: SYNTH_BODY, submitPath: path, headSha: "abc1234" })
      expect(out).toContain(`\`${path}\``)
    }
  })

  it("renders a 7-char SHA suffix so the user can correlate the comment with the commit", () => {
    const out = renderReviewCommentFallback({
      body: SYNTH_BODY,
      submitPath: "inline-anchored",
      headSha: "abcdef0123456789",
    })
    expect(out).toContain("`abcdef0`")
  })
})

describe("postReviewCommentFallback — happy path", () => {
  const baseArgs = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 90,
    headSha: "abc1234567890abcdef",
    body: SYNTH_BODY,
    submitPath: "inline-anchored" as const,
  }

  it("posts the wrapped comment, sets the dedupe key, and returns ok=posted with the comment id", async () => {
    mockCreateIssueComment.mockResolvedValueOnce({ id: 999_999 })
    const { kv, writes } = makeKvStub()
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client, ...baseArgs,
    })

    expect(out).toEqual({ ok: true, reason: "posted", commentId: 999_999 })
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    const [owner, repo, prNumber, body] = mockCreateIssueComment.mock.calls[0]!
    expect(owner).toBe("Arc-and-Anchor")
    expect(repo).toBe("sigilix")
    expect(prNumber).toBe(90)
    expect(body).toContain("<!-- sigilix:review-comment-fallback -->")
    expect(body).toContain("### Sigilix Summary")
    // Dedupe key written AFTER the post (so a post failure doesn't
    // leave a phantom dedupe that suppresses a retry).
    expect(writes).toHaveLength(1)
    expect(writes[0]!.key).toBe(
      "pr-review-comment-fallback:Arc-and-Anchor/sigilix#90@abc1234567890abcdef",
    )
    const opts = writes[0]!.opts as { expirationTtl: number } | undefined
    expect(opts?.expirationTtl).toBe(7 * 24 * 60 * 60)
  })

  it("returns `ok=posted` without a commentId when GitHub returns an unexpected response shape", async () => {
    // Some test mocks return `{}`. The helper should still report
    // success since `createIssueComment` resolved.
    mockCreateIssueComment.mockResolvedValueOnce({})
    const { kv } = makeKvStub()
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client, ...baseArgs,
    })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.reason).toBe("posted")
  })
})

describe("postReviewCommentFallback — dedupe", () => {
  const baseArgs = {
    owner: "acme",
    repo: "site",
    prNumber: 42,
    headSha: "aaaaaaaaaaaaaaaaaaaa",
    body: SYNTH_BODY,
    submitPath: "inline-anchored" as const,
  }

  it("returns `ok=dedupe-hit` and skips the post when the per-(PR, headSha) key is already set", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "pr-review-comment-fallback:acme/site#42@aaaaaaaaaaaaaaaaaaaa",
      String(Date.now()),
    )
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client, ...baseArgs,
    })

    expect(out).toEqual({ ok: true, reason: "dedupe-hit" })
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })

  it("uses distinct dedupe keys per (PR, headSha) — one head's fallback does not suppress another's", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "pr-review-comment-fallback:acme/site#42@aaaaaaaaaaaaaaaaaaaa",
      String(Date.now()),
    )
    mockCreateIssueComment.mockResolvedValueOnce({ id: 1 })
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client,
      ...baseArgs,
      headSha: "bbbbbbbbbbbbbbbbbbbb", // different head
    })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.reason).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("proceeds with the post when the KV read FAILS (better one extra comment than zero)", async () => {
    const failingKv = {
      async get(): Promise<string | null> {
        throw new Error("KV read 503")
      },
      async put(): Promise<void> {
        // no-op
      },
    } as unknown as Env["OPENCLAW_STATE"]
    mockCreateIssueComment.mockResolvedValueOnce({ id: 1 })
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: failingKv } as unknown as Env,
      client, ...baseArgs,
    })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.reason).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    // The warn telemetry should fire so we notice if KV is degrading.
    const warned = warnSpy.mock.calls.some((c) => {
      const arg = c[0]
      return typeof arg === "string" && arg.includes("pr-review-comment-fallback-dedupe-read-failed")
    })
    expect(warned).toBe(true)
  })
})

describe("postReviewCommentFallback — post failure", () => {
  const baseArgs = {
    owner: "acme",
    repo: "site",
    prNumber: 42,
    headSha: "aaaaaaaaaaaaaaaaaaaa",
    body: SYNTH_BODY,
    submitPath: "inline-anchored" as const,
  }

  it("returns `ok=false` with the error message when createIssueComment throws (no dedupe key written)", async () => {
    mockCreateIssueComment.mockRejectedValueOnce(new Error("HTTP 403 Forbidden"))
    const { kv, writes } = makeKvStub()
    const client = new GitHubClient({ token: "t" })

    const out = await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client, ...baseArgs,
    })

    expect(out).toEqual({ ok: false, reason: "post-failed", error: "HTTP 403 Forbidden" })
    // Dedupe key NOT written — a future retry should be allowed.
    expect(writes).toEqual([])
  })
})

describe("postReviewCommentFallback — telemetry shape", () => {
  it("emits `pr-review-comment-fallback-posted` with submit_path + headSha on success", async () => {
    mockCreateIssueComment.mockResolvedValueOnce({ id: 42 })
    const { kv } = makeKvStub()
    const client = new GitHubClient({ token: "t" })

    await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 90,
      headSha: "abc1234567890abcdef",
      body: SYNTH_BODY,
      submitPath: "anchorless-fallback",
    })

    const postedLog = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-review-comment-fallback-posted"))
    expect(postedLog).toBeDefined()
    expect(postedLog).toContain('"submit_path":"anchorless-fallback"')
    expect(postedLog).toContain('"headSha":"abc1234567890abcdef"')
  })

  it("emits `pr-review-comment-fallback-dedupe-hit` with submit_path + headSha on dedupe hit", async () => {
    const { kv, store } = makeKvStub()
    store.set(
      "pr-review-comment-fallback:Arc-and-Anchor/sigilix#90@abc1234567890abcdef",
      String(Date.now()),
    )
    const client = new GitHubClient({ token: "t" })

    await postReviewCommentFallback({
      env: { OPENCLAW_STATE: kv } as unknown as Env,
      client,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 90,
      headSha: "abc1234567890abcdef",
      body: SYNTH_BODY,
      submitPath: "inline-anchored",
    })

    const dedupeLog = logSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("pr-review-comment-fallback-dedupe-hit"))
    expect(dedupeLog).toBeDefined()
    expect(dedupeLog).toContain('"submit_path":"inline-anchored"')
  })
})
