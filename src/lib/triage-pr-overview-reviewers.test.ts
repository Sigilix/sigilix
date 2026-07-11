import { describe, expect, it } from "vitest"

import { excludePrAuthor } from "@/src/lib/triage-pr-overview-reviewers"

describe("excludePrAuthor", () => {
  it("removes the PR author case-insensitively with an optional mention prefix", () => {
    expect(excludePrAuthor(["alice", " @DaNiEl ", "charlie"], "daniel")).toEqual(["alice", "charlie"])
  })

  it("preserves order and returns a defensive copy when the author is unavailable", () => {
    const reviewers = ["alice", "charlie"]
    const result = excludePrAuthor(reviewers, null)

    expect(result).toEqual(reviewers)
    expect(result).not.toBe(reviewers)
  })

  it("returns undefined when every suggested reviewer is the PR author", () => {
    expect(excludePrAuthor(["daniel", "@DANIEL"], "daniel")).toBeUndefined()
  })
})
