// ARC-185 — config parse-error PR comment poster.
//
// Mocks GitHub client + KV. Covers happy path (new post), KV dedupe,
// GH-side dedupe, head-SHA-keyed marker freshness on new SHA, failure
// modes, and KV warm-up on GH-side hit.

import { describe, it, expect, vi } from "vitest"
import { postConfigErrorComment } from "../src/lib/sigilix-config-error-comment"
import type { GitHubClient } from "../src/lib/github"
import type { Env } from "../src/index"

function fakeKV(initial: Record<string, string> = {}) {
  const store = { ...initial }
  const stub = {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: unknown) => {
      store[k] = v
    }),
    delete: vi.fn(async (k: string) => {
      delete store[k]
    }),
  }
  return { stub, store }
}

function makeEnv(kv: ReturnType<typeof fakeKV>["stub"]): Env {
  return { OPENCLAW_STATE: kv } as unknown as Env
}

function fakeClient(overrides: {
  listIssueComments?: GitHubClient["listIssueComments"]
  createIssueComment?: GitHubClient["createIssueComment"]
}): GitHubClient {
  return {
    listIssueComments: overrides.listIssueComments ?? (async () => []),
    createIssueComment: overrides.createIssueComment ?? (async () => ({ id: 1 })),
  } as unknown as GitHubClient
}

const args = {
  owner: "acme",
  repo: "site",
  prNumber: 7,
  headSha: "h".repeat(40),
  reason: "JSON parse failed: unexpected token",
  raw: "{not json",
}

describe("postConfigErrorComment", () => {
  it("posts a new comment when KV is empty AND no prior comment exists", async () => {
    const create = vi.fn(async () => ({ id: 100 }))
    const client = fakeClient({ createIssueComment: create })
    const { stub, store } = fakeKV()
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result.kind).toBe("posted")
    if (result.kind !== "posted") return
    expect(result.commentId).toBe(100)
    expect(create).toHaveBeenCalledOnce()
    const body = create.mock.calls[0][3] as string
    expect(body).toContain(`<!-- openclaw:config-error:${args.headSha.slice(0, 7)} -->`)
    expect(body).toContain("Sigilix config parse error")
    expect(body).toContain("JSON parse failed: unexpected token")
    expect(body).toContain("{not json")
    // KV was warmed
    expect(store["config-error-posted:acme/site#7:hhhhhhh"]).toBe("100")
  })

  it("suppresses via KV when the head-SHA-keyed key is already set", async () => {
    const create = vi.fn(async () => ({ id: 999 }))
    const client = fakeClient({ createIssueComment: create })
    const { stub } = fakeKV({
      "config-error-posted:acme/site#7:hhhhhhh": "42",
    })
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result).toEqual({ kind: "suppressed", reason: "kv-dedupe" })
    expect(create).not.toHaveBeenCalled()
  })

  it("suppresses via GitHub-side search when a comment with the marker already exists (cold KV)", async () => {
    const create = vi.fn(async () => ({ id: 999 }))
    const list = vi.fn(async () => [
      // Decoy: marker for a DIFFERENT head SHA
      { id: 50, body: "<!-- openclaw:config-error:zzzzzzz -->\nold" } as any,
      // Match: marker for THIS head SHA
      { id: 60, body: `<!-- openclaw:config-error:${args.headSha.slice(0, 7)} -->\nlanded` } as any,
    ])
    const client = fakeClient({ listIssueComments: list, createIssueComment: create })
    const { stub, store } = fakeKV()
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result).toEqual({ kind: "suppressed", reason: "github-dedupe" })
    expect(create).not.toHaveBeenCalled()
    // KV was warmed via the GH-found commentId
    expect(store["config-error-posted:acme/site#7:hhhhhhh"]).toBe("60")
  })

  it("DOES post when prior comment is for a DIFFERENT head SHA (per-headSha freshness)", async () => {
    const create = vi.fn(async () => ({ id: 200 }))
    const list = vi.fn(async () => [
      // Old comment is for "abc1234" — different from THIS head's marker
      { id: 50, body: "<!-- openclaw:config-error:abc1234 -->\nold" } as any,
    ])
    const client = fakeClient({ listIssueComments: list, createIssueComment: create })
    const { stub } = fakeKV()
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result.kind).toBe("posted")
    expect(create).toHaveBeenCalledOnce()
  })

  it("posts when listIssueComments fails (best-effort fallback)", async () => {
    const create = vi.fn(async () => ({ id: 300 }))
    const list = vi.fn(async () => {
      throw new Error("rate-limited")
    })
    const client = fakeClient({ listIssueComments: list, createIssueComment: create })
    const { stub } = fakeKV()
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result.kind).toBe("posted")
  })

  it("returns failed when createIssueComment throws (does NOT throw)", async () => {
    const create = vi.fn(async () => {
      throw new Error("forbidden")
    })
    const client = fakeClient({ createIssueComment: create })
    const { stub } = fakeKV()
    const result = await postConfigErrorComment({ env: makeEnv(stub), client, ...args })
    expect(result.kind).toBe("failed")
    if (result.kind !== "failed") return
    expect(result.err).toContain("forbidden")
  })

  it("returns skipped when headSha is empty", async () => {
    const { stub } = fakeKV()
    const result = await postConfigErrorComment({
      env: makeEnv(stub), client: fakeClient({}), ...args, headSha: "",
    })
    expect(result).toEqual({ kind: "skipped", reason: "missing-headsha" })
  })

  it("truncates raw config snippet to 500 chars + marker", async () => {
    const create = vi.fn(async () => ({ id: 100 }))
    const client = fakeClient({ createIssueComment: create })
    const { stub } = fakeKV()
    const longRaw = "x".repeat(2000)
    await postConfigErrorComment({
      env: makeEnv(stub), client, ...args, raw: longRaw,
    })
    const body = create.mock.calls[0][3] as string
    // Snippet section should not contain the full 2000-char body
    expect(body).toContain("…[truncated]")
    // No raw character should appear MORE than ~500 times
    const xCount = (body.match(/x/g) ?? []).length
    expect(xCount).toBeLessThan(600)
  })
})
