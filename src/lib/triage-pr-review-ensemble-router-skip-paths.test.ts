// SIG-224 Phase 0 — narrow integration tests for the two
// `handlePrReviewEnsemble` skip paths modified in PR #182:
//
//   1. Empty-router (`router.specialists.length === 0` at
//      `triage-pr-review-ensemble.ts:1533`) — docs-only-no-fences diffs
//      under `OPENCLAW_ENSEMBLE_ROUTER_ENABLED=on` produce an empty
//      specialist set. Pre-SIG-224: bailWithSkipNotice → "Couldn't
//      review · see PR comment" + a skip-notice PR comment. Post-fix:
//      `finalize(..., "skipped", cache, {event: "APPROVE",
//      findingsCount: 0})` → green "Approved — no issues found" check,
//      no skip-notice comment, no chat() dispatch.
//
//   2. Label-gate (`costControls.runOnLabels` doesn't intersect PR
//      labels at `:1371-1386`) — same fix shape as the empty-router
//      branch above. The label-gate path was previously emitting the
//      legacy "Review posted · View review" Check Run title with a
//      broken review URL; this PR threads the same reviewMeta.
//
// Sigilix bot's own tests-specialist flagged this on PR #182's first
// review: "Empty-router and label-gate skip path changes lack test
// coverage" (score 4, category: testing). The repo's documented
// pattern (`tests/triage-pr-review-ensemble.test.ts:1-5`) is "full
// integration testing deferred to shadow-mode dogfooding" — but the
// bot's tests-specialist correctly noted that two-line behavior swaps
// on customer-visible paths deserve narrow integration coverage at
// the orchestrator boundary, matching the precedent set by
// `tests/triage-pr-review-ensemble-merge-shortcut.test.ts` (SIG-88).
//
// This file pins the orchestrator-boundary invariants:
//   - status === "skipped"
//   - reviewMeta === {event: "APPROVE", findingsCount: 0}
//   - telemetry.fellBackReason set to the correct identifier
//   - mockChat NEVER called (no specialist dispatch)
//   - mockCreateIssueComment NEVER called (no skip-notice posted)
//   - mockSubmitReview NEVER called (we never submit a formal review)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockChat,
  mockGetPullRequest,
  mockGetPullRequestDiff,
  mockListOpenPullRequests,
  mockGetFileContent,
  mockSubmitReview,
  mockListPullRequestReviews,
  mockCreateIssueComment,
  mockRunSarifEvidence,
  mockGetBranch,
  mockGetRepoTree,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockRunSarifEvidence: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
}))

vi.mock("@/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/shared/adapters/model/ollama-chat")>("@/shared/adapters/model/ollama-chat")
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

vi.mock("@/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/shared/adapters/github")>("@/shared/adapters/github")
  class GitHubClientMock {
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
    async getPullRequestDiff(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequestDiff(...args)
    }
    async listOpenPullRequests(...args: unknown[]): Promise<unknown> {
      return mockListOpenPullRequests(...args)
    }
    async getFileContent(...args: unknown[]): Promise<unknown> {
      return mockGetFileContent(...args)
    }
    async submitReview(...args: unknown[]): Promise<unknown> {
      return mockSubmitReview(...args)
    }
    async listPullRequestReviews(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestReviews(...args)
    }
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
    async getBranch(...args: unknown[]): Promise<unknown> {
      return mockGetBranch(...args)
    }
    async getRepoTree(...args: unknown[]): Promise<unknown> {
      return mockGetRepoTree(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

vi.mock("@/features/sarif-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/features/sarif-evidence")>(
    "@/features/sarif-evidence",
  )
  return {
    ...actual,
    runSarifEvidence: (...args: unknown[]) => mockRunSarifEvidence(...args),
  }
})

import {
  handlePrReviewEnsemble,
  ORCHESTRATOR_TIMEOUT_MS,
} from "@/lib/triage-pr-review-ensemble"
import type { Env } from "@/shared/types/env"

function makeKvStub(): Env["OPENCLAW_STATE"] {
  const store = new Map<string, string>()
  return {
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
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: makeKvStub(),
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    ...overrides,
  } as unknown as Env
}

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"
const BASE_SHA = "basesha000000000000000000000000000000000"

// Docs-only diff with NO executable fenced code blocks → the
// ensemble-router takes the `allDocsOnly && no suspicious fences`
// shortcut and returns `specialists: []`.
const DOCS_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Sigilix

+New paragraph about the project — prose only, no code fences.
+
 ## Overview
diff --git a/docs/notes.md b/docs/notes.md
index 0000000..1111111 100644
--- a/docs/notes.md
+++ b/docs/notes.md
@@ -1,2 +1,3 @@
 # Notes

+Adding another note line. Plain prose.
`

// Source-code diff for the label-gate test — we want the router NOT to
// short-circuit on file-type rules (rules return all 4 specialists by
// default), so we use a normal .ts diff. The label gate fires BEFORE
// the router decision anyway, so the diff content technically doesn't
// matter for this test; using a realistic diff keeps the test honest.
const SOURCE_DIFF = `diff --git a/src/lib/foo.ts b/src/lib/foo.ts
index abc1234..def5678 100644
--- a/src/lib/foo.ts
+++ b/src/lib/foo.ts
@@ -1,3 +1,5 @@
 export function foo() {
+  // additional logic
+  return 1
   return 0
 }
`

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockGetInstallationToken.mockClear().mockResolvedValue("test-token")
  mockChat.mockReset()
  mockGetPullRequest.mockReset()
  mockGetPullRequestDiff.mockReset()
  mockListOpenPullRequests.mockReset()
  mockGetFileContent.mockReset()
  mockSubmitReview.mockReset()
  mockListPullRequestReviews.mockReset()
  mockCreateIssueComment.mockReset()
  mockGetBranch.mockReset()
  mockGetRepoTree.mockReset()
  mockRunSarifEvidence.mockReset().mockResolvedValue({
    skipped: true,
    reason: "disabled-config",
  })
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

describe("handlePrReviewEnsemble — empty-router skip path (SIG-224 Phase 0)", () => {
  // Invariant: when `decideSpecialists` returns an empty specialist
  // list (docs-only-no-fences diff under
  // `OPENCLAW_ENSEMBLE_ROUTER_ENABLED=on`), the orchestrator must:
  //   1. Return `status: "skipped"` with `reviewMeta = {event:
  //      "APPROVE", findingsCount: 0}` so the dispatcher maps to a
  //      green "Approved — no issues found" check.
  //   2. Stamp `telemetry.fellBackReason === "router_no_specialists"`.
  //   3. NEVER dispatch specialists (no `chat()` call).
  //   4. NEVER post a skip-notice PR comment (no `createIssueComment`
  //      call). Pre-fix this path bailed via `bailWithSkipNotice`
  //      which posted "Sigilix couldn't generate a review."
  //   5. NEVER submit a formal review.
  it("returns skipped + APPROVE reviewMeta when the router returns no specialists", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    // sigilix.json absent → loadSigilixConfig falls back to EMPTY_CONFIG.
    mockGetFileContent.mockResolvedValueOnce(null)

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9001,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on",
      } as unknown as Env),
    })

    expect(result.status).toBe("skipped")
    expect(result.reviewMeta?.event).toBe("APPROVE")
    expect(result.reviewMeta?.findingsCount).toBe(0)
    expect(result.reviewMeta?.surface).toBeUndefined()
    expect(result.telemetry.fellBackReason).toBe("router_no_specialists")
    // Core invariants — no specialist dispatch, no skip-notice comment,
    // no submitted review.
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it("stays default-all-four (does NOT empty out) when the router flag is off", async () => {
    // Defense in depth: confirm we didn't accidentally invert the
    // flag-off semantics. With `OPENCLAW_ENSEMBLE_ROUTER_ENABLED`
    // absent, `decideSpecialists` returns `ALL_SPECIALISTS` regardless
    // of diff shape, so the empty-router branch at line 1533 must NOT
    // fire. We assert the negative: `fellBackReason !==
    // "router_no_specialists"`. The downstream pipeline may bail for
    // other reasons (retrieval / deterministic-check mocks aren't
    // wired here) — those failure modes are NOT what this test pins.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)
    mockChat.mockRejectedValue(new Error("test boundary — specialists not mocked"))

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9002,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(), // flag NOT set → router off → returns ALL_SPECIALISTS
    })

    // The empty-router branch must NOT have fired.
    expect(result.telemetry.fellBackReason).not.toBe("router_no_specialists")
  })
})

describe("handlePrReviewEnsemble — label-gate skip path (SIG-224 Phase 0 follow-along)", () => {
  // Invariant: when `costControls.runOnLabels` is configured but the
  // PR's labels don't intersect, the orchestrator must:
  //   1. Return `status: "skipped"` with `reviewMeta = {event:
  //      "APPROVE", findingsCount: 0}` (same shape as empty-router).
  //   2. Stamp `telemetry.fellBackReason === "label_gate_skip"`.
  //   3. NEVER dispatch specialists.
  //   4. NEVER post a skip-notice comment.
  //   5. NEVER submit a formal review.
  it("returns skipped + APPROVE reviewMeta when the PR labels don't satisfy runOnLabels", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [{ name: "other-label" }, { name: "wip" }],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    // sigilix.json present with runOnLabels gating to a label the PR
    // doesn't carry.
    mockGetFileContent.mockResolvedValueOnce(JSON.stringify({
      costControls: { runOnLabels: ["sigilix:review"] },
    }))

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9003,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(),
    })

    expect(result.status).toBe("skipped")
    expect(result.reviewMeta?.event).toBe("APPROVE")
    expect(result.reviewMeta?.findingsCount).toBe(0)
    expect(result.reviewMeta?.surface).toBeUndefined()
    expect(result.telemetry.fellBackReason).toBe("label_gate_skip")
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it("does NOT short-circuit at the label gate when PR labels satisfy runOnLabels", async () => {
    // Defense in depth: confirm the gate doesn't fire when a label
    // matches. Asserts the negative (`fellBackReason !==
    // "label_gate_skip"`) — the downstream pipeline may bail for
    // other reasons (retrieval / deterministic-check mocks not
    // wired), which we don't pin here.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [{ name: "sigilix:review" }, { name: "wip" }],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(JSON.stringify({
      costControls: { runOnLabels: ["sigilix:review"] },
    }))
    mockChat.mockRejectedValue(new Error("test boundary — specialists not mocked"))

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9004,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(),
    })

    expect(result.telemetry.fellBackReason).not.toBe("label_gate_skip")
  })
})

describe("handlePrReviewEnsemble — deterministic SARIF annotation threading (SIG-171)", () => {
  it("threads deterministic annotations through post-SARIF skip-notice failures", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
      title: "exercise deterministic annotations",
      body: "",
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValue(null)
    mockRunSarifEvidence.mockResolvedValueOnce({
      skipped: false,
      findings: [{
        ruleId: "no-token",
        severity: "error",
        roleHint: "security",
        category: "secret",
        path: "src/lib/foo.ts",
        line: 2,
        message: "scanner finding",
        toolName: "Semgrep",
      }],
      telemetry: { truncatedCount: 0, durationMs: 1 },
      sbom: { present: false, text: "", packageCount: 0, directDepCount: 0, licenseCounts: {} },
    })
    mockChat.mockRejectedValue(new Error("model unavailable"))
    mockCreateIssueComment.mockResolvedValueOnce({ id: 12_345 })

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9005,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "0",
      } as unknown as Env),
    })

    expect(result.status).toBe("errored")
    expect(result.telemetry.fellBackReason).toBe("specialists_all_failed")
    expect(result.reviewMeta?.surface).toBe("skip-notice")
    expect(result.reviewMeta?.event).toBe("REQUEST_CHANGES")
    expect(result.reviewMeta?.findingsCount).toBe(0)
    expect(result.reviewMeta?.deterministicCheckAnnotations).toMatchObject([{
      path: "src/lib/foo.ts",
      start_line: 2,
      end_line: 2,
      annotation_level: "failure",
      title: "[SARIF error] Semgrep: no-token",
    }])
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })
})

describe("handlePrReviewEnsemble — testing evidence repo-tree abort handling (SIG-222)", () => {
  it("propagates orchestrator aborts during repo-tree fetch instead of soft-failing", async () => {
    vi.useFakeTimers()
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA, ref: "sig-222" },
      base: { sha: BASE_SHA, ref: "main" },
      merged_at: null,
      labels: [],
      title: "source-only test evidence change",
      body: "",
      user: { login: "alice" },
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValue(null)
    let getBranchCalled!: () => void
    const getBranchStarted = new Promise<void>((resolve) => {
      getBranchCalled = resolve
    })
    let getRepoTreeCallsAtBranchStart = 0
    mockGetBranch.mockImplementationOnce(async (
      _owner: string,
      _repo: string,
      _branch: string,
      opts?: { signal?: AbortSignal },
    ) => {
      expect(opts?.signal?.aborted).toBe(false)
      getRepoTreeCallsAtBranchStart = mockGetRepoTree.mock.calls.length
      getBranchCalled()
      return await new Promise<never>((_resolve, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          expect(opts.signal?.aborted).toBe(true)
          reject(new DOMException("The operation was aborted", "AbortError"))
        }, { once: true })
      })
    })

    const resultPromise = handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 9006,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_ENSEMBLE_MAX_RETRIEVE_CALLS_PER_PR: "0",
      } as unknown as Env),
    })
    await getBranchStarted
    await vi.advanceTimersByTimeAsync(ORCHESTRATOR_TIMEOUT_MS)
    const result = await resultPromise

    expect(result.status).toBe("errored")
    expect(result.telemetry.fellBackReason).toBe("internal_error")
    expect(result.telemetry.internalError).toMatch(/aborted/i)
    expect(mockGetBranch).toHaveBeenCalledWith(
      "Arc-and-Anchor",
      "sigilix",
      "sig-222",
      { signal: expect.any(AbortSignal) },
    )
    expect(mockGetRepoTree.mock.calls.length).toBe(getRepoTreeCallsAtBranchStart)
    expect(warnSpy.mock.calls.some((args) =>
      args.some((arg) => String(arg).includes("tests-evidence-repo-tree-aborted")),
    )).toBe(true)
    expect(warnSpy.mock.calls.some((args) =>
      args.some((arg) => String(arg).includes("tests-evidence-repo-tree-fetch-failed")),
    )).toBe(false)
    expect(logSpy.mock.calls.some((args) =>
      args.some((arg) =>
        String(arg).includes("tests-evidence-repo-tree-status") &&
        String(arg).includes("fetch-failed"),
      ),
    )).toBe(false)
    expect(logSpy.mock.calls.some((args) =>
      args.some((arg) => String(arg).includes("tests-evidence-repo-tree-status")),
    )).toBe(false)
  })
})
