// SIG-304 Phase 2.2 — the hosted (thin-client) review driver: POST shape, auth,
// response/error mapping, empty-diff → null. git + fetch are mocked.

import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  diff: "diff --git a/a.ts b/a.ts\n+x\n",
  head: { sha: "head1" } as { sha: string },
}))
vi.mock("@/src/cli/adapters/local-git-client", () => ({
  localGitClient: () => ({
    getPullRequest: async () => ({ head: state.head, base: { sha: "base1" } }),
    getPullRequestDiff: async () => state.diff,
  }),
}))

import { runReviewRemote, runReviewRemoteGrounded } from "./run-review-remote"

const review = { verdict: { summary: "s", confidence: 4, findings: [] }, unanchoredFindings: [] }
const args = { endpoint: "https://api.sigilix.ai/", apiKey: "k", owner: "o", repo: "r", git: { cwd: "/x" } }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  state.diff = "diff --git a/a.ts b/a.ts\n+x\n"
  state.head = { sha: "head1" }
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

describe("runReviewRemote", () => {
  it("POSTs the diff to /v1/review with bearer auth and returns the review", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(review), { status: 200 }))
    const r = await runReviewRemote(args)
    expect(r).toEqual(review)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.sigilix.ai/v1/review") // trailing slash stripped
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k")
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ headSha: "head1", baseSha: "base1", diff: expect.stringContaining("diff --git") })
  })

  it("returns null (no fetch) when the diff is empty — nothing to review", async () => {
    state.diff = "   \n"
    expect(await runReviewRemote(args)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("throws when HEAD can't be resolved (git rev-parse → empty sha)", async () => {
    state.head = { sha: "" }
    await expect(runReviewRemote(args)).rejects.toThrow(/HEAD/)
  })

  it("throws a clear error on 401 (bad key)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
    await expect(runReviewRemote(args)).rejects.toThrow(/API key/)
  })

  it("throws with the server detail on a 5xx", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "review_failed", detail: "model 500" }), { status: 500 }),
    )
    await expect(runReviewRemote(args)).rejects.toThrow(/HTTP 500.*model 500/)
  })

  it("RECALL-SAFETY: a 200 with a null body THROWS (not a silent clean pass)", async () => {
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }))
    await expect(runReviewRemote(args)).rejects.toThrow(/malformed/)
  })

  it("RECALL-SAFETY: a 200 with a verdict-less / non-JSON body THROWS", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
    await expect(runReviewRemote(args)).rejects.toThrow(/malformed/)
    fetchMock.mockResolvedValueOnce(new Response("<html>error</html>", { status: 200 }))
    await expect(runReviewRemote(args)).rejects.toThrow(/malformed/)
  })
})

describe("runReviewRemoteGrounded (Mode B)", () => {
  const gArgs = { endpoint: "https://api.sigilix.ai/", apiKey: "k", owner: "o", repo: "r", prNumber: 7 }

  it("POSTs a grounded PR reference (no diff, no local git) and returns the review", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(review), { status: 200 }))
    const r = await runReviewRemoteGrounded(gArgs)
    expect(r).toEqual(review)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.sigilix.ai/v1/review")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k")
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ mode: "grounded", owner: "o", repo: "r", prNumber: 7 }) // no headSha/diff
  })

  it("returns null when the server had nothing to review (200 null is legit for grounded)", async () => {
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }))
    expect(await runReviewRemoteGrounded(gArgs)).toBeNull()
  })

  it("throws a clear error on 401 (bad key)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
    await expect(runReviewRemoteGrounded(gArgs)).rejects.toThrow(/API key/)
  })

  it("surfaces the server detail on 422 app_not_installed / 502 pr_unavailable", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "app_not_installed", detail: "not installed on o/r" }), { status: 422 }),
    )
    await expect(runReviewRemoteGrounded(gArgs)).rejects.toThrow(/HTTP 422.*not installed/)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "pr_unavailable", detail: "Not Found" }), { status: 502 }),
    )
    await expect(runReviewRemoteGrounded(gArgs)).rejects.toThrow(/HTTP 502.*Not Found/)
  })

  it("RECALL-SAFETY: a 200 with a verdict-less body THROWS (degraded server ≠ clean pass)", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(runReviewRemoteGrounded(gArgs)).rejects.toThrow(/malformed/)
  })
})
