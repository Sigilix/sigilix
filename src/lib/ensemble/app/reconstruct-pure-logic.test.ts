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

  it("reconstructs when startLine is the WIDE enclosing-block (the prod #64 shape)", () => {
    // Real finding: line=4 (the buggy loop) but startLine=2 (the function header), with
    // a SINGLE-line fix. Splicing [2,4] would delete the header → unparseable; the fix
    // must replace just the anchor line [4,4]. (Drove the reconstructed:false in prod.)
    const pair = reconstructPureLogicPair(SRC, finding({ startLine: 2, line: 4 }))
    expect(pair).not.toBeNull()
    expect(pair!.fixed).toContain("function truncateLabel")
    expect(pair!.fixed).toContain("< maxLen")
    expect(pair!.fixed).not.toContain("<= maxLen")
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

  it("SIG-479: a mis-anchored line still reconstructs via near-twin locate", () => {
    // finding.line=1 (outside any function) — but the fix is a near-twin of the buggy
    // loop line, so the tolerant locate finds it anyway and reconstructs truncateLabel.
    const pair = reconstructPureLogicPair(SRC, finding({ line: 1 }))
    expect(pair).not.toBeNull()
    expect(pair!.fixed).toContain("function truncateLabel")
    expect(pair!.fixed).toContain("< maxLen")
  })

  it("SIG-479: anchored to the WRONG function reconstructs the RIGHT one (near-twin, not the dissimilar anchored line)", () => {
    // alpha is buggy; beta is correct. The finding mis-anchors to beta's body (line 6),
    // but the fix is alpha's near-twin (line 2) — the near-twin requirement means we
    // splice alpha (the real bug), NEVER beta (the spurious false-reproduce vector).
    const src = [
      "export function alpha(n: number): number {", // 1
      "  return n <= 0 ? 0 : n + 1;", // 2  ← the bug
      "}", // 3
      "", // 4
      "export function beta(x: number): number {", // 5
      "  return x * 2;", // 6  ← finding mis-anchors HERE
      "}", // 7
      "",
    ].join("\n")
    const pair = reconstructPureLogicPair(src, {
      path: "src/x.ts",
      line: 6,
      suggestedReplacement: "  return n <= 0 ? 0 : n;",
    })
    expect(pair).not.toBeNull()
    expect(pair!.buggy).toContain("function alpha")
    expect(pair!.buggy).toContain("n + 1")
    expect(pair!.buggy).not.toContain("function beta")
    expect(pair!.fixed).toContain("function alpha")
    expect(pair!.fixed).not.toContain("n + 1")
  })

  it("SIG-479 FP-safety: two sibling functions with an IDENTICAL line within proximity → null", () => {
    // validateA is buggy, validateB is correct + has the identical line. The finding
    // mis-anchors at validateB's header (line 4). Both bodies are 1-char near-twins of
    // the fix and within ±12, so proximity must NOT coin-flip to the closer (validateB) —
    // it's ambiguous → null. (code-reviewer-found proximity-branch margin hole.)
    const src = [
      "function validateA(n: number): boolean {", // 1
      "  if (n <= 0) return false;", // 2  ← the real bug
      "  return true;", // 3
      "}", // 4 — NOT here; recount below
      "function validateB(n: number): boolean {", // 5
      "  if (n <= 0) return false;", // 6  ← identical; validateB is correct
      "  return true;", // 7
      "}", // 8
      "",
    ].join("\n")
    const pair = reconstructPureLogicPair(src, {
      path: "src/x.ts",
      line: 5, // validateB's header — both near-twins (line 2 & line 6) are within ±12
      suggestedReplacement: "  if (n < 0) return false;",
    })
    expect(pair).toBeNull()
  })

  it("SIG-479 FP-safety: two equally-similar FAR near-clones → null (the ambiguous-global skip)", () => {
    // `return n + 1` and `return n + 2` are both 1 char from the fix `return n + 3` (a
    // tie). The anchor is far from both (no proximity tie-break), so the global path
    // requires a margin it doesn't have → null, never a coin-flip splice (DeepSeek worst case).
    const filler = Array.from({ length: 24 }, () => "// .").join("\n")
    const src = [
      "function a(n: number): number {",
      "  return n + 1;",
      "}",
      filler,
      "function b(n: number): number {",
      "  return n + 2;",
      "}",
      "",
    ].join("\n")
    const pair = reconstructPureLogicPair(src, {
      path: "src/x.ts",
      line: 15, // far (>12) from both twins (line 2 and line ~29)
      suggestedReplacement: "  return n + 3;",
    })
    expect(pair).toBeNull()
  })

  it("SIG-479 FP-safety: a fix that matches no source line → null (no spurious relocation)", () => {
    const src = "export function f(a: number): number {\n  return a * a;\n}\n"
    const pair = reconstructPureLogicPair(src, {
      path: "src/x.ts",
      line: 1,
      suggestedReplacement: "  return computeWidgetTotalsByRegion(quarter, ledger);",
    })
    expect(pair).toBeNull()
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
