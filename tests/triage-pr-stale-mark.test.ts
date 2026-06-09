// ARC-184 — handlePrStaleMark unit tests.
//
// Mocks GitHub client + KV so the handler is exercised in isolation.
// Covers every branch in spec §6 + §9: missing/invalid manifest,
// superseded snapshot, head-match short-circuit, drift detection,
// review-target PATCH, issue-comment-target PATCH, 404 target, 403/5xx
// PATCH errors, eventual-consistency retry, and idempotent re-apply.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "test-token")
const mockListPullFilesForManifest = vi.fn()
const mockGetMergeBase = vi.fn()
const mockGetReview = vi.fn()
const mockUpdateReviewBody = vi.fn()
const mockGetIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()

vi.mock("../src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("../src/shared/adapters/github")>("../src/shared/adapters/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      listPullFilesForManifest: (...args: unknown[]) => mockListPullFilesForManifest(...args),
      getMergeBase: (...args: unknown[]) => mockGetMergeBase(...args),
      getReview: (...args: unknown[]) => mockGetReview(...args),
      updateReviewBody: (...args: unknown[]) => mockUpdateReviewBody(...args),
      getIssueComment: (...args: unknown[]) => mockGetIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
    })),
  }
})

import { handlePrStaleMark } from "../src/lib/triage-pr-stale-mark"
import { writeReviewManifest, type ReviewManifestV1 } from "../src/lib/review-manifest"
import { GitHubHttpError } from "../src/shared/adapters/github"
import type { Env } from "../src/shared/types/env"

function makeKvStub() {
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

function makeEnv(kv: Env["OPENCLAW_STATE"], extras: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    ...extras,
  } as unknown as Env
}

const baseManifest = (over: Partial<ReviewManifestV1> = {}): ReviewManifestV1 => ({
  v: 1,
  prNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  mergeBaseSha: "m".repeat(40),
  fileListHash: "f".repeat(64),
  promptVersion: "1",
  modelId: "test-model",
  target: { kind: "review", reviewId: 4242 },
  reviewedAt: 1000,
  ...over,
})

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListPullFilesForManifest.mockClear()
  mockGetMergeBase.mockClear()
  mockGetReview.mockClear()
  mockUpdateReviewBody.mockClear()
  mockGetIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
})

const baseArgs = (
  env: Env,
  manifest: ReviewManifestV1,
  override: Partial<Parameters<typeof handlePrStaleMark>[0]> = {},
): Parameters<typeof handlePrStaleMark>[0] => ({
  env,
  owner: "acme",
  repo: "site",
  prNumber: 7,
  installationId: 1,
  manifestSnapshot: manifest,
  newHeadSha: "n".repeat(40),
  newBaseSha: "p".repeat(40),
  currentPromptVersion: "1",
  ...override,
})

describe("handlePrStaleMark — pre-flight", () => {
  it("no-ops + emits review-manifest-missing when no manifest in KV", async () => {
    const { kv } = makeKvStub() // empty
    const consoleLogs: string[] = []
    const orig = console.log
    console.log = (m: string) => consoleLogs.push(typeof m === "string" ? m : JSON.stringify(m))
    try {
      await handlePrStaleMark(baseArgs(makeEnv(kv), baseManifest()))
    } finally {
      console.log = orig
    }
    expect(consoleLogs.some((l) => l.includes("review-manifest-missing"))).toBe(true)
    expect(mockGetReview).not.toHaveBeenCalled()
  })

  it("no-ops when manifest is invalid", async () => {
    const { kv } = makeKvStub()
    await kv.put("pr-review-manifest:acme/site#7", "{not json")
    const logs: string[] = []
    const orig = console.log
    console.log = (m: string) => logs.push(typeof m === "string" ? m : JSON.stringify(m))
    try {
      await handlePrStaleMark(baseArgs(makeEnv(kv), baseManifest()))
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes("review-manifest-invalid"))).toBe(true)
  })

  it("no-ops + emits review-stale-superseded when KV manifest is newer than the snapshot", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const newer = baseManifest({ reviewedAt: 9999 })
    await writeReviewManifest(env, "acme", "site", 7, newer)
    const snapshot = baseManifest({ reviewedAt: 1000 })
    const logs: string[] = []
    const orig = console.log
    console.log = (m: string) => logs.push(typeof m === "string" ? m : JSON.stringify(m))
    try {
      await handlePrStaleMark(baseArgs(env, snapshot))
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes("review-stale-superseded"))).toBe(true)
    expect(mockGetReview).not.toHaveBeenCalled()
  })

  it("short-circuits when kill-switch OPENCLAW_REVIEW_MANIFEST_ENABLED=off", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, { OPENCLAW_REVIEW_MANIFEST_ENABLED: "off" })
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    await handlePrStaleMark(baseArgs(env, baseManifest()))
    expect(mockListPullFilesForManifest).not.toHaveBeenCalled()
  })
})

describe("handlePrStaleMark — drift detection", () => {
  it("returns review-stale-not-detected when head SHA matches (short-circuit)", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const m = baseManifest()
    await writeReviewManifest(env, "acme", "site", 7, m)
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "foo.ts", previous_filename: null, status: "modified" }],
    })
    const logs: string[] = []
    const orig = console.log
    console.log = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, m, { newHeadSha: m.headSha }))
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes("review-stale-not-detected"))).toBe(true)
    expect(mockGetReview).not.toHaveBeenCalled()
  })
})

describe("handlePrStaleMark — review-target PATCH", () => {
  it("PATCHes the prior review body when drift is detected", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const m = baseManifest()
    await writeReviewManifest(env, "acme", "site", 7, m)
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "src/foo.ts", previous_filename: null, status: "modified" }],
    })
    mockGetReview.mockResolvedValue({ body: "<!-- sigilix:pr-review -->\n\n### Sigilix Summary\n\nLooks good." })

    await handlePrStaleMark(baseArgs(env, m))

    expect(mockUpdateReviewBody).toHaveBeenCalledOnce()
    const args = mockUpdateReviewBody.mock.calls[0]
    expect(args[3]).toBe(4242) // reviewId
    expect(args[4]).toContain("<!-- sigilix:stale-marker:start -->")
    expect(args[4]).toContain("This review is stale")
  })

  it("emits review-stale-marked telemetry on success", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetReview.mockResolvedValue({ body: "<!-- sigilix:pr-review -->\n\nbody" })

    const logs: string[] = []
    const orig = console.log
    console.log = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, baseManifest()))
    } finally {
      console.log = orig
    }
    const marked = logs.find((l) => l.includes("review-stale-marked"))
    expect(marked).toBeDefined()
    expect(marked).toContain('"target":{"kind":"review","id":4242}')
  })

  it("returns review-stale-target-missing on 404 from getReview", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetReview.mockResolvedValue(null)

    const logs: string[] = []
    const orig = console.log
    console.log = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, baseManifest()))
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes("review-stale-target-missing"))).toBe(true)
    expect(mockUpdateReviewBody).not.toHaveBeenCalled()
  })
})

describe("handlePrStaleMark — issue-comment-target PATCH", () => {
  const m = baseManifest({ target: { kind: "issue-comment", commentId: 999 } })

  it("PATCHes the prior issue-comment body when drift is detected", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, m)
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetIssueComment.mockResolvedValue({ body: "<!-- sigilix:pr-review -->\n\n### Sigilix\nbody" })

    await handlePrStaleMark(baseArgs(env, m))

    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    const args = mockUpdateIssueComment.mock.calls[0]
    expect(args[2]).toBe(999) // commentId
    expect(args[3]).toContain("<!-- sigilix:stale-marker:start -->")
  })

  it("returns review-stale-target-missing on 404 from getIssueComment", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, m)
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetIssueComment.mockResolvedValue(null)

    const logs: string[] = []
    const orig = console.log
    console.log = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, m))
    } finally {
      console.log = orig
    }
    expect(logs.some((l) => l.includes("review-stale-target-missing"))).toBe(true)
  })
})

describe("handlePrStaleMark — failures + retries", () => {
  it("bubbles 5xx for queue retry", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetReview.mockResolvedValue({ body: "<!-- sigilix:pr-review -->\n\nbody" })
    mockUpdateReviewBody.mockRejectedValue(new GitHubHttpError(503, "Service Unavailable"))

    await expect(handlePrStaleMark(baseArgs(env, baseManifest()))).rejects.toBeInstanceOf(GitHubHttpError)
  })

  it("does NOT retry on 403 (operator-visible permission gap)", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    mockGetReview.mockResolvedValue({ body: "<!-- sigilix:pr-review -->\n\nbody" })
    mockUpdateReviewBody.mockRejectedValue(new GitHubHttpError(403, "Forbidden"))

    const errs: string[] = []
    const origErr = console.error
    console.error = (msg: string) => errs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, baseManifest()))
    } finally {
      console.error = origErr
    }
    const failed = errs.find((l) => l.includes("review-stale-mark-failed"))
    expect(failed).toBeDefined()
    expect(failed).toContain('"status":403')
  })

  it("retries empty file list up to 3 times then aborts", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    await writeReviewManifest(env, "acme", "site", 7, baseManifest())
    mockListPullFilesForManifest.mockResolvedValue({ overflow: false, entries: [] })

    const logs: string[] = []
    const origLog = console.log
    const origErr = console.error
    console.log = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    console.error = (msg: string) => logs.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    try {
      await handlePrStaleMark(baseArgs(env, baseManifest()))
    } finally {
      console.log = origLog
      console.error = origErr
    }
    const retries = logs.filter((l) => l.includes("review-stale-current-state-empty-retry"))
    expect(retries.length).toBe(3)
    expect(logs.some((l) => l.includes("empty-files-after-retry"))).toBe(true)
    expect(mockGetReview).not.toHaveBeenCalled()
  }, 15000)

  it("MARKER ROUND-TRIP REGRESSION: re-applying on a body with an existing stale block doesn't accumulate markers", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const m = baseManifest()
    await writeReviewManifest(env, "acme", "site", 7, m)
    mockListPullFilesForManifest.mockResolvedValue({
      overflow: false,
      entries: [{ filename: "x.ts", previous_filename: null, status: "modified" }],
    })
    const priorBody = [
      "<!-- sigilix:pr-review -->",
      "",
      "<!-- sigilix:stale-marker:start -->",
      "> [!WARNING]",
      "> **This review is stale.** Reviewed head `aaaaaaa` against base `bbbbbbb`. PR is now at `ccccccc` against base `ddddddd`. Run `/sigilix review` to re-review the current diff, or wait — Sigilix will refresh on the next push.",
      "<!-- sigilix:stale-marker:end -->",
      "",
      "### Sigilix Summary",
      "Looks good.",
    ].join("\n")
    mockGetReview.mockResolvedValue({ body: priorBody })

    await handlePrStaleMark(baseArgs(env, m))

    expect(mockUpdateReviewBody).toHaveBeenCalledOnce()
    const newBody = mockUpdateReviewBody.mock.calls[0][4] as string
    const startMatches = newBody.match(/sigilix:stale-marker:start/g) ?? []
    const endMatches = newBody.match(/sigilix:stale-marker:end/g) ?? []
    expect(startMatches.length).toBe(1)
    expect(endMatches.length).toBe(1)
  })
})
