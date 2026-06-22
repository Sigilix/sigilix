// SIG-304 (review CLI) Phase 1 — the headless-driver error/skip branches (CI). The
// happy path (a real engine run, zero posting) is the live test; here we pin the
// cheap pure branches: unresolved head SHA throws before the engine; an ERRORED
// engine run throws (never a silent clean pass); a genuinely-empty run returns null.

import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({ head: { sha: "abc123" } as unknown }))
vi.mock("@/src/shared/adapters/github", () => ({
  GitHubClient: class {
    async getPullRequest(): Promise<unknown> {
      return { head: state.head }
    }
  },
}))
vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))

import { runReviewInNode } from "./run-review-in-node"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"

const mockEngine = vi.mocked(handlePrReviewEnsemble)
const args = { owner: "o", repo: "r", prNumber: 1, githubToken: "t", processEnv: {} }

beforeEach(() => {
  state.head = { sha: "abc123" }
  mockEngine.mockReset()
})

describe("runReviewInNode", () => {
  it("throws a clear error when the head SHA can't be resolved, without calling the engine", async () => {
    state.head = undefined
    await expect(runReviewInNode(args)).rejects.toThrow(/head SHA/)
    expect(mockEngine).not.toHaveBeenCalled()
  })

  it("RECALL-SAFETY: an errored engine run THROWS (never a silent null / clean pass)", async () => {
    mockEngine.mockResolvedValue({ status: "errored", telemetry: { internalError: "model 500" } } as never)
    await expect(runReviewInNode(args)).rejects.toThrow(/review failed.*model 500/)
  })

  it("returns null only when the engine genuinely had nothing to review", async () => {
    mockEngine.mockResolvedValue({ status: "skipped", telemetry: {} } as never)
    expect(await runReviewInNode(args)).toBeNull()
  })
})
