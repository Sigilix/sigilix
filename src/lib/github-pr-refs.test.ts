import { describe, expect, it } from "vitest"
import { extractPullRequestRefs } from "@/src/lib/github-pr-refs"

const noInfer = () => null
const arcInfer = () => ({ owner: "Sigilix", repo: "rema-portal" })

describe("extractPullRequestRefs", () => {
  it("extracts a full PR URL", () => {
    const refs = extractPullRequestRefs(
      "is this done via https://github.com/Sigilix/rema-portal/pull/162",
      noInfer
    )
    expect(refs).toEqual([
      { owner: "Sigilix", repo: "rema-portal", number: 162, source: "url" },
    ])
  })

  it("strips /files, /commits, anchors, and query strings", () => {
    const refs = extractPullRequestRefs(
      [
        "https://github.com/o/r/pull/1/files",
        "https://github.com/o/r/pull/2/commits",
        "https://github.com/o/r/pull/3#discussion_r1",
        "https://github.com/o/r/pull/4?diff=split",
      ].join(" "),
      noInfer
    )
    expect(refs.map((r) => r.number)).toEqual([1, 2])
  })

  it("dedupes repeated URLs", () => {
    const refs = extractPullRequestRefs(
      "see https://github.com/o/r/pull/5 and again https://github.com/o/r/pull/5",
      noInfer
    )
    expect(refs).toHaveLength(1)
    expect(refs[0].number).toBe(5)
  })

  it("caps at 2 unique refs", () => {
    const refs = extractPullRequestRefs(
      [
        "https://github.com/o/r/pull/1",
        "https://github.com/o/r/pull/2",
        "https://github.com/o/r/pull/3",
      ].join(" "),
      noInfer
    )
    expect(refs).toHaveLength(2)
    expect(refs.map((r) => r.number)).toEqual([1, 2])
  })

  it("matches bare 'PR #N' when inferRepo returns a value", () => {
    const refs = extractPullRequestRefs("@arc this is technically done right via PR #162?", arcInfer)
    expect(refs).toEqual([
      { owner: "Sigilix", repo: "rema-portal", number: 162, source: "bare-pr-n" },
    ])
  })

  it("does NOT match bare 'PR #N' when inferRepo returns null", () => {
    const refs = extractPullRequestRefs("done via PR #162?", noInfer)
    expect(refs).toEqual([])
  })

  it("matches 'pull request #N' variant", () => {
    const refs = extractPullRequestRefs("see pull request #99", arcInfer)
    expect(refs).toHaveLength(1)
    expect(refs[0].number).toBe(99)
  })

  it("never matches bare '#N' without 'PR ' prefix (Linear issue ID safety)", () => {
    const refs = extractPullRequestRefs("see #162 and #163", arcInfer)
    expect(refs).toEqual([])
  })

  it("extracts both full URL and bare PR in one comment", () => {
    const refs = extractPullRequestRefs(
      "compare https://github.com/Sigilix/rema-portal/pull/100 and PR #200",
      arcInfer
    )
    expect(refs).toHaveLength(2)
    expect(refs.map((r) => r.source).sort()).toEqual(["bare-pr-n", "url"])
  })

  it("returns empty array for empty / whitespace input", () => {
    expect(extractPullRequestRefs("", arcInfer)).toEqual([])
    expect(extractPullRequestRefs("   \n\t", arcInfer)).toEqual([])
  })

  it("ignores PR numbers that are zero or non-numeric noise", () => {
    const refs = extractPullRequestRefs("PR #0 then PR #abc then PR #5", arcInfer)
    expect(refs.map((r) => r.number)).toEqual([5])
  })

  it("matches 'PR #N' inside common punctuation: (), [], commas", () => {
    const cases = ["(PR #5)", "[PR #6]", ",PR #7,", "see (PR #8) please"]
    for (const c of cases) {
      const refs = extractPullRequestRefs(c, arcInfer)
      expect(refs).toHaveLength(1)
    }
  })

  it("does NOT match when 'PR' is glued to surrounding word characters", () => {
    // MyPR #5 / aPR #5 / 1PR #5 — not a real PR reference, just text.
    expect(extractPullRequestRefs("MyPR #5", arcInfer)).toEqual([])
    expect(extractPullRequestRefs("aPR #5", arcInfer)).toEqual([])
    expect(extractPullRequestRefs("1PR #5", arcInfer)).toEqual([])
  })
})
