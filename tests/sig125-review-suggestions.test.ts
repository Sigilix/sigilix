import { describe, expect, it } from "vitest"
import { formatFindingComment } from "../src/lib/triage-pr-review"
import { parseDiffToReviewablePositions } from "../src/lib/diff-positions"
import type { PrReviewFinding } from "../src/lib/triage-pr-review"

const reviewable = parseDiffToReviewablePositions(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+const x = 1\n+const y = 2\n",
)
function finding(over: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/a.ts", line: 1, score: 4, category: "performance",
    headline: "h", body: "b", confidence: 5,
    suggestedReplacement: "const x = batch(1)", ...over,
  } as PrReviewFinding
}

describe("formatFindingComment two-tier suggestions (SIG-125)", () => {
  it("committable ```suggestion when confidence>=4 AND anchorable", () => {
    const out = formatFindingComment(finding(), 5, reviewable)
    expect(out).toContain("```suggestion")
    expect(out).toContain("const x = batch(1)")
  })
  it("non-committable snippet when confidence<4 (still shows the change)", () => {
    const out = formatFindingComment(finding(), 3, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
    expect(out).toContain("const x = batch(1)")
  })
  it("non-committable snippet when not anchorable (line absent from diff)", () => {
    const out = formatFindingComment(finding({ path: "src/other.ts" }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
  })
  it("committable for a multi-line range when every line is reviewable (startLine<line)", () => {
    // lines 1..2 are both RIGHT-reviewable in the fixture diff
    const out = formatFindingComment(finding({ startLine: 1, line: 2 }), 5, reviewable)
    expect(out).toContain("```suggestion")
  })
  it("downgrades a multi-line range to a snippet when a line is outside the diff", () => {
    // line 5 (and 3,4) are absent from the fixture → not contiguous-reviewable
    const out = formatFindingComment(finding({ startLine: 1, line: 5 }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
  })
  it("prose only when no suggestedReplacement", () => {
    const out = formatFindingComment(finding({ suggestedReplacement: undefined }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).not.toContain("```ts")
  })
  it("falls back to snippet when no reviewable map is supplied", () => {
    const out = formatFindingComment(finding(), 5)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("```ts")
  })
})

describe("formatFindingComment backtick hardening (SIG-125 Task 5)", () => {
  it("uses a longer fence when the replacement contains a triple backtick", () => {
    // replacement contains exactly a 3-backtick run; the snippet fence must
    // therefore widen to >= 4 backticks so it can safely wrap the content.
    const out = formatFindingComment(finding({ confidence: 3, suggestedReplacement: "const s = ```x" }), 3, reviewable)
    // content has a ``` run (3) → fence must be at least 4 backticks
    expect(out).toContain("````ts")
  })
  it("downgrades a high-confidence anchorable finding to a snippet when replacement has a triple backtick (GitHub can't escape it)", () => {
    const out = formatFindingComment(finding({ suggestedReplacement: "a\n```\nb" }), 5, reviewable)
    expect(out).not.toContain("```suggestion")
  })
})
