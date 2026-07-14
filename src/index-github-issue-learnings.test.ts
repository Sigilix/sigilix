// feat/github-issue-learnings-capture: e2e coverage for capturing @sigilix
// Learnings instructions from GENUINE (non-PR) GitHub Issue comments.
//
// Drives the REAL webhook entry `handleGitHubWebhook` with an `issue_comment`
// payload whose `issue` has NO `pull_request` block (a real Issue, not a PR).
// Only the network edges are mocked (webhook verify, installation token, and
// the GitHub REST client); the learnings capture path itself is real —
// `dispatchIssueCommentLearningsCapture` → `handleGithubMentionLearningsCommand`
// → `appendLearning` → KV write. So if the webhook wiring were reverted the
// KV write never happens and these tests fail (revert-safety).
//
// Coverage:
//   (a) `@sigilix remember …` on a non-PR Issue comment → repo-scope learning
//       written (subjectId === repo.id), confirmation reply posted.
//   (b) a non-@mention Issue comment → NO learning written, no reply posted.
//   (c) OPENCLAW_LEARNINGS_MODE unset/off → dark, NO learning written.
//   (d) a non-command @mention (instructive correction) → QA auto-learning
//       captured DURABLY (not PR-ephemeral), since an Issue is not a PR.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import { extractLearning } from "@/src/features/learnings"

// ── mocks must precede the import of the module under test ───────────────────

// Learnings feature barrel — real everything EXCEPT the QA extractor model call
// (`extractLearning`), which we stub per-test to exercise the instructive-
// correction path without a live LLM.
vi.mock("@/src/features/learnings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/learnings")>()
  return { ...actual, extractLearning: vi.fn() }
})

// Webhook signature verify → always valid (mirrors the Linear webhook test's
// approach; the HMAC itself is not what we're exercising here).
vi.mock("@/src/index-scm-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/index-scm-provider")>()
  return {
    ...actual,
    selectScmProvider: (() => ({
      verifyWebhook: async () => true,
    })) as unknown as typeof actual.selectScmProvider,
  }
})

// Installation token → constant; no real GitHub App JWT exchange.
vi.mock("@/src/shared/adapters/github/github-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/shared/adapters/github/github-app")>()
  return { ...actual, getInstallationToken: vi.fn(async () => "test-installation-token") }
})

// GitHub REST client → fake with just the two methods the remember path uses:
// `restGet` (drives hasRepoWriteAccess → "write") and `createIssueComment`
// (the confirmation reply). All other exports preserved.
const createIssueComment = vi.fn(async () => ({ id: 4242 }))
const restGet = vi.fn(async () => ({ permission: "write" }))
vi.mock("@/src/shared/adapters/github", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/shared/adapters/github")>()
  class FakeGitHubClient {
    createIssueComment = createIssueComment
    restGet = restGet
  }
  return { ...actual, GitHubClient: FakeGitHubClient as unknown as typeof actual.GitHubClient }
})

import { handleGitHubWebhook } from "@/src/index-github-webhook"

// ── fakes ────────────────────────────────────────────────────────────────────
const REPO_ID = 55_500
const REPO_KEY = learningsKey("repo", String(REPO_ID))

function makeKv(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"], over: Partial<Env> = {}): Env {
  return {
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: "private-key",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    OPENCLAW_STATE: kv,
    OPENCLAW_LEARNINGS_MODE: "on",
    ...over,
  } as unknown as Env
}

// ctx whose waitUntil actually retains the background promises so the test can
// await the capture before asserting on KV.
function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Array<Promise<unknown>> = []
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(Promise.resolve(p))
    },
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext
  return { ctx, settled: async () => void (await Promise.all(pending)) }
}

function issueCommentRequest(body: Record<string, unknown>): Request {
  return new Request("https://worker.example.com/github/webhook", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-hub-signature-256": "sha256=stub",
      "x-github-delivery": "delivery-issue-learnings",
    }),
    body: JSON.stringify(body),
  })
}

function issueCommentPayload(commentBody: string): Record<string, unknown> {
  return {
    action: "created",
    installation: { id: 12_345 },
    repository: { id: REPO_ID, name: "repo", owner: { login: "octo" } },
    // NO `pull_request` key → a genuine Issue, not a PR conversation.
    issue: { number: 7 },
    comment: {
      id: 900,
      body: commentBody,
      user: { login: "octocat" },
      author_association: "MEMBER",
    },
  }
}

type StoredLearning = {
  rule: string
  scope: string
  subjectId: string
  type?: string
  lifespanAnchor?: { kind: string }
}

function repoLearnings(store: Map<string, string>): StoredLearning[] {
  const raw = store.get(REPO_KEY)
  if (!raw) return []
  return (JSON.parse(raw) as { entries?: StoredLearning[] }).entries ?? []
}

// ── tests ────────────────────────────────────────────────────────────────────
describe("handleGitHubWebhook — Learnings capture from genuine Issue comments", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("(a) @sigilix remember on a non-PR Issue comment writes a repo-scope learning + posts a reply", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv)
    const { ctx, settled } = makeCtx()

    const res = await handleGitHubWebhook(
      issueCommentRequest(issueCommentPayload("@sigilix remember always use named exports")),
      env,
      ctx,
    )
    await settled()

    expect(res.status).toBe(200)
    const entries = repoLearnings(store)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.rule).toBe("always use named exports")
    expect(entries[0]?.scope).toBe("repo")
    // subjectId is strictly the immutable repo.id from the trusted payload.
    expect(entries[0]?.subjectId).toBe(String(REPO_ID))
    expect(createIssueComment).toHaveBeenCalledTimes(1)
  })

  it("(b) a non-@mention Issue comment captures NOTHING and posts no reply", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv)
    const { ctx, settled } = makeCtx()

    const res = await handleGitHubWebhook(
      issueCommentRequest(issueCommentPayload("thanks, this looks good to me")),
      env,
      ctx,
    )
    await settled()

    expect(res.status).toBe(200)
    expect(repoLearnings(store)).toHaveLength(0)
    expect(createIssueComment).not.toHaveBeenCalled()
    expect(restGet).not.toHaveBeenCalled()
  })

  it("(c) ships dark: OPENCLAW_LEARNINGS_MODE off → @sigilix remember captures nothing", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, { OPENCLAW_LEARNINGS_MODE: "off" })
    const { ctx, settled } = makeCtx()

    const res = await handleGitHubWebhook(
      issueCommentRequest(issueCommentPayload("@sigilix remember always use named exports")),
      env,
      ctx,
    )
    await settled()

    expect(res.status).toBe(200)
    expect(repoLearnings(store)).toHaveLength(0)
    expect(createIssueComment).not.toHaveBeenCalled()
  })

  it("(d) an instructive @mention (non-command) captures a DURABLE learning — not PR-ephemeral", async () => {
    vi.mocked(extractLearning).mockResolvedValue({ rule: "always run prettier before pushing", polarity: "require" })
    const { kv, store } = makeKv()
    const env = makeEnv(kv)
    const { ctx, settled } = makeCtx()

    const res = await handleGitHubWebhook(
      issueCommentRequest(issueCommentPayload("@sigilix we always run prettier before pushing here")),
      env,
      ctx,
    )
    await settled()

    expect(res.status).toBe(200)
    const entries = repoLearnings(store)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.rule).toBe("always run prettier before pushing")
    expect(entries[0]?.subjectId).toBe(String(REPO_ID))
    // An Issue is not a PR: the QA path must NOT anchor the learning to a PR
    // lifecycle. Reverting the `prNumber` omission regresses these to
    // ephemeral_project / { kind: "pr" }.
    expect(entries[0]?.type).toBe("durable_preference")
    expect(entries[0]?.lifespanAnchor?.kind).toBe("durable")
    // Capture-only on the Issue surface — no reply is posted.
    expect(createIssueComment).not.toHaveBeenCalled()
  })
})
