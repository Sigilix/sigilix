// SIG-304: the per-finding code-context slicer (display evidence for the rich panel).

import { describe, it, expect } from "vitest"
import { parseDiffLines, sliceCodeContext, attachCodeContextToReview } from "./diff-code-context"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -1,3 +1,5 @@",
  " const a = 1", // ctx  old1 new1
  "-const b = 2", // del  old2
  "+const b = 3", // add  new2
  "+const c = 4", // add  new3
  " const d = 5", // ctx  old3 new4
  " const e = 6", // ctx  old4 new5
  "",
].join("\n")

const finding = (o: Partial<PrReviewFinding>): PrReviewFinding =>
  ({ path: "src/x.ts", line: 1, score: 4, category: "logic", headline: "h", body: "b", ...o }) as PrReviewFinding

describe("parseDiffLines", () => {
  it("captures text + side line numbers + kind per line", () => {
    const m = parseDiffLines(DIFF)
    const lines = m.get("src/x.ts")!
    expect(lines.find((l) => l.text === "const b = 3")).toMatchObject({ newNumber: 2, kind: "add" })
    expect(lines.find((l) => l.text === "const b = 2")).toMatchObject({ oldNumber: 2, kind: "del" })
    expect(lines.find((l) => l.text === "const a = 1")).toMatchObject({ newNumber: 1, oldNumber: 1, kind: "ctx" })
  })
})

describe("sliceCodeContext", () => {
  it("returns a window around an added line (RIGHT side, new-file number)", () => {
    const ctx = sliceCodeContext(DIFF, finding({ line: 3 })) // new line 3 = `const c = 4`
    expect(ctx).toBeDefined()
    expect(ctx!.side).toBe("RIGHT")
    expect(ctx!.lines.some((l) => l.text === "const c = 4")).toBe(true)
    // includes surrounding context (CTX lines before/after the matched line)
    expect(ctx!.lines.some((l) => l.kind === "ctx" && l.text === "const d = 5")).toBe(true)
  })
  it("honors a multi-line range (startLine..line)", () => {
    const ctx = sliceCodeContext(DIFF, finding({ startLine: 2, line: 3 }))
    expect(ctx!.lines.filter((l) => l.kind === "add")).toHaveLength(2) // both added lines
  })
  it("a LEFT anchor matches the OLD-file line of a deletion", () => {
    const ctx = sliceCodeContext(DIFF, finding({ line: 2, anchorSide: "LEFT" })) // old line 2 = deleted `const b = 2`
    expect(ctx!.side).toBe("LEFT")
    expect(ctx!.lines.some((l) => l.kind === "del" && l.text === "const b = 2")).toBe(true)
  })
  it("returns undefined for a path not in the diff (graceful — no panel)", () => {
    expect(sliceCodeContext(DIFF, finding({ path: "src/other.ts", line: 1 }))).toBeUndefined()
  })
  it("returns undefined when the finding line is outside every hunk", () => {
    expect(sliceCodeContext(DIFF, finding({ line: 999 }))).toBeUndefined()
  })
  it("caps a huge window and flags truncated", () => {
    const big = ["diff --git a/b.ts b/b.ts", "--- a/b.ts", "+++ b/b.ts", "@@ -1,1 +1,40 @@"]
    for (let i = 1; i <= 40; i++) big.push(`+line ${i}`)
    const ctx = sliceCodeContext(big.join("\n"), finding({ path: "b.ts", startLine: 1, line: 40 }))
    expect(ctx!.truncated).toBe(true)
    expect(ctx!.lines.length).toBeLessThanOrEqual(16)
  })
})

describe("attachCodeContextToReview", () => {
  const review = {
    verdict: { summary: "s", confidence: 4, findings: [finding({ line: 3 }), finding({ path: "nope.ts", line: 1 })] },
    unanchoredFindings: [finding({ line: 2, anchorSide: "LEFT" as const })],
  }
  it("attaches codeContext to matching findings in BOTH lists, leaves non-matches unchanged", () => {
    const out = attachCodeContextToReview(review, DIFF)
    expect(out.verdict.findings[0]!.codeContext).toBeDefined() // src/x.ts line 3 matched
    expect(out.verdict.findings[1]!.codeContext).toBeUndefined() // nope.ts → no panel
    expect(out.unanchoredFindings[0]!.codeContext?.side).toBe("LEFT")
  })
  it("does not mutate the input review", () => {
    attachCodeContextToReview(review, DIFF)
    expect(review.verdict.findings[0]!.codeContext).toBeUndefined()
  })
})
