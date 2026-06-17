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
  mockListPullRequestFiles,
  mockCreateIssueComment,
  mockRunSarifEvidence,
  mockGetBranch,
  mockGetRepoTree,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockListPullRequestFiles: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockRunSarifEvidence: vi.fn(),
  mockGetBranch: vi.fn(),
  mockGetRepoTree: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model/ollama-chat")>(
    "@/src/shared/adapters/model/ollama-chat",
  )
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
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
    async listPullRequestFiles(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestFiles(...args)
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

vi.mock("@/src/features/sarif-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/sarif-evidence")>("@/src/features/sarif-evidence")
  return {
    ...actual,
    runSarifEvidence: (...args: unknown[]) => mockRunSarifEvidence(...args),
  }
})

import { handlePrReviewEnsemble, ORCHESTRATOR_TIMEOUT_MS } from "@/src/lib/triage-pr-review-ensemble"
import type { Env } from "@/src/shared/types/env"

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
  mockListPullRequestFiles.mockReset().mockResolvedValue([])
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
      owner: "Sigilix",
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

  it("reports retrieval and skipped status updates when no specialists are needed", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)
    const statusReporter = { report: vi.fn(), flush: vi.fn(async () => undefined) }

    await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9001,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on",
      } as unknown as Env),
      statusReporter,
    })

    const phases = statusReporter.report.mock.calls.map((c) => c[0]?.phase)
    expect(phases).toContain("retrieval")
    expect(phases).toContain("skipped")
    expect(statusReporter.report).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "skipped",
        specialists: expect.objectContaining({
          notNeeded: ["logic", "security", "performance", "tests"],
        }),
        final: expect.objectContaining({ status: "skipped", findingsCount: 0 }),
      }),
    )
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
      owner: "Sigilix",
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
    mockGetFileContent.mockResolvedValueOnce(
      JSON.stringify({
        costControls: { runOnLabels: ["sigilix:review"] },
      }),
    )

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
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
    mockGetFileContent.mockResolvedValueOnce(
      JSON.stringify({
        costControls: { runOnLabels: ["sigilix:review"] },
      }),
    )
    mockChat.mockRejectedValue(new Error("test boundary — specialists not mocked"))

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9004,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(),
    })

    expect(result.telemetry.fellBackReason).not.toBe("label_gate_skip")
  })
})

describe("handlePrReviewEnsemble — incremental empty-delta skip path (false-APPROVE guard)", () => {
  // Invariant (sigilix-monitor#36): under OPENCLAW_INCREMENTAL_REVIEW_MODE="on", a re-trigger on an
  // already-reviewed PR with NO new commits (every changed file unchanged at its current blobSha) must
  // NOT run a fresh ensemble. The empty delta empties the reviewable map → tagOutOfPrScopeFindings tags
  // every surviving finding out-of-PR-scope → verdict APPROVE; a fresh same-SHA APPROVE review object then
  // becomes GitHub's latest verdict for the reviewer, superseding the prior CHANGES_REQUESTED under branch
  // protection (the false-approve red flag). The orchestrator must short-circuit BEFORE publish:
  //   1. status === "skipped", telemetry.fellBackReason === "incremental_no_new_paths".
  //   2. NEVER dispatch specialists (no chat()).
  //   3. NEVER submit a review (no submitReview) and emit no reviewMeta — so no fresh review is posted to
  //      supersede the prior blocking one, and the check title stays neutral (not "Approved").
  const OLD_HEAD = "01dHEAD00000000000000000000000000000000a"
  const PRIOR_COVERAGE = (blobSha: string) =>
    JSON.stringify({
      schemaVersion: 1,
      files: {
        "src/lib/foo.ts": {
          reviewedAtBlobSha: blobSha,
          reviewedAtHeadSha: OLD_HEAD,
          reviewedAt: "2026-06-16T00:00:00.000Z",
        },
      },
    })

  it("skips (posts nothing) when the incremental delta is empty — all changed files already reviewed", async () => {
    mockGetPullRequest.mockResolvedValue({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValue(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValue([])
    mockGetFileContent.mockResolvedValue(null)
    // The PR's only changed file is at blob "BLOB1" — the SAME blob the prior review covered → unchanged
    // → selectIncrementalReviewPaths yields an empty pathsToReview (empty delta).
    mockListPullRequestFiles.mockResolvedValue([
      { filename: "src/lib/foo.ts", status: "modified", additions: 2, deletions: 0, sha: "BLOB1" },
    ])
    const env = makeEnv({ OPENCLAW_INCREMENTAL_REVIEW_MODE: "on" } as unknown as Env)
    await env.OPENCLAW_STATE.put("pr-review-coverage:Sigilix/sigilix#9100", PRIOR_COVERAGE("BLOB1"))

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9100,
      headSha: HEAD_SHA,
      installationId: 1,
      env,
    })

    expect(result.status).toBe("skipped")
    expect(result.telemetry.fellBackReason).toBe("incremental_no_new_paths")
    // No reviewMeta → no APPROVE verdict surfaced (pins "the false-approve is gone", not just "skipped"):
    // a regression that re-posted the empty-delta APPROVE would carry reviewMeta.event === "APPROVE".
    expect(result.reviewMeta).toBeUndefined()
    // Core invariants — no specialist dispatch, no submitted review (so the prior blocker is untouched).
    expect(mockChat).not.toHaveBeenCalled()
    expect(mockSubmitReview).not.toHaveBeenCalled()
  })

  it("does NOT skip when a changed file's blobSha differs — recall guard (still reviews the new code)", async () => {
    mockGetPullRequest.mockResolvedValue({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValue(SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValue([])
    mockGetFileContent.mockResolvedValue(null)
    // The PR's changed file now reports blob "BLOB2" but the prior review covered "BLOB1" → CHANGED →
    // pathsToReview is non-empty → the empty-delta guard must NOT fire (the new code is still reviewed).
    mockListPullRequestFiles.mockResolvedValue([
      { filename: "src/lib/foo.ts", status: "modified", additions: 2, deletions: 0, sha: "BLOB2" },
    ])
    // Boundary: specialists aren't mocked — the run may bail downstream for other reasons, which we do
    // NOT pin here; we only assert the empty-delta branch did not fire.
    mockChat.mockRejectedValue(new Error("test boundary — specialists not mocked"))
    const env = makeEnv({ OPENCLAW_INCREMENTAL_REVIEW_MODE: "on" } as unknown as Env)
    await env.OPENCLAW_STATE.put("pr-review-coverage:Sigilix/sigilix#9101", PRIOR_COVERAGE("BLOB1"))

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9101,
      headSha: HEAD_SHA,
      installationId: 1,
      env,
    })

    expect(result.telemetry.fellBackReason).not.toBe("incremental_no_new_paths")
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
      findings: [
        {
          ruleId: "no-token",
          severity: "error",
          roleHint: "security",
          category: "secret",
          path: "src/lib/foo.ts",
          line: 2,
          message: "scanner finding",
          toolName: "Semgrep",
        },
      ],
      telemetry: { truncatedCount: 0, durationMs: 1 },
      sbom: { present: false, text: "", packageCount: 0, directDepCount: 0, licenseCounts: {} },
    })
    mockChat.mockRejectedValue(new Error("model unavailable"))
    mockCreateIssueComment.mockResolvedValueOnce({ id: 12_345 })

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
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
    expect(result.reviewMeta?.deterministicCheckAnnotations).toMatchObject([
      {
        path: "src/lib/foo.ts",
        start_line: 2,
        end_line: 2,
        annotation_level: "failure",
        title: "[SARIF error] Semgrep: no-token",
      },
    ])
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
    mockGetBranch.mockImplementationOnce(
      async (_owner: string, _repo: string, _branch: string, opts?: { signal?: AbortSignal }) => {
        expect(opts?.signal?.aborted).toBe(false)
        getRepoTreeCallsAtBranchStart = mockGetRepoTree.mock.calls.length
        getBranchCalled()
        return await new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            "abort",
            () => {
              expect(opts.signal?.aborted).toBe(true)
              reject(new DOMException("The operation was aborted", "AbortError"))
            },
            { once: true },
          )
        })
      },
    )

    const resultPromise = handlePrReviewEnsemble({
      owner: "Sigilix",
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
    expect(mockGetBranch).toHaveBeenCalledWith("Sigilix", "sigilix", "sig-222", {
      signal: expect.any(AbortSignal),
    })
    expect(mockGetRepoTree.mock.calls.length).toBe(getRepoTreeCallsAtBranchStart)
    expect(
      warnSpy.mock.calls.some((args) => args.some((arg) => String(arg).includes("tests-evidence-repo-tree-aborted"))),
    ).toBe(true)
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some((arg) => String(arg).includes("tests-evidence-repo-tree-fetch-failed")),
      ),
    ).toBe(false)
    expect(
      logSpy.mock.calls.some((args) =>
        args.some(
          (arg) => String(arg).includes("tests-evidence-repo-tree-status") && String(arg).includes("fetch-failed"),
        ),
      ),
    ).toBe(false)
    expect(
      logSpy.mock.calls.some((args) => args.some((arg) => String(arg).includes("tests-evidence-repo-tree-status"))),
    ).toBe(false)
  })
})
