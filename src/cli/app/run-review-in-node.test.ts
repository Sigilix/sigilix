// SIG-304 (review CLI) Phase 1 — the headless-driver error path (CI). The happy path
// (a real engine run, zero posting) is the live test; here we pin the cheap pure
// branch: a PR whose head SHA can't be resolved throws BEFORE the engine runs.

import { describe, it, expect, vi } from "vitest"

vi.mock("@/src/shared/adapters/github", () => ({
  GitHubClient: class {
    async getPullRequest(): Promise<unknown> {
      return { head: undefined } // no head.sha
    }
  },
}))
vi.mock("@/src/lib/ensemble/app/orchestrator", () => ({ handlePrReviewEnsemble: vi.fn() }))

import { runReviewInNode } from "./run-review-in-node"
import { handlePrReviewEnsemble } from "@/src/lib/ensemble/app/orchestrator"

describe("runReviewInNode", () => {
  it("throws a clear error when the head SHA can't be resolved, without calling the engine", async () => {
    await expect(
      runReviewInNode({ owner: "o", repo: "r", prNumber: 1, githubToken: "t", processEnv: {} }),
    ).rejects.toThrow(/head SHA/)
    expect(handlePrReviewEnsemble).not.toHaveBeenCalled()
  })
})
