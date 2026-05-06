// ARC-184 — focused tests for the GitHub client helpers added for
// the review-provenance + stale-marker feature. Mocks `fetch` so the
// tests don't hit the real GitHub API; covers the success path, 404
// for both stale-marker targets, pagination drain, and overflow.

import { describe, it, expect, vi, afterEach } from "vitest"

import { GitHubClient } from "../src/lib/github"

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function errResp(status: number, msg = "error"): Response {
  return new Response(JSON.stringify({ message: msg }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const newClient = () => new GitHubClient({ token: "ghs_test_token" })

describe("getReview", () => {
  it("returns the review body on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp({ id: 42, body: "hello body" }),
    )
    const c = newClient()
    const r = await c.getReview("o", "r", 7, 42)
    expect(r).toEqual({ body: "hello body" })
  })

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(404))
    const c = newClient()
    const r = await c.getReview("o", "r", 7, 42)
    expect(r).toBeNull()
  })

  it("normalizes a missing body to empty string", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResp({ id: 42 }))
    const c = newClient()
    const r = await c.getReview("o", "r", 7, 42)
    expect(r).toEqual({ body: "" })
  })
})

describe("updateReviewBody", () => {
  it("PATCHes the review body endpoint with the right shape", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp({ id: 42, body: "new" }),
    )
    const c = newClient()
    await c.updateReviewBody("o", "r", 7, 42, "new")
    const call = fetchSpy.mock.calls[0]
    const url = typeof call[0] === "string" ? call[0] : call[0] instanceof URL ? call[0].toString() : (call[0] as Request).url
    const init = call[1] as RequestInit | undefined
    expect(url).toContain("/repos/o/r/pulls/7/reviews/42")
    expect(init?.method).toBe("PATCH")
    expect(init?.body).toBe(JSON.stringify({ body: "new" }))
  })
})

describe("getIssueComment", () => {
  it("returns the comment body on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp({ id: 99, body: "issue body" }),
    )
    const c = newClient()
    const r = await c.getIssueComment("o", "r", 99)
    expect(r).toEqual({ body: "issue body" })
  })

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(404))
    const c = newClient()
    const r = await c.getIssueComment("o", "r", 99)
    expect(r).toBeNull()
  })
})

describe("listPullFilesForManifest", () => {
  it("drains 3 pages (100 + 100 + 47) → 247 entries, no overflow", async () => {
    let page = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      page += 1
      const count = page === 1 ? 100 : page === 2 ? 100 : page === 3 ? 47 : 0
      return jsonResp(
        new Array(count).fill(null).map((_, i) => ({
          filename: `p${page}/f${i}.ts`,
          status: "modified",
        })),
      )
    })
    const c = newClient()
    const out = await c.listPullFilesForManifest("o", "r", 1)
    expect(out.overflow).toBe(false)
    expect(out.entries.length).toBe(247)
  })

  it("stops on first short page (exactly-100 then 0 → 100 entries)", async () => {
    let page = 0
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      page += 1
      return jsonResp(
        page === 1
          ? new Array(100).fill(null).map((_, i) => ({ filename: `f${i}.ts`, status: "modified" }))
          : [],
      )
    })
    const c = newClient()
    const out = await c.listPullFilesForManifest("o", "r", 1)
    expect(out.overflow).toBe(false)
    expect(out.entries.length).toBe(100)
  })

  it("returns overflow:true when the 30th full page is reached (3000 entries)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp(new Array(100).fill(null).map((_, i) => ({ filename: `f${i}.ts`, status: "modified" }))),
    )
    const c = newClient()
    const out = await c.listPullFilesForManifest("o", "r", 1)
    expect(out.overflow).toBe(true)
    expect(out.entries.length).toBe(3000)
  })

  it("preserves previous_filename for renames", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp([
        { filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" },
        { filename: "src/added.ts", status: "added" },
      ]),
    )
    const c = newClient()
    const out = await c.listPullFilesForManifest("o", "r", 1)
    expect(out.entries[0]).toEqual({
      filename: "src/new.ts",
      previous_filename: "src/old.ts",
      status: "renamed",
    })
    expect(out.entries[1]).toEqual({
      filename: "src/added.ts",
      previous_filename: null,
      status: "added",
    })
  })

  it("preserves removed status", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp([{ filename: "src/gone.ts", status: "removed" }]),
    )
    const c = newClient()
    const out = await c.listPullFilesForManifest("o", "r", 1)
    expect(out.entries[0].status).toBe("removed")
  })
})

describe("getMergeBase", () => {
  it("returns merge_base_commit.sha on 200", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResp({ merge_base_commit: { sha: "abc1234" } }),
    )
    const c = newClient()
    const out = await c.getMergeBase("o", "r", "main", "feat/x")
    expect(out).toBe("abc1234")
  })

  it("returns null when merge_base_commit is missing from the response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonResp({}))
    const c = newClient()
    const out = await c.getMergeBase("o", "r", "main", "feat/x")
    expect(out).toBeNull()
  })

  it("returns null on 404 (compare endpoint can 404 on dangling refs)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(404))
    const c = newClient()
    const out = await c.getMergeBase("o", "r", "main", "feat/x")
    expect(out).toBeNull()
  })

  it("returns null on 422 (force-push from unrelated history)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(422))
    const c = newClient()
    const out = await c.getMergeBase("o", "r", "main", "feat/x")
    expect(out).toBeNull()
  })
})
