// ARC-184 — manifest-write integration coverage for handlePrReview.
//
// Mocks every external dependency (GitHub client, Ollama, github-app
// auth) so the test exercises only the orchestration path inside
// handlePrReview that runs after a successful submitReview. Asserts
// the full manifest shape per Linear AC #1 (every field set) and the
// success-path telemetry event.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockGetPullRequest = vi.fn()
const mockGetPullRequestDiff = vi.fn(async () => "fake diff")
const mockSubmitReview = vi.fn()
const mockListPullFilesForManifest = vi.fn()
const mockGetMergeBase = vi.fn()
const mockGenerate = vi.fn()

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
      listPullFilesForManifest: (...args: unknown[]) => mockListPullFilesForManifest(...args),
      getMergeBase: (...args: unknown[]) => mockGetMergeBase(...args),
    })),
  }
})

vi.mock("../src/lib/ollama", () => ({
  generate: (args: unknown) => mockGenerate(args),
}))

import { handlePrReview } from "../src/lib/triage-pr-review"
import { readReviewManifest } from "../src/lib/review-manifest"
import { PROMPT_VERSION } from "../src/prompts/pr-review"
import type { Env } from "../src/index"

function makeKvStub() {
  const store = new Map<string, string>()
  const opts = new Map<string, unknown>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string, putOpts?: unknown): Promise<void> {
      store.set(key, value)
      if (putOpts) opts.set(key, putOpts)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, opts }
}

function makeEnv(kv: Env["OPENCLAW_STATE"], extras: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OLLAMA_API_KEY: "fake-ollama",
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    OPENCLAW_MODEL: "qwen3-coder:480b-cloud",
    ...extras,
  } as unknown as Env
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockGetPullRequest.mockClear()
  mockGetPullRequestDiff.mockClear()
  mockSubmitReview.mockClear()
  mockListPullFilesForManifest.mockClear()
  mockGetMergeBase.mockClear()
  mockGenerate.mockClear()
})

describe("handlePrReview — review manifest", () => {
  const goodMeta = {
    number: 7,
    title: "feat: x",
    body: "",
    user: { login: "alice" },
    head: { sha: "h".repeat(40) },
    base: { sha: "b".repeat(40), ref: "main" },
  }
  const goodVerdict = JSON.stringify({
    summary: "Looks good.",
    confidence: 5,
    confidenceReason: "Mechanical change.",
    findings: [],
  })

  it("writes the manifest with EVERY field set after a successful submitReview", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "src/foo.ts", previous_filename: null, status: "modified" }],
    })
    mockGetMergeBase.mockResolvedValue("m".repeat(40))

    const { kv, store } = makeKvStub()
    const env = makeEnv(kv)
    await handlePrReview({
      owner: "acme", repo: "site", prNumber: 7,
      headSha: "h".repeat(40),
      installationId: 1,
      env,
    })

    const result = await readReviewManifest(env, "acme", "site", 7)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    const m = result.manifest
    expect(m.v).toBe(1)
    expect(m.prNumber).toBe(7)
    expect(m.baseSha).toBe("b".repeat(40))
    expect(m.headSha).toBe("h".repeat(40))
    expect(m.mergeBaseSha).toBe("m".repeat(40))
    expect(m.fileListHash).toMatch(/^[0-9a-f]{64}$/)
    expect(m.promptVersion).toBe(PROMPT_VERSION)
    expect(m.modelId).toBe("qwen3-coder:480b-cloud")
    expect(m.target).toEqual({ kind: "review", reviewId: 4242 })
    expect(typeof m.reviewedAt).toBe("number")
    expect(store.has("pr-review-manifest:acme/site#7")).toBe(true)
  })

  it("emits the review-manifest-written telemetry event on success", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    mockListPullFilesForManifest.mockResolvedValue({ overflow: false, entries: [] })
    mockGetMergeBase.mockResolvedValue(null)

    const consoleLogs: string[] = []
    const origLog = console.log
    console.log = (msg: string) => consoleLogs.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    try {
      const { kv } = makeKvStub()
      await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env: makeEnv(kv),
      })
    } finally {
      console.log = origLog
    }

    const written = consoleLogs.find((l) => l.includes("review-manifest-written"))
    expect(written).toBeDefined()
    expect(written).toContain('"target":{"kind":"review","id":4242}')
  })

  it("does NOT write the manifest when OPENCLAW_REVIEW_MANIFEST_ENABLED=off (kill-switch)", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })

    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, { OPENCLAW_REVIEW_MANIFEST_ENABLED: "off" })
    await handlePrReview({
      owner: "acme", repo: "site", prNumber: 7,
      headSha: "h".repeat(40),
      installationId: 1,
      env,
    })

    expect(store.has("pr-review-manifest:acme/site#7")).toBe(false)
    expect(mockListPullFilesForManifest).not.toHaveBeenCalled()
  })

  it("review still succeeds when manifest write fails (best-effort, never blocks)", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    mockListPullFilesForManifest.mockRejectedValue(new Error("API throttled"))
    mockGetMergeBase.mockResolvedValue(null)

    const consoleErrors: string[] = []
    const origErr = console.error
    console.error = (msg: string) => consoleErrors.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    const { kv } = makeKvStub()
    try {
      await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env: makeEnv(kv),
      })
    } finally {
      console.error = origErr
    }

    expect(mockSubmitReview).toHaveBeenCalledOnce()
    const failed = consoleErrors.find((l) => l.includes("review-manifest-write-failed"))
    expect(failed).toBeDefined()
  })
})
