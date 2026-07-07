// GitLab review client — read + write verbs against a mocked GitLab REST v4.
// Exercises the wire mapping onto the GitHub-shaped SCM port surface, the diff
// synthesis, and the recall-safe write path (summary note + inline discussions
// with a fallback note for un-anchored findings).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitLabClient } from "@/src/shared/adapters/gitlab"
import type { SubmitReviewBody } from "@/src/shared/types/github"

const BASE = "https://gitlab.example.com"

interface Call {
  method: string
  url: string
  body: unknown
}

let calls: Call[]

/** A minimal Response stand-in. */
function res(status: number, payload: unknown, kind: "json" | "text" = "json"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (kind === "text" ? String(payload) : JSON.stringify(payload)),
  } as unknown as Response
}

/**
 * Route a request by method + path. Each matcher returns a Response or
 * `undefined` (fall through). The last-registered matcher wins on overlap.
 */
type Matcher = (req: Call) => Response | undefined

function installFetch(matchers: Matcher[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
      for (let i = matchers.length - 1; i >= 0; i--) {
        const matcher = matchers[i]
        if (!matcher) continue
        const out = matcher(call)
        if (out) return out
      }
      return res(404, { message: "unmatched" })
    }),
  )
}

function client(): GitLabClient {
  return new GitLabClient({ token: "glpat-xxx", baseUrl: BASE })
}

/** Find a recorded call or fail the test — keeps index access strict-safe. */
function findCall(pred: (c: Call) => boolean): Call {
  const c = calls.find(pred)
  if (!c) throw new Error("expected a matching fetch call, found none")
  return c
}

function noteBody(c: Call): string {
  return (c.body as { body: string }).body
}

beforeEach(() => {
  calls = []
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "log").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("GitLabClient — auth + base URL", () => {
  it("hits /api/v4 on the configured base URL with the PRIVATE-TOKEN header", async () => {
    installFetch([(r) => (r.url.includes("/repository/branches/") ? res(200, { commit: { id: "abc" } }) : undefined)])
    await client().getBranch("grp/sub", "proj", "main")
    const first = findCall((c) => c.url.includes("/repository/branches/"))
    expect(first.url).toContain(`${BASE}/api/v4/projects/`)
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit
    expect((init.headers as Record<string, string>)["private-token"]).toBe("glpat-xxx")
  })

  it("URL-encodes a nested group path into the :id segment", async () => {
    installFetch([(r) => (r.url.includes("/repository/branches/") ? res(200, { commit: { id: "abc" } }) : undefined)])
    await client().getBranch("grp/sub", "proj", "main")
    // grp/sub/proj -> grp%2Fsub%2Fproj
    expect(findCall(() => true).url).toContain("projects/grp%2Fsub%2Fproj/")
  })
})

describe("GitLabClient — read verbs", () => {
  it("getPullRequestDiff synthesizes a unified diff (headers GitLab omits)", async () => {
    installFetch([
      (r) =>
        r.url.includes("/merge_requests/7/changes")
          ? res(200, {
              changes: [
                { old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" },
                { old_path: "b.ts", new_path: "b.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+created\n" },
              ],
            })
          : undefined,
    ])
    const diff = await client().getPullRequestDiff("grp", "proj", 7)
    expect(diff).toContain("diff --git a/a.ts b/a.ts")
    expect(diff).toContain("--- a/a.ts")
    expect(diff).toContain("+++ b/a.ts")
    expect(diff).toContain("+new")
    // new_file -> old side is /dev/null
    expect(diff).toContain("--- /dev/null")
    expect(diff).toContain("+++ b/b.ts")
  })

  it("listPullRequestFiles derives status + additions/deletions from the per-file diff", async () => {
    installFetch([
      (r) =>
        r.url.includes("/changes")
          ? res(200, {
              changes: [
                { old_path: "x.ts", new_path: "x.ts", diff: "@@ -1,2 +1,2 @@\n-a\n-b\n+c\n" },
                { new_path: "n.ts", new_file: true, diff: "@@ -0,0 +1 @@\n+n\n" },
                { old_path: "d.ts", deleted_file: true, diff: "@@ -1 +0,0 @@\n-gone\n" },
                { old_path: "old.ts", new_path: "new.ts", renamed_file: true, diff: "" },
              ],
            })
          : undefined,
    ])
    const files = await client().listPullRequestFiles("grp", "proj", 7)
    expect(files[0]).toMatchObject({ filename: "x.ts", status: "modified", additions: 1, deletions: 2 })
    expect(files[1]).toMatchObject({ filename: "n.ts", status: "added" })
    expect(files[2]).toMatchObject({ filename: "d.ts", status: "removed" })
    expect(files[3]).toMatchObject({ filename: "new.ts", status: "renamed" })
  })

  it("RECALL-SAFETY: getPullRequestDiff throws on a truncated change set (never reviews a partial diff)", async () => {
    installFetch([
      (r) =>
        r.url.includes("/changes")
          ? res(200, { overflow: true, changes: [{ new_path: "a.ts", diff: "@@\n+x\n" }] })
          : undefined,
    ])
    await expect(client().getPullRequestDiff("grp", "proj", 7)).rejects.toThrow(/truncated/i)
  })

  it("listPullFilesForManifest flags overflow when GitLab truncates (changes_count `N+`)", async () => {
    installFetch([
      (r) =>
        r.url.includes("/changes")
          ? res(200, { changes_count: "1000+", changes: [{ new_path: "a.ts", diff: "@@\n+x\n" }] })
          : undefined,
    ])
    const out = await client().listPullFilesForManifest("grp", "proj", 7)
    expect(out.overflow).toBe(true)
    expect(out.entries).toHaveLength(1)
  })

  it("getFileContent returns raw text, and null on 404", async () => {
    installFetch([
      (r) => (r.url.includes("/files/src%2Fa.ts/raw") ? res(200, "file-body", "text") : undefined),
      (r) => (r.url.includes("/files/missing/raw") ? res(404, { message: "not found" }) : undefined),
    ])
    expect(await client().getFileContent("grp", "proj", "src/a.ts", "main")).toBe("file-body")
    expect(await client().getFileContent("grp", "proj", "missing", "main")).toBeNull()
  })

  it("getBranch returns the commit sha for both headSha + treeSha", async () => {
    installFetch([(r) => (r.url.includes("/branches/main") ? res(200, { commit: { id: "sha1" } }) : undefined)])
    expect(await client().getBranch("grp", "proj", "main")).toEqual({ headSha: "sha1", treeSha: "sha1" })
  })

  it("getMergeBase returns the merge-base id, null on error", async () => {
    installFetch([(r) => (r.url.includes("/merge_base") ? res(200, { id: "mb-sha" }) : undefined)])
    expect(await client().getMergeBase("grp", "proj", "main", "feat")).toBe("mb-sha")
    calls = []
    installFetch([(r) => (r.url.includes("/merge_base") ? res(500, { message: "boom" }) : undefined)])
    expect(await client().getMergeBase("grp", "proj", "main", "feat")).toBeNull()
  })

  it("listPullRequestReviews returns [] (GitLab has no review objects)", async () => {
    installFetch([])
    expect(await client().listPullRequestReviews("grp", "proj", 7)).toEqual([])
    // no network call — safe degrade
    expect(calls).toHaveLength(0)
  })
})

const REVIEW: SubmitReviewBody = {
  event: "REQUEST_CHANGES",
  body: "## Summary\nOne blocking issue.",
  comments: [{ path: "src/a.ts", line: 12, body: "off-by-one here", side: "RIGHT" }],
}

const OK_SUMMARY: Matcher = (r) => (r.method === "POST" && r.url.endsWith("/notes") ? res(200, { id: 500 }) : undefined)
const OK_DIFF_REFS: Matcher = (r) =>
  r.method === "GET" && /\/merge_requests\/7$/.test(r.url)
    ? res(200, { diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" } })
    : undefined

describe("GitLabClient — submitReview (bundled -> per-discussion)", () => {
  it("posts the summary note + one discussion with a correct inline position", async () => {
    installFetch([
      OK_SUMMARY,
      OK_DIFF_REFS,
      (r) => (r.method === "POST" && r.url.endsWith("/discussions") ? res(200, { id: "disc1" }) : undefined),
    ])
    const out = await client().submitReview("grp", "proj", 7, REVIEW)
    expect(out).toEqual({ id: 500, state: "REQUEST_CHANGES" })

    const summary = findCall((c) => c.method === "POST" && c.url.endsWith("/notes"))
    expect(summary.body).toEqual({ body: "## Summary\nOne blocking issue." })

    const disc = findCall((c) => c.method === "POST" && c.url.endsWith("/discussions"))
    expect(disc.body).toMatchObject({
      body: "off-by-one here",
      position: {
        position_type: "text",
        base_sha: "b",
        start_sha: "s",
        head_sha: "h",
        new_path: "src/a.ts",
        old_path: "src/a.ts",
        new_line: 12,
      },
    })
    // No fallback note posted when the discussion succeeds.
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/notes"))).toHaveLength(1)
  })

  it("maps side LEFT onto old_line", async () => {
    installFetch([
      (r) => (r.method === "POST" && r.url.endsWith("/notes") ? res(200, { id: 1 }) : undefined),
      OK_DIFF_REFS,
      (r) => (r.method === "POST" && r.url.endsWith("/discussions") ? res(200, { id: "d" }) : undefined),
    ])
    await client().submitReview("grp", "proj", 7, {
      event: "COMMENT",
      body: "x",
      comments: [{ path: "a.ts", line: 3, body: "ctx", side: "LEFT" }],
    })
    const disc = findCall((c) => c.url.endsWith("/discussions"))
    const position = (disc.body as { position: Record<string, unknown> }).position
    expect(position).toMatchObject({ old_line: 3 })
    expect(position.new_line).toBeUndefined()
  })

  it("RECALL-SAFETY: rethrows when the summary note POST fails", async () => {
    installFetch([(r) => (r.method === "POST" && r.url.endsWith("/notes") ? res(500, { message: "down" }) : undefined)])
    await expect(client().submitReview("grp", "proj", 7, REVIEW)).rejects.toThrow(/500/)
  })

  it("RECALL-SAFETY: a failed inline discussion re-posts the finding in a fallback note", async () => {
    installFetch([
      (r) => (r.method === "POST" && r.url.endsWith("/notes") ? res(200, { id: 9 }) : undefined),
      OK_DIFF_REFS,
      // discussion POST is rejected (e.g. line out of diff)
      (r) =>
        r.method === "POST" && r.url.endsWith("/discussions") ? res(400, { message: "bad position" }) : undefined,
    ])
    await client().submitReview("grp", "proj", 7, REVIEW)
    const notePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/notes"))
    // 1 summary + 1 fallback
    expect(notePosts).toHaveLength(2)
    const fallback = notePosts[1]
    expect(fallback).toBeDefined()
    expect(noteBody(fallback as Call)).toContain("off-by-one here")
    expect(noteBody(fallback as Call)).toContain("`src/a.ts`:12")
  })

  it("RECALL-SAFETY: no diff_refs -> all inline findings go to the fallback note", async () => {
    installFetch([
      (r) => (r.method === "POST" && r.url.endsWith("/notes") ? res(200, { id: 9 }) : undefined),
      (r) => (r.method === "GET" && /\/merge_requests\/7$/.test(r.url) ? res(200, { diff_refs: null }) : undefined),
    ])
    await client().submitReview("grp", "proj", 7, REVIEW)
    // never attempts a discussion (nothing to anchor to)
    expect(calls.some((c) => c.url.endsWith("/discussions"))).toBe(false)
    const notePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/notes"))
    expect(notePosts).toHaveLength(2)
    expect(noteBody(notePosts[1] as Call)).toContain("off-by-one here")
  })
})
