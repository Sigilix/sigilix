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
})
