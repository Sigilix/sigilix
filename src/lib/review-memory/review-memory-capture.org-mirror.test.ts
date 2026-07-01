// Seat∪Org memory layering — Phase 1 wiring test. Exercises the REAL
// captureReviewFeedback -> captureConversationalLearning -> appendLearning
// path (only the model call is mocked) to prove the additive org-scope
// mirror write is correctly wired at this capture site: gated behind
// OPENCLAW_ORG_MEMORY_CAPTURE, fail-soft on an unresolvable installation,
// and leaves the repo-scope write byte-identical either way.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { captureReviewFeedback } from "@/src/lib/review-memory/capture"
import { extractLearning } from "@/src/features/learnings"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"
import { VALID_MARKER, makeConfig } from "@/src/lib/review-memory/review-memory-capture.test-helpers"

vi.mock("@/src/features/learnings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/learnings")>()
  return { ...actual, extractLearning: vi.fn() }
})

const REPLY_TEXT = "For future reference, please always use named exports here."
const REPO_KEY = learningsKey("repo", "555000")

function makeKv(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"], over: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    OPENCLAW_LEARNINGS_MODE: "on",
    ...over,
  } as unknown as Env
}

function makeClient(): GitHubClient {
  const getPullRequestReviewComment = vi.fn(async () => ({
    id: 9001,
    body: `Some review text\n\n${VALID_MARKER}`,
    user: { login: "sigilix[bot]" },
  }))
  const restGet = vi.fn(async () => ({ permission: "write" }))
  const replyToReviewComment = vi.fn(async () => ({ id: 12345 }))
  return {
    getPullRequestReviewComment,
    restGet,
    replyToReviewComment,
  } as unknown as GitHubClient
}

describe("captureReviewFeedback — Seat∪Org memory layering org-mirror wiring", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.mocked(extractLearning).mockResolvedValue({ rule: "use named exports", polarity: "require" })
  })
  afterEach(() => {
    consoleSpy.mockRestore()
    vi.mocked(extractLearning).mockReset()
  })

  it("flag off (default) — only the repo-scope entry is written; org keyspace untouched", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv) // OPENCLAW_ORG_MEMORY_CAPTURE unset
    await captureReviewFeedback({
      env,
      client: makeClient(),
      owner: "octo",
      repo: "repo",
      prNumber: 7,
      replyComment: { id: 100, body: REPLY_TEXT, in_reply_to_id: 50, path: "src/lib/foo.ts", authorLogin: "octocat" },
      config: makeConfig(),
      repoId: 555_000,
    })
    expect(store.has(REPO_KEY)).toBe(true)
    const orgKeys = Array.from(store.keys()).filter((k) => k.startsWith("learnings:org:"))
    expect(orgKeys).toHaveLength(0)
  })

  it("flag on + resolvable installation — writes BOTH a repo-scope and an org-scope entry", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, {
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 777 }),
    })
    await captureReviewFeedback({
      env,
      client: makeClient(),
      owner: "octo",
      repo: "repo",
      prNumber: 7,
      replyComment: { id: 100, body: REPLY_TEXT, in_reply_to_id: 50, path: "src/lib/foo.ts", authorLogin: "octocat" },
      config: makeConfig(),
      repoId: 555_000,
    })

    expect(store.has(REPO_KEY)).toBe(true)
    const repoStore = JSON.parse(store.get(REPO_KEY)!)
    expect(repoStore.entries).toHaveLength(1)
    const repoEntry = repoStore.entries[0]

    const orgKey = learningsKey("org", "777")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("777")
    expect(orgStore.entries).toHaveLength(1)
    const orgEntry = orgStore.entries[0]

    // Same learning (content-addressed id), taxonomy preserved, scope mirrored.
    expect(orgEntry.id).toBe(repoEntry.id)
    expect(orgEntry.rule).toBe(repoEntry.rule)
    expect(orgEntry.polarity).toBe(repoEntry.polarity)
    expect(orgEntry.type).toBe(repoEntry.type)
    expect(orgEntry.scope).toBe("org")
    expect(orgEntry.subjectId).toBe("777")
  })

  it("flag on + unresolvable installation — repo write still happens, org write skipped, no throw", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, {
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      // No entry for octo/repo or octo — installation map can't resolve.
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "someone-else/other": 1 }),
    })
    await expect(
      captureReviewFeedback({
        env,
        client: makeClient(),
        owner: "octo",
        repo: "repo",
        prNumber: 7,
        replyComment: {
          id: 100,
          body: REPLY_TEXT,
          in_reply_to_id: 50,
          path: "src/lib/foo.ts",
          authorLogin: "octocat",
        },
        config: makeConfig(),
        repoId: 555_000,
      }),
    ).resolves.toBeUndefined()

    expect(store.has(REPO_KEY)).toBe(true)
    const orgKeys = Array.from(store.keys()).filter((k) => k.startsWith("learnings:org:"))
    expect(orgKeys).toHaveLength(0)
  })

  it("regression guard: the repo-scope entry is byte-identical whether the flag is on or off", async () => {
    // Pin the clock — captureConversationalLearning stamps createdTs from
    // `new Date().toISOString()`, so an unpinned clock would make the two
    // runs differ by wall-clock milliseconds even though nothing else changed.
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"))
    try {
      const offRun = makeKv()
      await captureReviewFeedback({
        env: makeEnv(offRun.kv),
        client: makeClient(),
        owner: "octo",
        repo: "repo",
        prNumber: 7,
        replyComment: {
          id: 100,
          body: REPLY_TEXT,
          in_reply_to_id: 50,
          path: "src/lib/foo.ts",
          authorLogin: "octocat",
        },
        config: makeConfig(),
        repoId: 555_000,
      })

      const onRun = makeKv()
      await captureReviewFeedback({
        env: makeEnv(onRun.kv, {
          OPENCLAW_ORG_MEMORY_CAPTURE: "on",
          OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 777 }),
        }),
        client: makeClient(),
        owner: "octo",
        repo: "repo",
        prNumber: 7,
        replyComment: {
          id: 100,
          body: REPLY_TEXT,
          in_reply_to_id: 50,
          path: "src/lib/foo.ts",
          authorLogin: "octocat",
        },
        config: makeConfig(),
        repoId: 555_000,
      })

      expect(onRun.store.get(REPO_KEY)).toBe(offRun.store.get(REPO_KEY))
    } finally {
      vi.useRealTimers()
    }
  })
})
