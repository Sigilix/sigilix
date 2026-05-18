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
// ARC-258 follow-up: post-submitReview verification. Originally
// verified via `getReview(id)`; PR #86 changed verify to use
// `listPullRequestReviews` so we catch PENDING-state silent
// rejects too. `mockGetReview` is kept for any test that exercises
// the stale-mark / manifest-read path (unrelated to verify).
const mockGetReview = vi.fn(async () => ({ body: "" }))
// Default to "review present + APPROVED" so existing happy-path
// tests don't have to wire it explicitly; per-test overrides set
// the empty/PENDING cases.
const mockListPullRequestReviews = vi.fn(async () => [
  { id: 4242, state: "APPROVED", user: { login: "sigilix[bot]" }, body: "" },
])
// PR #86: `dismissPriorSigilixReviews` runs after each successful
// submit. The manifest tests don't care about its side-effects;
// stub `dismissReview` so no per-test wiring is needed.
const mockDismissReview = vi.fn(async () => undefined)
const mockListPullFilesForManifest = vi.fn()
const mockGetMergeBase = vi.fn()
const mockGenerate = vi.fn()
// ARC-182: stack-detection adds a parallel `listOpenPullRequests`
// call (plus possible follow-up `listPullRequestFiles` for parent
// overlap). Default both to empty list so the manifest-write test is
// unaffected. CodeRabbit PR #72 minor: both also reset in beforeEach
// to prevent cross-test bleed.
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
      getReview: (...args: unknown[]) => mockGetReview(...args),
      listPullRequestReviews: (...args: unknown[]) => mockListPullRequestReviews(...args),
      dismissReview: (...args: unknown[]) => mockDismissReview(...args),
      listPullFilesForManifest: (...args: unknown[]) => mockListPullFilesForManifest(...args),
      getMergeBase: (...args: unknown[]) => mockGetMergeBase(...args),
      listOpenPullRequests: (...args: unknown[]) => mockListOpenPullRequests(...args),
      listPullRequestFiles: (...args: unknown[]) => mockListPullRequestFiles(...args),
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
  mockGetReview.mockReset().mockResolvedValue({ body: "" })
  mockListPullRequestReviews.mockReset().mockResolvedValue([
    { id: 4242, state: "APPROVED", user: { login: "sigilix[bot]" }, body: "" },
  ])
  mockDismissReview.mockReset().mockResolvedValue(undefined)
  mockListPullFilesForManifest.mockClear()
  mockGetMergeBase.mockClear()
  mockGenerate.mockClear()
  mockListOpenPullRequests.mockClear()
  mockListPullRequestFiles.mockClear()
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

// ARC-258 follow-up (PR #84 anomaly, refined PR #86) —
// post-submitReview verification.
//
// GitHub occasionally returns a valid-looking 2xx from
// `POST /pulls/{n}/reviews` without making the review publicly
// visible. Two failure modes seen:
//   1. (PR #84) the review id 404s on follow-up GET — never
//      persisted server-side at all.
//   2. (PR #86) the review id resolves via `getReview(id)` but is
//      in `PENDING` (draft) state, invisible to anyone but the
//      authoring App. The Reviews tab stays empty even though the
//      submit returned 2xx and the Check Run claimed "Review
//      posted".
//
// Both modes are caught by verifying against
// `listPullRequestReviews` (the public list excludes PENDING) and
// requiring the row to be present + in a non-PENDING state.
describe("handlePrReview — submitReview verification", () => {
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

  it("returns skipped + emits the not-persisted error when the review is absent from listPullRequestReviews (silent reject)", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    // GitHub claimed success but the review id never shows up in
    // the public Reviews tab.
    mockListPullRequestReviews.mockResolvedValue([])

    const consoleWarns: string[] = []
    const consoleErrors: string[] = []
    const origWarn = console.warn
    const origErr = console.error
    console.warn = (msg: string) => consoleWarns.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    console.error = (msg: string) => consoleErrors.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    // CodeRabbit MAJOR catch on this PR: read the manifest from the
    // SAME KV the handler wrote to — `makeKvStub()` on its own
    // returns a fresh empty store, which would make the assertion
    // pass vacuously even if the handler wrote a manifest.
    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    let result: { status: string } | undefined
    try {
      result = await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env,
      })
    } finally {
      console.warn = origWarn
      console.error = origErr
    }

    expect(mockSubmitReview).toHaveBeenCalledOnce()
    expect(mockListPullRequestReviews).toHaveBeenCalledWith("acme", "site", 7)
    expect(result?.status).toBe("skipped")
    const missingWarn = consoleWarns.find((l) => l.includes("pr-review-verify-missing"))
    expect(missingWarn).toBeDefined()
    expect(missingWarn).toContain('"submit_path":"phase3"')
    expect(missingWarn).toContain('"submitted_state":"APPROVED"')
    expect(missingWarn).toContain('"list_size":0')
    const errLine = consoleErrors.find((l) => l.includes("pr-review-submit-not-persisted"))
    expect(errLine).toBeDefined()
    expect(errLine).toContain('"claimed_review_id":4242')
    expect(errLine).toContain('"submit_path":"phase3"')
    // Manifest must NOT be written for a non-persisted review.
    const result2 = await readReviewManifest(env, "acme", "site", 7)
    expect(result2.kind).toBe("missing")
  })

  // PR #86 reproduced this case: the just-submitted review is
  // present in `listPullRequestReviews` but in `PENDING` (draft)
  // state — invisible publicly. We must treat this the same as a
  // missing review.
  it("returns skipped when the just-submitted review is present but in PENDING state (silent draft)", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    mockListPullRequestReviews.mockResolvedValue([
      { id: 4242, state: "PENDING", user: { login: "sigilix[bot]" }, body: "" },
    ])

    const consoleWarns: string[] = []
    const consoleErrors: string[] = []
    const origWarn = console.warn
    const origErr = console.error
    console.warn = (msg: string) => consoleWarns.push(typeof msg === "string" ? msg : JSON.stringify(msg))
    console.error = (msg: string) => consoleErrors.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    let result: { status: string } | undefined
    try {
      result = await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env,
      })
    } finally {
      console.warn = origWarn
      console.error = origErr
    }

    expect(result?.status).toBe("skipped")
    const pendingWarn = consoleWarns.find((l) => l.includes("pr-review-verify-pending"))
    expect(pendingWarn).toBeDefined()
    expect(pendingWarn).toContain('"submit_path":"phase3"')
    // `submitted_state` is the state the POST returned ("APPROVED"
    // here) — the smoking-gun shape is POST=APPROVED + list=PENDING.
    expect(pendingWarn).toContain('"submitted_state":"APPROVED"')
    const errLine = consoleErrors.find((l) => l.includes("pr-review-submit-not-persisted"))
    expect(errLine).toBeDefined()
    // Manifest must NOT be written for a draft-only review.
    const manifest = await readReviewManifest(env, "acme", "site", 7)
    expect(manifest.kind).toBe("missing")
  })

  it("treats listPullRequestReviews throws as 'review verified' (transient blip; don't false-negative a real submit)", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    // Transient 5xx / network blip — verify can't determine.
    mockListPullRequestReviews.mockRejectedValue(new Error("HTTP 503 Service Unavailable"))
    mockListPullFilesForManifest.mockResolvedValue({ overflow: false, entries: [] })
    mockGetMergeBase.mockResolvedValue(null)

    const consoleWarns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => consoleWarns.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    let result: { status: string } | undefined
    try {
      result = await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env,
      })
    } finally {
      console.warn = origWarn
    }

    // Submit proceeds (best-effort verify): the manifest gets written,
    // the call returns `posted`, the verify-error gets logged.
    expect(result?.status).toBe("posted")
    const warnLine = consoleWarns.find((l) => l.includes("pr-review-verify-error"))
    expect(warnLine).toBeDefined()
    expect(warnLine).toContain('"submit_path":"phase3"')
    // L4: pin the behavioral contract — the manifest IS written on
    // the transient-blip path, proving verify defaulted to true.
    const manifest = await readReviewManifest(env, "acme", "site", 7)
    expect(manifest.kind).toBe("ok")
  })

  // Code-review on this PR (H2): the list endpoint returns reviews
  // ASC with `per_page=100` single-page. On a PR that has
  // accumulated >=100 prior reviews, our just-submitted review
  // sits on page 2+ and is missing from page 1. Verify must NOT
  // flip the submit to skipped in that case — instead, treat the
  // cap as inconclusive (assume persisted) and emit a distinct
  // `pr-review-verify-list-capped` event.
  it("treats page-cap (>=100 results without the new review) as inconclusive and assumes verified=true", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 9999, state: "APPROVED" })
    // 100 prior reviews on this PR; the just-submitted id (9999) is
    // not among them — production behavior is "on page 2".
    mockListPullRequestReviews.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        id: 1000 + i,
        state: "APPROVED",
        user: { login: "sigilix[bot]" },
        body: "",
      })),
    )
    mockListPullFilesForManifest.mockResolvedValue({ overflow: false, entries: [] })
    mockGetMergeBase.mockResolvedValue(null)

    const consoleWarns: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => consoleWarns.push(typeof msg === "string" ? msg : JSON.stringify(msg))

    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    let result: { status: string } | undefined
    try {
      result = await handlePrReview({
        owner: "acme", repo: "site", prNumber: 7,
        headSha: "h".repeat(40),
        installationId: 1,
        env,
      })
    } finally {
      console.warn = origWarn
    }

    // Verify defaulted to true → submit reported as posted.
    expect(result?.status).toBe("posted")
    const cappedWarn = consoleWarns.find((l) => l.includes("pr-review-verify-list-capped"))
    expect(cappedWarn).toBeDefined()
    expect(cappedWarn).toContain('"submit_path":"phase3"')
    // The verify-missing event must NOT fire (otherwise we're
    // still classifying the cap as a hard miss).
    const missingWarn = consoleWarns.find((l) => l.includes("pr-review-verify-missing"))
    expect(missingWarn).toBeUndefined()
    // Manifest IS written — proves verified stayed true.
    const manifest = await readReviewManifest(env, "acme", "site", 7)
    expect(manifest.kind).toBe("ok")
  })

  it("happy path: verify finds review in the public list with non-PENDING state → posted + manifest written", async () => {
    mockGetPullRequest.mockResolvedValue(goodMeta)
    mockGenerate.mockResolvedValue(goodVerdict)
    mockSubmitReview.mockResolvedValue({ id: 4242, state: "APPROVED" })
    mockListPullRequestReviews.mockResolvedValue([
      { id: 4242, state: "APPROVED", user: { login: "sigilix[bot]" }, body: "" },
    ])
    mockListPullFilesForManifest.mockResolvedValue({ overflow: false, entries: [] })
    mockGetMergeBase.mockResolvedValue(null)

    const { kv } = makeKvStub()
    const env = makeEnv(kv)
    const result = await handlePrReview({
      owner: "acme", repo: "site", prNumber: 7,
      headSha: "h".repeat(40),
      installationId: 1,
      env,
    })

    expect(result.status).toBe("posted")
    // `listPullRequestReviews` is called twice on the happy path:
    // once by `verifyReviewPersisted` and once by
    // `dismissPriorSigilixReviews`. Both reads are expected.
    expect(mockListPullRequestReviews).toHaveBeenCalledTimes(2)
    const manifest = await readReviewManifest(env, "acme", "site", 7)
    expect(manifest.kind).toBe("ok")
  })
})
