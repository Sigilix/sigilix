// Stale-head guard for handlePrReview: when synchronize-driven
// re-reviews queue jobs faster than Ollama processes them, a slow job
// for SHA A can finish AFTER SHA B's job has posted. The guard at
// triage-pr-review.ts:150 skips the job when the PR head has moved.
//
// This file is dedicated to the guard so module-level vi.mock calls
// don't pollute the pure-helper tests in triage-pr-review.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn(async () => "fake diff")
const mockSubmitReview = vi.fn()
const mockGenerate = vi.fn()
// ARC-182: stack-detection adds a parallel `listOpenPullRequests` call.
// Default to empty list (no-stack review) so the existing stale-head
// guard tests are unaffected.
const mockListOpenPullRequests = vi.fn(async () => [])
const mockListPullRequestFiles = vi.fn(async () => [])

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

function makeKvStub(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string>; deletes: string[] } {
  const store = new Map<string, string>()
  const deletes: string[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      deletes.push(key)
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, deletes }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    OLLAMA_API_KEY: "fake-ollama",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

beforeEach(() => {
  // mockClear (not mockReset) — preserves the implementation set by the
  // module-level vi.mock factory. mockReset would wipe it and the next
  // test's `mockResolvedValue(...)` call would still leave the function
  // behaving as if the underlying constructor returns undefined.
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockSubmitReview.mockClear()
  mockGenerate.mockClear()
})

describe("handlePrReview stale-head guard", () => {
  it("skips the job when the PR head has moved past the queued SHA", async () => {
    const queuedSha = "aaaaaaa1111111111111111111111111111aaaa"
    const currentSha = "bbbbbbb2222222222222222222222222222bbbb"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: { sha: currentSha, ref: "feature" },
    })
    const { kv, store, deletes } = makeKvStub()

    await handlePrReview({
      owner: "Arc-and-Anchor",
      repo: "openclaw-worker",
      prNumber: 99,
      headSha: queuedSha,
      installationId: 1,
      env: makeEnv(kv),
    })

    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockSubmitReview).not.toHaveBeenCalled()
    // The finally block releases the dedupe key when posted=false, so a
    // queue retry could re-attempt — and on retry the head would still
    // be ahead, so we'd skip again. Confirm release happened.
    const dedupeKey = `pr-review:Arc-and-Anchor/openclaw-worker#99@${queuedSha}`
    expect(deletes).toContain(dedupeKey)
    expect(store.has(dedupeKey)).toBe(false)
  })

  it("proceeds past the guard when the PR head matches the queued SHA", async () => {
    const queuedSha = "ccccccc3333333333333333333333333333cccc"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: { sha: queuedSha, ref: "feature" },
    })
    // Force a parse failure AFTER the guard so we don't have to mock
    // the entire submit chain — we only need to prove generate() WAS
    // called (i.e. control flow passed the guard).
    mockGenerate.mockResolvedValue("not-valid-json")
    const { kv } = makeKvStub()

    await expect(
      handlePrReview({
        owner: "Arc-and-Anchor",
        repo: "openclaw-worker",
        prNumber: 99,
        headSha: queuedSha,
        installationId: 1,
        env: makeEnv(kv),
      }),
    ).rejects.toThrow(/verdict did not parse/)

    expect(mockGenerate).toHaveBeenCalledTimes(1)
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it("proceeds past the guard when meta.head is missing (defensive)", async () => {
    const queuedSha = "ddddddd4444444444444444444444444444dddd"
    mockGetPullRequest.mockResolvedValue({
      title: "test",
      body: null,
      head: undefined,
    })
    mockGenerate.mockResolvedValue("not-valid-json")
    const { kv } = makeKvStub()

    await expect(
      handlePrReview({
        owner: "Arc-and-Anchor",
        repo: "openclaw-worker",
        prNumber: 99,
        headSha: queuedSha,
        installationId: 1,
        env: makeEnv(kv),
      }),
    ).rejects.toThrow(/verdict did not parse/)

    // No meta.head.sha to compare → guard does NOT fire → generate runs.
    expect(mockGenerate).toHaveBeenCalledTimes(1)
  })
})
