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
