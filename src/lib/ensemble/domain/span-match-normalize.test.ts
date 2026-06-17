// SIG-464: the model paraphrases quoted code (normalizes quote style, reflows
// whitespace), so an exact substring match of a quoted span misses the diff line.
// Live miss — probe sigilix-monitor#41: a deleted guard `… !== "number" …` (double
// quotes in the file) quoted by the model with single quotes (`'number'`), so the
// deletion finding fell back to `} catch {` instead of anchoring on the removed
// line. `codeSpanPresentInLine` normalizes quotes + whitespace for punctuated spans
// (keeping the whole-token rule for identifiers), so both the RIGHT snap (SIG-462)
// and the LEFT deletion snap (SIG-463) match despite the paraphrase.

import { describe, expect, it } from "vitest"
import { parseDiffToReviewablePositions, type ReviewableMap } from "@/src/shared/util/diff-positions"
import { buildAddedLineTextByLine, buildDeletedLineTextByLine } from "@/src/features/ast-rules"
import {
  codeSpanPresentInLine,
  snapFindingLineToQuotedCode,
  snapFindingLineToDeletedCode,
} from "@/src/lib/ensemble/domain/validation-internals"
import { baseFinding } from "@/src/lib/triage-pr-review-ensemble.test-helpers"
import type { PrReviewFinding } from "@/src/shared/domain/pr-review-finding"

describe("SIG-464: codeSpanPresentInLine — quote/whitespace normalized matching", () => {
  it("matches a punctuated span across a quote-style paraphrase (double vs single quotes)", () => {
    const line = '    if (typeof payload.exp !== "number" || nowMs > payload.exp) return null;'
    const span = "if (typeof payload.exp !== 'number' || nowMs > payload.exp) return null;"
    expect(codeSpanPresentInLine(line, span)).toBe(true)
  })

  it("matches across reflowed whitespace", () => {
    expect(codeSpanPresentInLine("  const  x   =   foo(  a, b );", "const x = foo( a, b )")).toBe(true)
  })

  it("keeps the whole-token rule for an identifier span (no substring over-match)", () => {
    expect(codeSpanPresentInLine("return authorizeRequestStrict(req);", "authorizeRequest")).toBe(false)
    expect(codeSpanPresentInLine("return authorizeRequest(req);", "authorizeRequest")).toBe(true)
  })

  it("does not match unrelated code", () => {
    expect(codeSpanPresentInLine("const y = bar(z);", "if (typeof payload.exp !== 'number')")).toBe(false)
  })
})

const PATH = "src/auth/session.ts"
// Deleted guard uses DOUBLE quotes (as in the real file); the finding will quote it
// with SINGLE quotes (the model's paraphrase) — the probe #41 shape.
const GUARD_DOUBLE = 'if (typeof payload.exp !== "number" || nowMs > payload.exp) return null;'
const GUARD_SINGLE = "if (typeof payload.exp !== 'number' || nowMs > payload.exp) return null;"

const DEL_DIFF = [
  `diff --git a/${PATH} b/${PATH}`,
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  "@@ -62,7 +62,6 @@ export async function verifySession(token, secret, nowMs) {",
  "   let payload;",
  "   try {",
  "     payload = JSON.parse(body);",
  "   } catch {",
  `-    ${GUARD_DOUBLE}`,
  "   return payload;",
  " }",
].join("\n")

const ADD_DIFF = [
  `diff --git a/${PATH} b/${PATH}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${PATH}`,
  "@@ -0,0 +1,2 @@",
  `+  ${GUARD_DOUBLE}`,
  "+  return payload;",
].join("\n")

function finding(overrides: Partial<PrReviewFinding>): PrReviewFinding {
  return {
    ...baseFinding,
    path: PATH,
    scope: "line",
    score: 5,
    category: "logic",
    headline: "verifySession no longer rejects expired sessions",
    // The model quotes the guard with SINGLE quotes + a standalone `nowMs` token.
    body: `The removed guard \`${GUARD_SINGLE}\` enforced expiry via \`nowMs\`.`,
    ...overrides,
  }
}

describe("SIG-464: snaps match a paraphrased quoted span (probe #41 regression)", () => {
  it("LEFT deletion snap anchors despite a quote-style paraphrase", () => {
    const reviewable: ReviewableMap = parseDiffToReviewablePositions(DEL_DIFF)
    const added = buildAddedLineTextByLine(DEL_DIFF)
    const deleted = buildDeletedLineTextByLine(DEL_DIFF)
    const guardLine = [...(deleted.get(PATH) ?? new Map<number, string>())].find(([, t]) =>
      t.includes('!== "number"'),
    )?.[0] as number
    // The model anchored to the surviving `} catch {` (a RIGHT context line).
    const catchLine = [...(reviewable.get(PATH) ?? [])]
      .filter((p) => p.side === "RIGHT")
      .map((p) => p.line)
      .find((n) => !added.get(PATH)?.has(n)) as number

    const out = snapFindingLineToDeletedCode(finding({ line: catchLine }), reviewable, deleted, added)
    expect(out.line).toBe(guardLine)
    expect(out.anchorSide).toBe("LEFT")
  })

  it("RIGHT snap anchors a paraphrased span on an added line", () => {
    const reviewable = parseDiffToReviewablePositions(ADD_DIFF)
    const added = buildAddedLineTextByLine(ADD_DIFF)
    const guardLine = [...(added.get(PATH) ?? new Map<number, string>())].find(([, t]) =>
      t.includes('!== "number"'),
    )?.[0] as number
    // Cite a different added line; the paraphrased span should still snap to the guard.
    const out = snapFindingLineToQuotedCode(finding({ line: guardLine + 1 }), reviewable, added)
    expect(out.line).toBe(guardLine)
    expect(out.scope).toBe("line")
  })
})
