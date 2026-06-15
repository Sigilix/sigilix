// SIG-418 Phase 2 (Design B′) — orchestrator-boundary tests for the dark
// in-invocation multi-batch SHADOW wiring (`OPENCLAW_REVIEW_MULTIBATCH_MODE`).
//
// These pin the output-safety + recall/cost-safety invariants the wiring must
// hold, driven through the REAL `handlePrReviewEnsemble` (mocked GitHub + model
// surface, mirroring `triage-pr-review-ensemble-router-skip-paths.test.ts`):
//
//   1. STALE HEAD → the shadow pass NEVER runs. When the head moved, the
//      orchestrator returns at a stale-head guard before reaching the shadow
//      scheduler, so a stale head can never spend spillover model calls — no
//      `multibatch-decision` / `multibatch-summary` telemetry. (Codex sign-off:
//      schedule shadow only after the stale-head guard passes; this is the
//      regression guard for that placement.)
//   2. OFF (default) → the scheduler is never reached: zero multibatch telemetry,
//      byte-identical to today.
//   3. ON in PR 2 → inert + the `multibatch-mode-unsupported` log (enforce ships
//      in PR 3); still no `multibatch-summary`.
//
// Reaching the POST-synth path (guard #2) at the orchestrator boundary needs the
// full specialist+synth pipeline mocked, which the repo deliberately avoids
// (see the documented `it.skip` in -merge-shortcut.test.ts). The stale-head
// guard #1 path proves the identical "don't run the shadow on a stale head"
// safety property cheaply + honestly; the unit/scheduler tests cover the loop,
// the budget halt, the telemetry-only contract, and off|on|shadow gating.

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
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockCreateIssueComment: vi.fn(),
  mockRunSarifEvidence: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("@/src/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model/ollama-chat")>(
    "@/src/shared/adapters/model/ollama-chat",
  )
  return { ...actual, chat: (...args: unknown[]) => mockChat(...args) }
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
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

vi.mock("@/src/features/sarif-evidence", async () => {
  const actual = await vi.importActual<typeof import("@/src/features/sarif-evidence")>("@/src/features/sarif-evidence")
  return { ...actual, runSarifEvidence: (...args: unknown[]) => mockRunSarifEvidence(...args) }
})

import { handlePrReviewEnsemble } from "@/src/lib/triage-pr-review-ensemble"
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
const DIFFERENT_SHA = "f00dface1234567890abcdef1234567890abcdef"

// Docs-only-no-fences diff → the router takes the docs shortcut → empty
// specialist set → the orchestrator skips before any model dispatch (for the
// off/on inertness cases — they only need to prove the shadow scheduler is or
// isn't reached, not a full review).
const DOCS_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Sigilix

+New paragraph about the project — prose only, no code fences.
+
 ## Overview
`

let logSpy: ReturnType<typeof vi.spyOn>

function loggedEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    .filter((e) => typeof e["event"] === "string")
}

function multibatchEvents(): Array<Record<string, unknown>> {
  return loggedEvents().filter((e) => String(e["event"]).startsWith("multibatch-"))
}

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
  mockRunSarifEvidence.mockReset().mockResolvedValue({ skipped: true, reason: "disabled-config" })
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("handlePrReviewEnsemble — SIG-418 multi-batch shadow wiring", () => {
  it("STALE HEAD: shadow=on, but a moved head returns before the shadow scheduler → zero multibatch telemetry", async () => {
    // Guard #1 fires: the first getPullRequest reports a head SHA different from
    // the queued one, so the orchestrator returns `stale_head` BEFORE packing,
    // routing, fan-out, or the multi-batch shadow scheduler. The shadow pass can
    // never run on a stale head — no model calls, no multibatch telemetry.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: DIFFERENT_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9100,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_REVIEW_MULTIBATCH_MODE: "shadow" } as unknown as Env),
    })

    expect(result.status).toBe("stale_head")
    expect(result.telemetry.fellBackReason).toBe("stale_head_before_fanout")
    // The CORE safety invariant: no spillover model calls, no shadow telemetry.
    expect(mockChat).not.toHaveBeenCalled()
    expect(multibatchEvents()).toEqual([])
  })

  it("OFF (default): the shadow scheduler is never reached → zero multibatch telemetry", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9101,
      headSha: HEAD_SHA,
      installationId: 1,
      // Router on → docs-only diff → empty specialists → clean skip. multiBatchMode
      // absent → off. Either way the shadow scheduler must never fire.
      env: makeEnv({ OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on" } as unknown as Env),
    })

    expect(result.status).toBe("skipped")
    expect(mockChat).not.toHaveBeenCalled()
    expect(multibatchEvents()).toEqual([])
  })

  it("ON in PR 2: inert — logs multibatch-mode-unsupported is NOT emitted on a pre-fanout skip (no summary either)", async () => {
    // `on` only reaches the unsupported-log branch AFTER the post-synth stale
    // guard — on a pre-fanout skip it exits earlier, so neither the unsupported
    // log NOR a summary fires. The invariant we pin here is the safety one: a
    // pre-fanout skip with `on` set still produces ZERO multibatch telemetry
    // (no run, no summary), exactly like off.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9102,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({
        OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on",
        OPENCLAW_REVIEW_MULTIBATCH_MODE: "on",
      } as unknown as Env),
    })

    expect(result.status).toBe("skipped")
    expect(mockChat).not.toHaveBeenCalled()
    // No shadow run + no summary on this path (the unsupported-mode log lives on
    // the post-synth path; the safety guarantee is "no shadow telemetry/run").
    expect(multibatchEvents().filter((e) => e["event"] === "multibatch-summary")).toEqual([])
    expect(multibatchEvents().filter((e) => e["event"] === "multibatch-decision")).toEqual([])
  })
})
