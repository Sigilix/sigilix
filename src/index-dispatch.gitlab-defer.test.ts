// sig-gitlab-adapter (GitLab support PR 2): the `gitlab-mr-review` dispatch case
// DEFERS (logs + returns) — the consumer that runs the GitLab ensemble is PR-3.
// This pins the recall-safe contract: deferring is acknowledged loudly, never a
// silent pass of an existing capability (GitLab review does not exist yet).

import { afterEach, describe, expect, it, vi } from "vitest"
import { dispatchJob } from "@/src/index-dispatch"
import type { JobMessage } from "@/src/shared/types/job"
import type { Env } from "@/src/shared/types/env"

const JOB: Extract<JobMessage, { type: "gitlab-mr-review" }> = {
  type: "gitlab-mr-review",
  projectPath: "grp/sub/proj",
  projectId: 42,
  mrIid: 7,
  headSha: "c".repeat(40),
  baseSha: "b".repeat(40),
  sourceBranch: "feature/x",
  targetBranch: "main",
  deliveryId: "d-1",
}

afterEach(() => vi.restoreAllMocks())

describe("dispatchJob — gitlab-mr-review (deferred to PR-3)", () => {
  it("logs a `gitlab-mr-review-deferred` event and resolves without throwing", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await expect(dispatchJob(JOB, {} as Env)).resolves.toBeUndefined()
    const logged = logSpy.mock.calls.map((c) => String(c[0]))
    expect(logged.some((l) => l.includes("gitlab-mr-review-deferred"))).toBe(true)
  })
})
