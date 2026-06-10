// ARC-190 Task 7 — regression test for the case "pr-review"-only
// scoping of `runPrReviewWithDoCallback` (Codex BLOCKING B2 on plan v1).
//
// `ci-triage` JobMessages carry a separate, unrelated `runId: number`
// (a GitHub Actions run id, not a DO-routed UUID). A naive `if
// (job.runId)` guard around the wrapper would falsely route ci-triage
// through the DO. This test exercises `dispatchJob` directly and asserts:
//   1. `handleCiTriage` runs unchanged.
//   2. The DO namespace is never touched (no `idFromName` / no `get`).
//
// Keeping the test surface tiny: only `lib/triage-ci` is mocked; the
// rest of the dispatch path either short-circuits on the case match or
// is unreachable.

import { describe, it, expect, vi } from "vitest"

const { handleCiTriageMock } = vi.hoisted(() => ({
  handleCiTriageMock: vi.fn(async () => {}),
}))
vi.mock("@/src/lib/triage-ci", () => ({
  handleCiTriage: handleCiTriageMock,
}))

import { dispatchJob } from "@/src/index"
import type { Env } from "@/src/shared/types/env"
import type { JobMessage } from "@/src/shared/types/job"

function makeEnvWithDoSpy() {
  const idFromName = vi.fn(() => ({}) as DurableObjectId)
  const get = vi.fn(() => ({ fetch: vi.fn() }) as unknown as DurableObjectStub)
  const env = {
    PR_REVIEW_RUN: { idFromName, get } as unknown as DurableObjectNamespace,
    GITHUB_APP_ID: "1",
    GITHUB_PRIVATE_KEY: "k",
  } as unknown as Env
  return { env, idFromName, get }
}

describe("dispatchJob — ci-triage scoping (Codex B2 regression)", () => {
  it("ci-triage flows through case 'ci-triage' unchanged; the DO is never touched", async () => {
    handleCiTriageMock.mockClear()
    const { env, idFromName, get } = makeEnvWithDoSpy()
    const job: JobMessage = {
      type: "ci-triage",
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      // Numeric runId — would falsely match a generic `if (job.runId)`
      // guard, but the wrapper guard is `typeof job.runId === "string"`
      // and is scoped to case "pr-review" only.
      runId: 12345,
      headSha: "a".repeat(40),
      installationId: 99,
    }
    await dispatchJob(job, env)
    expect(handleCiTriageMock).toHaveBeenCalledOnce()
    expect(handleCiTriageMock.mock.calls[0]?.[0]).toMatchObject({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 7,
      runId: 12345,
    })
    // The DO must not have been touched.
    expect(idFromName).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })
})
