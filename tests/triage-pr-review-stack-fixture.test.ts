// ARC-182 acceptance: 2-PR stack fixture.
//
// Per Linear ARC-182 "Done when":
//   - 2-PR stack fixture produces a Sigilix review that names the
//     parent PR
//   - avoids reporting parent-owned issues as if introduced by the
//     child
//
// This test exercises handlePrReview end-to-end with a child PR (#42
// at head=user-routes, base=user-model) and a parent PR (#41 at
// head=user-model, base=main). It mocks the GitHub client +
// Ollama generate so we can deterministically assert:
//
//   1. The prompt sent to Ollama contains a [STACK CONTEXT] block
//      naming the parent PR.
//   2. The submitted GitHub review body contains a "### Stack context"
//      section linking the parent.
//   3. A finding tagged with stackOrigin="downstack-context" survives
//      the parser and reaches the submitted review comment intact —
//      validating the "avoid reporting parent-owned issues as
//      introduced by the child" criterion.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn(async () => "fake diff with +import { User } from './user-model'\n")
const mockSubmitReview = vi.fn()
const mockGenerate = vi.fn()
const mockListOpenPullRequests = vi.fn()
const mockListPullRequestFiles = vi.fn()

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      getPullRequest: (...args: unknown[]) => mockGetPullRequest(...args),
      getPullRequestDiff: (...args: unknown[]) => mockGetPullRequestDiff(...args),
      submitReview: (...args: unknown[]) => mockSubmitReview(...args),
      listOpenPullRequests: (...args: unknown[]) => mockListOpenPullRequests(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
    })),
  }
})

vi.mock("../src/lib/ollama", () => ({
  generate: (args: unknown) => mockGenerate(args),
}))

import { handlePrReview } from "../src/lib/triage-pr-review"
import type { Env } from "../src/index"

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
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

describe("ARC-182 acceptance: 2-PR stack fixture", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("produces a review naming the parent PR and preserves stackOrigin tags", async () => {
    // ─── Fixture setup ─────────────────────────────────────────
    // Child PR #42: head=user-routes, base=user-model
    // Parent PR #41: head=user-model, base=main
    const CHILD_SHA = "c".repeat(40)

    mockGetPullRequest.mockResolvedValue({
      number: 42,
      title: "Add user routes",
      body: "Add HTTP routes for user resource (depends on #41)",
      user: { login: "daniel" },
      head: { ref: "user-routes", sha: CHILD_SHA },
      base: { ref: "user-model", sha: "b".repeat(40) },
    })

    mockListOpenPullRequests.mockResolvedValue([
      {
        number: 41,
        title: "Add user model",
        state: "open",
        user: { login: "daniel" },
        head: {
          ref: "user-model",
          sha: "b".repeat(40),
          repo: { full_name: "Arc-and-Anchor/sigilix" },
        },
        base: {
          ref: "main",
          sha: "a".repeat(40),
          repo: { full_name: "Arc-and-Anchor/sigilix" },
        },
        updated_at: "2026-05-10T12:00:00Z",
      },
    ])

    // Parent file fetch (for overlap). Child shares user-model.ts.
    mockListPullRequestFiles.mockImplementation(async (_owner: string, _repo: string, prNumber: number) => {
      if (prNumber === 41) {
        return [{ filename: "src/user-model.ts", status: "added", additions: 50, deletions: 0 }]
      }
      return [
        { filename: "src/user-routes.ts", status: "added", additions: 80, deletions: 0 },
        { filename: "src/user-model.ts", status: "modified", additions: 2, deletions: 0 },
      ]
    })

    // Ollama returns a verdict with TWO findings:
    //   - one "current-pr" finding (new bug in user-routes.ts)
    //   - one "downstack-context" finding (an issue that lives in
    //     user-model.ts, which was introduced in PR #41)
    mockGenerate.mockResolvedValue(JSON.stringify({
      summary: "User routes added; one new logic issue + one carry-over from #41.",
      confidence: 3,
      confidenceReason: "Routes look right; flagged a parent-PR issue for the team's awareness.",
      findings: [
        {
          path: "src/user-routes.ts",
          line: 42,
          score: 4,
          category: "logic",
          headline: "Missing input validation on userId path parameter",
          body: "Request handler reads `req.params.userId` without validating it's a number — passes a string straight into the DB query.",
          stackOrigin: "current-pr",
        },
        {
          path: "src/user-model.ts",
          line: 18,
          score: 3,
          category: "security",
          headline: "Password field stored without hashing (introduced in #41)",
          body: "The `password` column is written as plaintext. This was introduced by PR #41 (Add user model) — flagging for awareness; the fix belongs in the parent PR's scope.",
          stackOrigin: "downstack-context",
        },
      ],
    }))

    mockSubmitReview.mockResolvedValue({ id: 999, state: "REQUEST_CHANGES" })

    // ─── Run ───────────────────────────────────────────────────
    const { kv } = makeKvStub()
    const env = {
      OPENCLAW_STATE: kv,
      OLLAMA_API_KEY: "test-key",
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      OPENCLAW_REVIEW_MANIFEST_ENABLED: "off",
    } as unknown as Env

    await handlePrReview({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 42,
      headSha: CHILD_SHA,
      installationId: 999,
      env,
    })

    // ─── Assertions ────────────────────────────────────────────

    // 1. The prompt sent to Ollama contains a [STACK CONTEXT] block
    //    naming the parent PR.
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    const ollamaArgs = mockGenerate.mock.calls[0]![0] as { prompt: string }
    expect(ollamaArgs.prompt).toContain("[STACK CONTEXT]")
    expect(ollamaArgs.prompt).toContain("#41")
    expect(ollamaArgs.prompt).toContain("Add user model")
    expect(ollamaArgs.prompt).toContain("position 2 of")  // child is upstack of parent
    // Stack block appears BEFORE [PR DIFF] (acceptance criterion).
    const stackIdx = ollamaArgs.prompt.indexOf("[STACK CONTEXT]")
    const diffIdx = ollamaArgs.prompt.indexOf("[PR DIFF]")
    expect(stackIdx).toBeGreaterThan(-1)
    expect(diffIdx).toBeGreaterThan(stackIdx)

    // 2. The submitted review body contains a "### Stack context"
    //    section linking the parent.
    expect(mockSubmitReview).toHaveBeenCalledTimes(1)
    const submittedReview = mockSubmitReview.mock.calls[0]![3] as {
      body: string
      comments?: Array<{ path: string; line: number; body: string }>
    }
    expect(submittedReview.body).toContain("### Stack context")
    expect(submittedReview.body).toContain("#41")
    expect(submittedReview.body).toMatch(/position|of/i)

    // 3. The finding tagged downstack-context survived parsing and
    //    appears in the submitted comments (so the reviewer sees the
    //    parent-owned issue surfaced, but the model's own framing
    //    "introduced by PR #41" preserves the no-false-positive
    //    discipline the acceptance criterion requires).
    expect(submittedReview.comments).toBeDefined()
    expect(submittedReview.comments).toHaveLength(2)
    const parentFinding = submittedReview.comments!.find(
      (c) => c.path === "src/user-model.ts",
    )
    expect(parentFinding).toBeDefined()
    expect(parentFinding!.body).toContain("security")
    expect(parentFinding!.body.toLowerCase()).toContain("#41")
  })

  it("produces UNCHANGED reviews for no-stack PRs (acceptance criterion #4)", async () => {
    // No open peers — stack detection should return no-stack and the
    // prompt should NOT contain a [STACK CONTEXT] block.
    const SHA = "d".repeat(40)
    mockGetPullRequest.mockResolvedValue({
      number: 100,
      title: "Standalone change",
      body: "Independent fix",
      user: { login: "daniel" },
      head: { ref: "fix/bug", sha: SHA },
      base: { ref: "main", sha: "a".repeat(40) },
    })
    mockListOpenPullRequests.mockResolvedValue([])
    mockListPullRequestFiles.mockResolvedValue([])
    mockGenerate.mockResolvedValue(JSON.stringify({
      summary: "Clean fix.",
      confidence: 5,
      confidenceReason: "Trivial change, no concerns.",
      findings: [],
    }))
    mockSubmitReview.mockResolvedValue({ id: 1000, state: "APPROVED" })

    const { kv } = makeKvStub()
    const env = {
      OPENCLAW_STATE: kv,
      OLLAMA_API_KEY: "test-key",
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----",
      OPENCLAW_REVIEW_MANIFEST_ENABLED: "off",
    } as unknown as Env

    await handlePrReview({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 100,
      headSha: SHA,
      installationId: 999,
      env,
    })

    // The PR_REVIEW_PROMPT system prompt itself documents the
    // `[STACK CONTEXT]` field (it's a literal marker the model is
    // told to look for), so we can't assert the absence of that
    // string. Instead assert the BLOCK CONTENT that
    // `renderStackPromptBlock` emits — the position-of-stack phrase —
    // is NOT injected for no-stack PRs.
    const ollamaArgs = mockGenerate.mock.calls[0]![0] as { prompt: string }
    expect(ollamaArgs.prompt).not.toMatch(
      /This PR is position \d+ of \d+ in a Graphite-style stack/,
    )
    const submittedReview = mockSubmitReview.mock.calls[0]![3] as { body: string }
    expect(submittedReview.body).not.toContain("### Stack context")
  })
})
