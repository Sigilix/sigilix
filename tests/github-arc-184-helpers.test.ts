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

// ARC-258 — Check Run lifecycle for the customer-visible in-progress
// reviewer indicator. The bot creates a Check Run in `in_progress`
// state at the head of the ensemble pipeline so customers see
// "Sigilix Review · In progress" in the PR's Checks tab; on success
// it's completed with `conclusion: neutral` (review posted; non-
// blocking), on failure with `conclusion: failure`, on stale-head
// with `conclusion: skipped`.
//
// Prior history: PR #80's first ARC-258 attempt used PENDING reviews,
// which are invisible to anyone except the bot that authored them
// (verified empirically on PR #80 — the placeholder never rendered).
// We replaced that with the Checks API in commit 4.

describe("createCheckRun (ARC-258)", () => {
  it("POSTs to /check-runs with name + head_sha + status fields", async () => {
    let captured: { url: string; method: string; body: unknown } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
      const url = typeof req === "string" ? req : (req as Request).url
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(init.body as string) : null
      captured = { url, method, body }
      return jsonResp({ id: 555 })
    })
    const c = newClient()
    const result = await c.createCheckRun("o", "r", {
      name: "Sigilix Review",
      headSha: "abc123",
      status: "in_progress",
      startedAt: "2026-05-17T00:00:00Z",
      output: { title: "Reviewing…", summary: "Sigilix is analyzing." },
    })
    expect(result).toEqual({ id: 555 })
    expect(captured!.method).toBe("POST")
    expect(captured!.url).toContain("/repos/o/r/check-runs")
    const body = captured!.body as Record<string, unknown>
    expect(body.name).toBe("Sigilix Review")
    expect(body.head_sha).toBe("abc123")
    expect(body.status).toBe("in_progress")
    expect(body.started_at).toBe("2026-05-17T00:00:00Z")
    expect(body.output).toEqual({ title: "Reviewing…", summary: "Sigilix is analyzing." })
  })

  it("omits optional fields entirely when not provided", async () => {
    let captured: { body: unknown } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_req, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null
      captured = { body }
      return jsonResp({ id: 1 })
    })
    const c = newClient()
    await c.createCheckRun("o", "r", { name: "x", headSha: "deadbeef" })
    const body = captured!.body as Record<string, unknown>
    expect(body.name).toBe("x")
    expect(body.head_sha).toBe("deadbeef")
    expect(body.status).toBeUndefined()
    expect(body.started_at).toBeUndefined()
    expect(body.details_url).toBeUndefined()
    expect(body.external_id).toBeUndefined()
    expect(body.output).toBeUndefined()
  })

  it("rethrows on 403 (App missing `checks: write` permission)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(403, "Resource not accessible by integration"))
    const c = newClient()
    await expect(c.createCheckRun("o", "r", { name: "x", headSha: "h" })).rejects.toThrow(/HTTP 403/)
  })
})

describe("updateCheckRun (ARC-258)", () => {
  it("PATCHes the check-run by id with status + conclusion + output", async () => {
    let captured: { url: string; method: string; body: unknown } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (req, init) => {
      const url = typeof req === "string" ? req : (req as Request).url
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(init.body as string) : null
      captured = { url, method, body }
      return jsonResp({ id: 555 })
    })
    const c = newClient()
    await c.updateCheckRun("o", "r", 555, {
      status: "completed",
      conclusion: "neutral",
      completedAt: "2026-05-17T00:01:00Z",
      output: { title: "Review posted", summary: "Sigilix posted a review." },
    })
    expect(captured!.method).toBe("PATCH")
    expect(captured!.url).toContain("/repos/o/r/check-runs/555")
    const body = captured!.body as Record<string, unknown>
    expect(body.status).toBe("completed")
    expect(body.conclusion).toBe("neutral")
    expect(body.completed_at).toBe("2026-05-17T00:01:00Z")
    expect(body.output).toEqual({ title: "Review posted", summary: "Sigilix posted a review." })
  })

  it("omits fields entirely when not provided (partial updates allowed)", async () => {
    let captured: { body: unknown } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_req, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null
      captured = { body }
      return jsonResp({ id: 1 })
    })
    const c = newClient()
    await c.updateCheckRun("o", "r", 555, { conclusion: "skipped" })
    const body = captured!.body as Record<string, unknown>
    expect(body.conclusion).toBe("skipped")
    expect(body.status).toBeUndefined()
    expect(body.completed_at).toBeUndefined()
    expect(body.output).toBeUndefined()
  })

  it("rethrows on 404 (caller logs and continues — finally is best-effort)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => errResp(404, "Not found"))
    const c = newClient()
    await expect(c.updateCheckRun("o", "r", 555, { conclusion: "neutral" })).rejects.toThrow(/HTTP 404/)
  })
})
