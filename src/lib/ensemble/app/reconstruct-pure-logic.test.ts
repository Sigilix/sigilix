// SIG-477 PR-4b — tests for pure-logic source reconstruction. A finding cites only a
// line-level fix; reconstruction must rebuild the full BUGGY + FIXED function from the
// file source so the harness has a liftable pair.

import { describe, it, expect } from "vitest"
import { reconstructPureLogicPair, type ReconstructInput } from "./reconstruct-pure-logic"

// 1: // header
// 2: export function truncateLabel(label: string, maxLen: number): string {
// 3:   let out = "";
// 4:   for (let i = 0; i <= maxLen; i++) {
// 5:     if (i < label.length) {
// 6:       out += label[i];
// 7:     }
// 8:   }
// 9:   return out;
// 10: }
const SRC = [
  "// header",
  "export function truncateLabel(label: string, maxLen: number): string {",
  '  let out = "";',
  "  for (let i = 0; i <= maxLen; i++) {",
  "    if (i < label.length) {",
  "      out += label[i];",
  "    }",
  "  }",
  "  return out;",
  "}",
  "",
].join("\n")

const FIX_LINE = "  for (let i = 0; i < maxLen; i++) {"

const finding = (over: Partial<ReconstructInput> = {}): ReconstructInput => ({
  path: "src/window-metrics.ts",
  line: 4,
  suggestedReplacement: FIX_LINE,
  ...over,
})

describe("reconstructPureLogicPair", () => {
  it("rebuilds the full buggy + fixed function from a line-level fix", () => {
    const pair = reconstructPureLogicPair(SRC, finding())
    expect(pair).not.toBeNull()
    // BUGGY keeps the inclusive bound; FIXED has the exclusive bound and is a full fn.
    expect(pair!.buggy).toContain("<= maxLen")
    expect(pair!.buggy).toContain("function truncateLabel")
    expect(pair!.fixed).toContain("< maxLen")
    expect(pair!.fixed).not.toContain("<= maxLen")
    expect(pair!.fixed).toContain("function truncateLabel")
  })

  it("returns null on a LEFT anchor (old-side line won't resolve in the new-file AST)", () => {
    expect(reconstructPureLogicPair(SRC, finding({ anchorSide: "LEFT" }))).toBeNull()
  })

  it("returns null when there is no source", () => {
    expect(reconstructPureLogicPair(undefined, finding())).toBeNull()
    expect(reconstructPureLogicPair("", finding())).toBeNull()
  })

  it("returns null when there is no suggested fix", () => {
    // omit suggestedReplacement entirely (absent), and the empty/whitespace case.
    expect(reconstructPureLogicPair(SRC, { path: "src/window-metrics.ts", line: 4 })).toBeNull()
    expect(reconstructPureLogicPair(SRC, finding({ suggestedReplacement: "   " }))).toBeNull()
  })

  it("returns null when the line is outside any function (nothing to lift)", () => {
    expect(reconstructPureLogicPair(SRC, finding({ line: 1 }))).toBeNull()
  })

  it("returns null when the fix does not change the function (no two-sided test)", () => {
    // suggestedReplacement identical to the existing buggy line → buggy === fixed.
    expect(
      reconstructPureLogicPair(SRC, finding({ suggestedReplacement: "  for (let i = 0; i <= maxLen; i++) {" })),
    ).toBeNull()
  })

  it("honors a multi-line anchored range [startLine, line]", () => {
    // Replace lines 4-8 (the whole loop) with a one-liner; still yields a full fn that
    // differs from the buggy one.
    const pair = reconstructPureLogicPair(
      SRC,
      finding({
        startLine: 4,
        line: 8,
        suggestedReplacement: "  for (const ch of label.slice(0, maxLen)) { out += ch; }",
      }),
    )
    expect(pair).not.toBeNull()
    expect(pair!.fixed).toContain("label.slice(0, maxLen)")
    expect(pair!.fixed).not.toContain("<= maxLen")
  })
})
