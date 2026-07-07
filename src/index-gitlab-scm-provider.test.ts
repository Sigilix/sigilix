// GitLab SCM provider — the event->review-trigger mapping + the plaintext-token
// verify adapter. Pins that GitLab's action vocabulary maps onto GitHub's and
// delegates to the SAME pure `decidePullRequestJobs`, so the trigger decision is
// byte-identical to GitHub's (notably `reopen` -> overview-only, no re-review).

import { describe, expect, it } from "vitest"
import { GitLabScmProvider, mapGitLabActionToGitHubAction } from "@/src/index-gitlab-scm-provider"
import type { ScmReviewEventInput } from "@/src/lib/ensemble/ports"

const provider = new GitLabScmProvider()

function decide(action: string, over: Partial<ScmReviewEventInput> = {}) {
  return provider.parseReviewEvent({ action, draft: false, ...over })
}

describe("mapGitLabActionToGitHubAction", () => {
  it("maps the review-triggering actions onto the GitHub vocab", () => {
    expect(mapGitLabActionToGitHubAction("open")).toBe("opened")
    expect(mapGitLabActionToGitHubAction("reopen")).toBe("reopened")
    expect(mapGitLabActionToGitHubAction("update")).toBe("synchronize")
  })

  it("returns null (skip) for non-review actions", () => {
    for (const a of ["merge", "close", "approved", "unapproved", "approval", ""]) {
      expect(mapGitLabActionToGitHubAction(a)).toBeNull()
    }
  })
})

describe("GitLabScmProvider.parseReviewEvent", () => {
  it("open -> overview + review (first review)", () => {
    expect(decide("open")).toEqual({ overview: true, review: true })
  })

  it("update -> overview + review (re-review on push)", () => {
    expect(decide("update")).toEqual({ overview: true, review: true })
  })

  it("reopen -> overview ONLY, no re-review (GitHub `reopened` parity)", () => {
    expect(decide("reopen")).toEqual({ overview: true, review: false })
  })

  it("merge / close -> skip both", () => {
    expect(decide("merge")).toEqual({ overview: false, review: false })
    expect(decide("close")).toEqual({ overview: false, review: false })
  })

  it("a draft MR skips both regardless of action", () => {
    expect(decide("open", { draft: true })).toEqual({ overview: false, review: false })
    expect(decide("update", { draft: true })).toEqual({ overview: false, review: false })
  })

  it("a `@sigilix ignore` MR description opts out of all review routing", () => {
    expect(decide("open", { prBody: "@sigilix ignore" })).toEqual({ overview: false, review: false })
  })

  it("honors the release-promotion skip when enabled (dev -> main)", () => {
    expect(decide("update", { baseRef: "main", headRef: "develop", skipReleasePromotions: true })).toEqual({
      overview: true,
      review: false,
    })
  })
})

describe("GitLabScmProvider.verifyWebhook", () => {
  it("accepts a matching token, rejects a mismatch (token in the signature field)", async () => {
    await expect(provider.verifyWebhook({ rawBody: "{}", signature: "tok", secret: "tok" })).resolves.toBe(true)
    await expect(provider.verifyWebhook({ rawBody: "{}", signature: "wrong", secret: "tok" })).resolves.toBe(false)
  })
})
