// Seat∪Org memory layering — Phase 1 wiring test for the QA auto-learning
// capture site (github-mention-auto-learnings.ts). Exercises the REAL
// postGithubMentionQaReply -> captureGithubMentionQaLearning -> appendLearning
// path (only the model call is mocked) to prove the additive org-scope
// mirror write is correctly wired here too: gated behind
// OPENCLAW_ORG_MEMORY_CAPTURE, fail-soft on an unresolvable installation, and
// the repo-scope write + posted reply stay byte-identical either way.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { postGithubMentionQaReply } from "@/src/lib/github-mention-auto-learnings"
import { extractLearning } from "@/src/features/learnings"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { Env } from "@/src/shared/types/env"
import type {
  GithubMentionLearningClient,
  GithubMentionLearningSourceComment,
} from "@/src/lib/github-mention-learnings"

vi.mock("@/src/features/learnings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/learnings")>()
  return { ...actual, extractLearning: vi.fn() }
})

const REPO_KEY = learningsKey("repo", "555000")
const SOURCE_COMMENT: GithubMentionLearningSourceComment = { author: "octocat" }

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
    OPENCLAW_LEARNINGS_MODE: "on",
    ...over,
  } as unknown as Env
}

function makeClient(): GithubMentionLearningClient {
  return {
    restGet: vi.fn(async () => ({ permission: "write" })),
    createIssueComment: vi.fn(),
    replyToReviewComment: vi.fn(),
  } as unknown as GithubMentionLearningClient
}

function baseArgs(env: Env) {
  return {
    client: makeClient(),
    env,
    owner: "octo",
    repo: "repo",
    prNumber: 7,
    surface: "issue" as const,
    commentId: 100,
    sourceComment: SOURCE_COMMENT,
    repoId: 555_000,
    question: "should we always use named exports here?",
    baseReplyBody: "Yes, named exports are preferred.",
    threadRootId: 100,
    post: vi.fn(async () => 200),
  }
}

describe("postGithubMentionQaReply — Seat∪Org memory layering org-mirror wiring", () => {
  beforeEach(() => {
    vi.mocked(extractLearning).mockResolvedValue({ rule: "use named exports", polarity: "require" })
  })
  afterEach(() => {
    vi.mocked(extractLearning).mockReset()
  })

  it("flag off (default) — only the repo-scope entry is written; org keyspace untouched", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv) // OPENCLAW_ORG_MEMORY_CAPTURE unset
    await postGithubMentionQaReply(baseArgs(env))

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
    await postGithubMentionQaReply(baseArgs(env))

    expect(store.has(REPO_KEY)).toBe(true)
    const repoStore = JSON.parse(store.get(REPO_KEY)!)
    const repoEntry = repoStore.entries[0]

    const orgKey = learningsKey("org", "777")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("777")
    const orgEntry = orgStore.entries[0]

    expect(orgEntry.id).toBe(repoEntry.id)
    expect(orgEntry.rule).toBe(repoEntry.rule)
    expect(orgEntry.polarity).toBe(repoEntry.polarity)
    expect(orgEntry.type).toBe(repoEntry.type)
    expect(orgEntry.scope).toBe("org")
    expect(orgEntry.subjectId).toBe("777")
  })

  it("flag on + unresolvable installation — repo write still happens, org write skipped, no throw, reply still posted", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, {
      OPENCLAW_ORG_MEMORY_CAPTURE: "on",
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "someone-else/other": 1 }),
    })
    const args = baseArgs(env)
    await expect(postGithubMentionQaReply(args)).resolves.toBe(200)

    expect(store.has(REPO_KEY)).toBe(true)
    const orgKeys = Array.from(store.keys()).filter((k) => k.startsWith("learnings:org:"))
    expect(orgKeys).toHaveLength(0)
    expect(args.post).toHaveBeenCalledTimes(1)
  })

  it("regression guard: the repo-scope entry is byte-identical whether the flag is on or off", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"))
    try {
      const offRun = makeKv()
      await postGithubMentionQaReply(baseArgs(makeEnv(offRun.kv)))

      const onRun = makeKv()
      await postGithubMentionQaReply(
        baseArgs(
          makeEnv(onRun.kv, {
            OPENCLAW_ORG_MEMORY_CAPTURE: "on",
            OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 777 }),
          }),
        ),
      )

      expect(onRun.store.get(REPO_KEY)).toBe(offRun.store.get(REPO_KEY))
    } finally {
      vi.useRealTimers()
    }
  })
})
