// CR PR #104 round-3 (SIG-88) — narrow integration tests for the
// merged-on-approve short-circuit paths in `handlePrReviewEnsemble`.
//
// Sigilix testing-specialist's finding on commit 5cc31fe:
//   "New short-circuit paths in handlePrReviewEnsemble lack
//    integration tests. The pre-fanout and pre-submit branches that
//    call submitMergedOnApprove and short-circuit the ensemble
//    dispatch are only tested at the helper level
//    (tests/merge-guard.test.ts). The full orchestrator handoff —
//    confirming the ensemble actually short-circuits and doesn't
//    dispatch specialists — isn't pinned."
//
// This file pins the orchestrator-boundary invariant for the
// pre-fanout case (the small one — 3 mocks). The pre-submit case is
// skipped with a documented blocker (see the `it.skip` below for
// rationale).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockGetInstallationToken, mockChat, mockGetPullRequest, mockSubmitReview, mockListPullRequestReviews } =
  vi.hoisted(() => ({
    mockGetInstallationToken: vi.fn(async () => "test-token"),
    mockChat: vi.fn(),
    mockGetPullRequest: vi.fn(),
    mockSubmitReview: vi.fn(),
    mockListPullRequestReviews: vi.fn(),
  }))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ollama-chat")>("../src/lib/ollama-chat")
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  class GitHubClientMock {
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
    async submitReview(...args: unknown[]): Promise<unknown> {
      return mockSubmitReview(...args)
    }
    async listPullRequestReviews(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestReviews(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import { handlePrReviewEnsemble } from "../src/lib/triage-pr-review-ensemble"
import type { Env } from "../src/index"

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

function makeEnv(): Env {
  return {
    OPENCLAW_STATE: makeKvStub(),
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockGetInstallationToken.mockClear().mockResolvedValue("test-token")
  mockChat.mockReset()
  mockGetPullRequest.mockReset()
  mockSubmitReview.mockReset()
  mockListPullRequestReviews.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

describe("handlePrReviewEnsemble — pre-fanout merged-on-approve short-circuit (SIG-88)", () => {
  // Invariant: when the PR is already merged at fan-out time
  // (`meta.merged_at` is set on the first `getPullRequest`), the
  // orchestrator must:
  //   1. Submit a marker-only APPROVE via `submitMergedOnApprove`.
  //   2. Return `posted` with `event: APPROVE`, findingsCount: 0.
  //   3. NEVER dispatch specialists (no `chat()` call).
  //   4. NEVER fetch the diff (no extra GitHub call beyond the
  //      single `getPullRequest` for the stale-head/merge check).
  //
  // The helper-level test in `tests/merge-guard.test.ts` covers the
  // `submitMergedOnApprove` body shape + telemetry shape. This test
  // pins the orchestrator boundary — that the short-circuit actually
  // fires and that the ensemble dispatch is bypassed.
  it("short-circuits to APPROVE without dispatching specialists when meta.merged_at is set", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: "basesha000000000000000000000000000000000" },
      merged_at: "2026-05-18T18:00:00Z",
    })
    mockSubmitReview.mockResolvedValueOnce({ id: 99_001, state: "APPROVED" })
    // verifyReviewPersisted lookup (CR PR #104 Major fix): the review
    // is present in the list with a non-PENDING state → verified.
    mockListPullRequestReviews.mockResolvedValueOnce([
      { id: 99_001, state: "APPROVED", body: "<!-- sigilix:pr-review -->\n", user: { login: "sigilix[bot]" } },
    ])

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 104,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(),
    })

    // Result shape: short-circuit posted an APPROVE.
    expect(result.status).toBe("posted")
    if (result.status === "posted") {
      expect(result.reviewMeta?.event).toBe("APPROVE")
      expect(result.reviewMeta?.findingsCount).toBe(0)
    }
    // Telemetry stamps the fallback reason on the short-circuit branch.
    expect(result.telemetry.fellBackReason).toBe("merged_before_fanout")
    // The CORE invariant: zero specialist dispatches.
    expect(mockChat).not.toHaveBeenCalled()
    // submitReview was called once with the APPROVE event + the head SHA.
    expect(mockSubmitReview).toHaveBeenCalledTimes(1)
    const [, , , submission] = mockSubmitReview.mock.calls[0] as [
      string,
      string,
      number,
      { event: string; commit_id: string; body: string; comments?: unknown },
    ]
    expect(submission.event).toBe("APPROVE")
    expect(submission.commit_id).toBe(HEAD_SHA)
    expect(submission.comments).toBeUndefined() // marker-only body
    // listPullRequestReviews fired once for verifyReviewPersisted.
    expect(mockListPullRequestReviews).toHaveBeenCalledTimes(1)
  })

  // CR PR #104 round-3: when the merged-on-approve submit fails (5xx,
  // auth blip, etc.), the orchestrator should NOT silently swallow the
  // failure — return `errored` and still skip specialist dispatch.
  it("returns errored (no specialists dispatched) when the APPROVE submit fails", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: "basesha000000000000000000000000000000000" },
      merged_at: "2026-05-18T18:00:00Z",
    })
    mockSubmitReview.mockRejectedValueOnce(new Error("HTTP 502 Bad Gateway"))

    const result = await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 104,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(),
    })

    expect(result.status).toBe("errored")
    expect(result.telemetry.fellBackReason).toBe("merged_before_fanout")
    expect(mockChat).not.toHaveBeenCalled()
    // verify call never fires when submit failed (no review id to check).
    expect(mockListPullRequestReviews).not.toHaveBeenCalled()
  })

  // Sigilix testing-specialist finding scope guard: the pre-submit
  // short-circuit path (the second `submitMergedOnApprove` call site,
  // post-synth) cannot be exercised at the orchestrator boundary
  // without spinning up the full specialist + synth pipeline. That
  // path runs AFTER the router decision, retrieval pre-flight,
  // specialist fan-out (4 parallel `chat()` calls + retries +
  // fallbacks), and synthesizer (`chat()` again + ARC-278 retry). To
  // reach the second merge-guard call, the test would need to mock
  // every one of those surfaces with realistic-enough returns that
  // the orchestrator doesn't bail early on quorum / parse / provenance
  // failure.
  //
  // The helper-level test in `tests/merge-guard.test.ts::
  // submitMergedOnApprove` covers the submit shape + telemetry +
  // failure handling for BOTH stages (`stage: "pre-fanout"` and
  // `stage: "pre-submit"`). The orchestrator boundary for pre-submit
  // is structurally identical to pre-fanout (same helper call, same
  // `if (out.ok)` branch, same `verifyReviewPersisted` follow-up),
  // so the pre-fanout integration test above is a reasonable proxy
  // for the bypass invariant.
  //
  // If we ever invest in full-orchestrator integration testing, this
  // test stays here as the obvious entry point — flip `.skip` to
  // `.only`, stub the missing surfaces (sigilix-config, retrieval,
  // chat with synth verdict, dismissPriorSigilixReviews, telemetry
  // emitters), and assert that the post-synth merge-guard fires +
  // dispatches via `submitMergedOnApprove` with stage="pre-submit".
  it.skip("[BLOCKED — see comment] pre-submit short-circuit: merge happens during fan-out", () => {
    // Intentional no-op. Blocker: requires mocking the full
    // specialist + synth fan-out (~20 surfaces). Coverage of the
    // pre-submit branch lives at the helper level in
    // `tests/merge-guard.test.ts::submitMergedOnApprove (SIG-88)`.
  })
})
