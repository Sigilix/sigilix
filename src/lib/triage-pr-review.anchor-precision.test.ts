// SIG-436: the deterministic inline anchor-precision pass (default OFF behind
// OPENCLAW_ANCHOR_PRECISION). These suites pin the comment-aware classifiers, the
// `codeOnly` substantive-anchor walk, the single-line structured-fix re-home, and
// the end-to-end submission behavior (flag OFF reproduces the bug; flag ON lands
// on the buggy line; recall-safe body-demote; suggestions). Split out of
// `triage-pr-review.anchor-render.test.ts` for the file-size budget (COMPLIANCE §4).

import { describe, expect, it } from "vitest"
import {
  buildReviewSubmission,
  isSubstantiveCodeAnchorLine,
  pickSubstantiveAnchorLineForward,
  rehomeSuggestionAnchorForward,
  stripWholeLineComment,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"

describe("stripWholeLineComment (SIG-436)", () => {
  it("strips a whole-line `//` or `#` comment to empty", () => {
    expect(stripWholeLineComment("  // a note")).toBe("")
    expect(stripWholeLineComment("// a note")).toBe("")
    expect(stripWholeLineComment("# a note")).toBe("")
  })

  it("strips a one-line block comment, keeping code after a same-line close", () => {
    expect(stripWholeLineComment("  /* a note */")).toBe("")
    expect(stripWholeLineComment("  /* lead */ const x = 1")).toBe("const x = 1")
    expect(stripWholeLineComment("  /* unterminated block")).toBe("")
  })

  it("strips a JSDoc continuation / close line", () => {
    expect(stripWholeLineComment("   * jsdoc continuation")).toBe("")
    expect(stripWholeLineComment("   */")).toBe("")
    expect(stripWholeLineComment("   */ trailing()")).toBe("trailing()")
  })

  it("strips a JSX comment (incl. the closing brace), keeping code after the close", () => {
    expect(stripWholeLineComment("  {/* note */}")).toBe("")
    expect(stripWholeLineComment("  {/* note */} <Foo/>")).toBe("<Foo/>")
  })

  it("does NOT strip a trailing comment after code (keeps the code)", () => {
    expect(stripWholeLineComment("  const x = 1 // note")).toBe("const x = 1 // note")
    expect(stripWholeLineComment("  return f() // ok")).toBe("return f() // ok")
  })

  it("treats a real `# ` comment and a `#!` shebang as a comment, but NOT a TS `#private` field", () => {
    // `#` is a comment only when it's the whole line, or `#` + whitespace, or a
    // `#!` shebang — NOT `#identifier` (a TS private field/method is real code).
    expect(stripWholeLineComment("# a shell/yaml comment")).toBe("")
    expect(stripWholeLineComment("#!/usr/bin/env node")).toBe("")
    expect(stripWholeLineComment("#")).toBe("")
    // TS private fields/methods stay as code (review-bug recall risk if stripped).
    expect(stripWholeLineComment("  #count = 0")).toBe("#count = 0")
    expect(stripWholeLineComment("  #flush(): void {")).toBe("#flush(): void {")
  })
})

describe("isSubstantiveCodeAnchorLine (SIG-436)", () => {
  it("rejects everything the base classifier rejects", () => {
    expect(isSubstantiveCodeAnchorLine(undefined)).toBe(false)
    expect(isSubstantiveCodeAnchorLine("")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("  ")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("}")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("});")).toBe(false)
  })

  it("rejects a whole-line comment (the SIG-436 fix)", () => {
    expect(isSubstantiveCodeAnchorLine("  // Build a stable key for dedupe.")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("  /* validate the amount */")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("   * jsdoc continuation")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("   */")).toBe(false)
  })

  it("rejects a JSX comment-only line and a comment followed only by punctuation", () => {
    expect(isSubstantiveCodeAnchorLine("  {/* a note */}")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("  /* note */ );")).toBe(false)
  })

  it("rejects a multi-line block-comment MIDDLE line", () => {
    // Inside a /* … */ block each interior line starts with `*` → comment.
    expect(isSubstantiveCodeAnchorLine("   * this line is part of a block comment")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("   *")).toBe(false)
  })

  it("ACCEPTS real code, including code with a trailing comment", () => {
    expect(isSubstantiveCodeAnchorLine("  const dedupeKey = `${runId}`")).toBe(true)
    expect(isSubstantiveCodeAnchorLine("  return result")).toBe(true)
    expect(isSubstantiveCodeAnchorLine("  const x = 1 // note")).toBe(true)
    // a one-line block comment FOLLOWED by code is real code.
    expect(isSubstantiveCodeAnchorLine("  /* lead */ doWork()")).toBe(true)
  })

  it("ACCEPTS TS `#private` fields/methods (they are code, not comments)", () => {
    expect(isSubstantiveCodeAnchorLine("  #count = 0")).toBe(true)
    expect(isSubstantiveCodeAnchorLine("  #flush(): void {")).toBe(true)
    expect(isSubstantiveCodeAnchorLine("  this.#count += 1")).toBe(true)
  })

  it("ACCEPTS generator methods starting with `*` (not block-comment continuations)", () => {
    expect(isSubstantiveCodeAnchorLine("  *entries() {")).toBe(true)
    expect(isSubstantiveCodeAnchorLine("  *[Symbol.iterator]() {")).toBe(true)
    // but a real JSDoc continuation / bare star / close is still a comment
    expect(isSubstantiveCodeAnchorLine("  * a continuation")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("  *")).toBe(false)
    expect(isSubstantiveCodeAnchorLine("  */")).toBe(false)
  })
})

describe("pickSubstantiveAnchorLineForward codeOnly (SIG-436)", () => {
  // The signature failure: the model anchors at the `//` comment (line 117)
  // describing the bug; the bug is the next line (118).
  const lines = new Map<number, string>([
    [116, "    const attemptIndex = Number(raw.attempt ?? 0)"], // code
    [117, "    // Build a stable key so a re-delivered event is dropped."], // comment ABOVE the bug
    [118, "    const dedupeKey = `${raw.runId}:${attemptIndex}`"], // THE BUG
    [119, "    return out"], // code
  ])

  it("codeOnly=false (default): STOPS on the comment line (reproduces the bug)", () => {
    expect(pickSubstantiveAnchorLineForward(lines, 117)).toBe(117)
  })

  it("codeOnly=true: SKIPS the comment and lands on the bug line below it (the fix)", () => {
    expect(pickSubstantiveAnchorLineForward(lines, 117, undefined, true)).toBe(118)
  })

  it("codeOnly=true: a fast-path code line is unchanged", () => {
    expect(pickSubstantiveAnchorLineForward(lines, 118, undefined, true)).toBe(118)
    expect(pickSubstantiveAnchorLineForward(lines, 116, undefined, true)).toBe(116)
  })

  it("codeOnly=true: recall-safe — a comment with NO code line after it in window → null (body-demote, not wrong line)", () => {
    const tail = new Map<number, string>([
      [10, "    const real = compute()"],
      [11, "    // trailing comment, nothing substantive after"],
    ])
    // forward-only: nothing code after 11 → null (the caller body-demotes).
    expect(pickSubstantiveAnchorLineForward(tail, 11, undefined, true)).toBeNull()
    // and it never drifts backward without a range arg.
    expect(pickSubstantiveAnchorLineForward(tail, 11, undefined, false)).toBe(11)
  })
})

describe("buildReviewSubmission anchor precision (SIG-436, end-to-end)", () => {
  // A finding the model anchored to the `// comment` line (117) above the bug
  // (118), with the real diff text supplied so the substantive walk runs.
  const addedLineTextByLine = new Map<string, Map<number, string>>([
    [
      "src/parse/event.ts",
      new Map<number, string>([
        [116, "    const attemptIndex = Number(raw.attempt ?? 0)"],
        [117, "    // Build a stable key so a re-delivered event is dropped."],
        [118, "    const dedupeKey = `${raw.runId}:${attemptIndex}`"],
        [119, "    return out"],
      ]),
    ],
  ])
  const commentAnchoredFinding: PrReviewFinding = {
    path: "src/parse/event.ts",
    line: 117, // the comment line, one above the bug
    score: 4,
    category: "logic",
    headline: "`dedupeKey` omits `attemptKind`, collapsing distinct events",
    body: "The dedupe key is built from runId + attemptIndex only, so two distinct-kind events with the same attempt are dropped as duplicates.",
  }
  const verdictOf = (f: PrReviewFinding): PrReviewVerdict => ({
    summary: "Dedup bug.",
    confidence: 4,
    confidenceReason: "Logic specialist.",
    findings: [f],
  })

  it("flag OFF (default): publishes the inline comment ON the comment line (the bug, reproduced)", () => {
    const out = buildReviewSubmission({
      verdict: verdictOf(commentAnchoredFinding),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(117) // lands on the comment — WRONG
  })

  it("flag ON: re-homes the inline comment onto the buggy code line below the comment (the fix)", () => {
    const out = buildReviewSubmission({
      verdict: verdictOf(commentAnchoredFinding),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
      anchorPrecision: true,
    })
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(118) // lands on the bug — CORRECT
  })

  it("flag ON: a finding already on a code line is untouched (no spurious move)", () => {
    const onCode: PrReviewFinding = { ...commentAnchoredFinding, line: 118 }
    const out = buildReviewSubmission({
      verdict: verdictOf(onCode),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
      anchorPrecision: true,
    })
    expect(out.comments?.[0]?.line).toBe(118)
  })

  it("flag ON: NEVER drops the finding — a comment with no code after it body-demotes (recall-safe)", () => {
    const tailText = new Map<string, Map<number, string>>([
      [
        "src/parse/event.ts",
        new Map<number, string>([
          [200, "    const real = compute()"],
          [201, "    // trailing comment with nothing substantive after it"],
        ]),
      ],
    ])
    const tailFinding: PrReviewFinding = { ...commentAnchoredFinding, line: 201 }
    const out = buildReviewSubmission({
      verdict: verdictOf(tailFinding),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine: tailText,
      anchorPrecision: true,
    })
    // Not posted inline on the wrong (comment) line; surfaced in the body instead.
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("omits `attemptKind`")
  })

  it("flag OFF: a comment-anchored single-line SUGGESTION stays on the comment line", () => {
    // A committable suggestion the model anchored to the comment line (117).
    const fixOnComment: PrReviewFinding = {
      ...commentAnchoredFinding,
      line: 117,
      kind: "replace",
      suggestedReplacement: "    const dedupeKey = `${raw.runId}:${attemptIndex}:${attemptKind}`",
    }
    const out = buildReviewSubmission({
      verdict: verdictOf(fixOnComment),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.comments?.[0]?.line).toBe(117) // on the comment — WRONG (default)
  })

  it("flag ON: a comment-anchored single-line SUGGESTION is re-homed onto the bug line", () => {
    const fixOnComment: PrReviewFinding = {
      ...commentAnchoredFinding,
      line: 117,
      kind: "replace",
      suggestedReplacement: "    const dedupeKey = `${raw.runId}:${attemptIndex}:${attemptKind}`",
    }
    const out = buildReviewSubmission({
      verdict: verdictOf(fixOnComment),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
      anchorPrecision: true,
    })
    expect(out.comments?.[0]?.line).toBe(118) // re-homed onto the bug — CORRECT
  })

  it("flag ON: a MULTI-LINE suggestion range is NOT moved (only single-line suggestions re-home)", () => {
    const rangedFix: PrReviewFinding = {
      ...commentAnchoredFinding,
      line: 118,
      startLine: 117, // range spans the comment + the bug — do not move
      kind: "replace",
      suggestedReplacement: "    // key\n    const dedupeKey = `${raw.runId}:${attemptIndex}:${attemptKind}`",
    }
    const out = buildReviewSubmission({
      verdict: verdictOf(rangedFix),
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
      anchorPrecision: true,
    })
    // Unchanged: the multi-line range is left exactly where the model put it.
    expect(out.comments?.[0]?.line).toBe(118)
    expect(out.comments?.[0]?.start_line).toBe(117)
  })
})

describe("rehomeSuggestionAnchorForward (SIG-436 suggestion path)", () => {
  const added = new Map<string, Map<number, string>>([
    [
      "src/parse/event.ts",
      new Map<number, string>([
        [110, "  // Build a stable key so a re-delivered event is dropped."],
        [111, "  const dedupeKey = `${raw.runId}:${attemptIndex}`"],
      ]),
    ],
  ])
  const base: PrReviewFinding = {
    path: "src/parse/event.ts",
    line: 110,
    score: 4,
    category: "logic",
    scope: "line",
    headline: "dedupeKey omits attemptKind",
    body: "...",
    kind: "replace",
    suggestedReplacement: "  const dedupeKey = `${raw.runId}:${attemptIndex}:${attemptKind}`",
  }

  it("re-homes a single-line suggestion off the comment onto the code line below", () => {
    const out = rehomeSuggestionAnchorForward(base, undefined, added)
    expect(out.line).toBe(111)
  })

  it("is a no-op for a finding WITHOUT a structured fix", () => {
    const { kind: _k, suggestedReplacement: _s, ...noFix } = base
    expect(rehomeSuggestionAnchorForward(noFix as PrReviewFinding, undefined, added).line).toBe(110)
  })

  it("is a no-op for a MULTI-LINE suggestion (startLine != line)", () => {
    const ranged: PrReviewFinding = { ...base, line: 111, startLine: 110 }
    const out = rehomeSuggestionAnchorForward(ranged, undefined, added)
    expect(out.line).toBe(111)
    expect(out.startLine).toBe(110)
  })

  it("is a no-op when the anchor is already a substantive code line", () => {
    const onCode: PrReviewFinding = { ...base, line: 111 }
    expect(rehomeSuggestionAnchorForward(onCode, undefined, added).line).toBe(111)
  })

  it("is a no-op (recall-safe) when there is no code line after the comment", () => {
    const tail = new Map<string, Map<number, string>>([
      ["src/parse/event.ts", new Map<number, string>([[200, "  // trailing comment only"]])],
    ])
    const onTail: PrReviewFinding = { ...base, line: 200 }
    expect(rehomeSuggestionAnchorForward(onTail, undefined, tail).line).toBe(200)
  })

  it("is a no-op when the added-line map is absent (off-diff)", () => {
    expect(rehomeSuggestionAnchorForward(base, undefined, undefined).line).toBe(110)
  })

  it("is a no-op for a DELETION suggestion (never re-home an empty-suggestion onto real code)", () => {
    // A deletion the model anchored to the comment line (kind:"delete" + empty
    // replacement = isDeletionSuggestion). Re-homing it would turn it into a
    // one-click delete of the code line below — never allowed.
    const deletion: PrReviewFinding = { ...base, kind: "delete", suggestedReplacement: "" }
    expect(rehomeSuggestionAnchorForward(deletion, undefined, added).line).toBe(110)
  })

  it("is a no-op when the anchor is a brace/blank/structural line (only comments re-home)", () => {
    // The pre-SIG-436 structured-fix shield left brace/blank anchors alone; the
    // re-home must too — it ONLY fires for a whole-line comment.
    const braceMap = new Map<string, Map<number, string>>([
      [
        "src/parse/event.ts",
        new Map<number, string>([
          [110, "  }"],
          [111, "  const x = compute()"],
        ]),
      ],
    ])
    const onBrace: PrReviewFinding = { ...base, line: 110 }
    expect(rehomeSuggestionAnchorForward(onBrace, undefined, braceMap).line).toBe(110)
  })
})
