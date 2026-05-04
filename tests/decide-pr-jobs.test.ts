// Gating contract for pull_request webhook routing — decides which
// per-PR jobs the worker enqueues for a given action / draft state.
// The webhook handler in src/index.ts uses this same helper, so this
// test file is the source of truth for the gating intent.

import { describe, expect, it } from "vitest"
import { decidePullRequestJobs } from "../src/index"

describe("decidePullRequestJobs", () => {
  it("enqueues both overview and review on opened", () => {
    expect(decidePullRequestJobs({ action: "opened", draft: false })).toEqual({
      overview: true,
      review: true,
    })
  })

  it("enqueues both overview and review on synchronize (re-review on push)", () => {
    expect(decidePullRequestJobs({ action: "synchronize", draft: false })).toEqual({
      overview: true,
      review: true,
    })
  })

  it("enqueues both overview and review on ready_for_review (covers drafts flipping to ready)", () => {
    expect(decidePullRequestJobs({ action: "ready_for_review", draft: false })).toEqual({
      overview: true,
      review: true,
    })
  })

  it("enqueues only overview on reopened (diff didn't change, re-reviewing would be noise)", () => {
    expect(decidePullRequestJobs({ action: "reopened", draft: false })).toEqual({
      overview: true,
      review: false,
    })
  })

  it("enqueues nothing for drafts regardless of action", () => {
    for (const action of ["opened", "synchronize", "reopened", "ready_for_review"]) {
      expect(decidePullRequestJobs({ action, draft: true })).toEqual({
        overview: false,
        review: false,
      })
    }
  })

  it("enqueues nothing for unsupported actions", () => {
    for (const action of ["closed", "edited", "labeled", "assigned", ""]) {
      expect(decidePullRequestJobs({ action, draft: false })).toEqual({
        overview: false,
        review: false,
      })
    }
  })

  describe("release-promotion skip rule", () => {
    it("skips pr-review on dev → main when skipReleasePromotions=true", () => {
      const out = decidePullRequestJobs({
        action: "opened",
        draft: false,
        baseRef: "main",
        headRef: "dev",
        skipReleasePromotions: true,
      })
      expect(out).toEqual({ overview: true, review: false })
    })

    it.each([
      ["dev", "main"],
      ["develop", "main"],
      ["staging", "main"],
      ["dev", "master"],
      ["dev", "release"],
      ["dev", "production"],
      ["development", "prod"],
    ])("skips pr-review on %s → %s with flag on", (head, base) => {
      const out = decidePullRequestJobs({
        action: "synchronize",
        draft: false,
        baseRef: base,
        headRef: head,
        skipReleasePromotions: true,
      })
      expect(out.review).toBe(false)
      expect(out.overview).toBe(true)
    })

    it("does NOT skip on feature → main even with flag on", () => {
      // Feature branches → main need full review (they haven't been
      // reviewed elsewhere first).
      const out = decidePullRequestJobs({
        action: "opened",
        draft: false,
        baseRef: "main",
        headRef: "feat/add-login",
        skipReleasePromotions: true,
      })
      expect(out).toEqual({ overview: true, review: true })
    })

    it("does NOT skip when flag is off (default behavior)", () => {
      const out = decidePullRequestJobs({
        action: "opened",
        draft: false,
        baseRef: "main",
        headRef: "dev",
        skipReleasePromotions: false,
      })
      expect(out).toEqual({ overview: true, review: true })
    })

    it("matches branch names case-insensitively", () => {
      const out = decidePullRequestJobs({
        action: "opened",
        draft: false,
        baseRef: "MAIN",
        headRef: "DEV",
        skipReleasePromotions: true,
      })
      expect(out.review).toBe(false)
    })
  })
})
