// CI-failure triage → review-synth pure core (PR 1). Every test asserts a
// behavior that would break if the corresponding logic were reverted.

import { describe, expect, it } from "vitest"
import {
  parseCiTriageSynthMode,
  parseCiTriageAnchorRemap,
  buildCiSynthUserMessage,
  isLogGrounded,
  disposeCiFinding,
  ciFindingCoarseKey,
  isCiTestPath,
  isDuplicateOfExistingReview,
  matchesExistingCoarseKey,
  renderCiFindingComment,
  extractFindingSymbols,
  classifyChangedLineForSymbol,
  isLowQualityAnchorLine,
  remapCiFindingAnchor,
  CI_HEDGE_LINE,
  CI_REVIEW_MARKER,
  type CiDedupCandidate,
  type ExistingReviewFindings,
} from "@/src/lib/ci-triage-synth"

describe("parseCiTriageSynthMode", () => {
  it("defaults to off for unset / empty / unknown values (dark default)", () => {
    expect(parseCiTriageSynthMode(undefined)).toBe("off")
    expect(parseCiTriageSynthMode("")).toBe("off")
    expect(parseCiTriageSynthMode("on")).toBe("off")
    expect(parseCiTriageSynthMode("enforced")).toBe("off")
    expect(parseCiTriageSynthMode("true")).toBe("off")
  })
  it("returns shadow only for the literal 'shadow' (trim + case-insensitive)", () => {
    expect(parseCiTriageSynthMode("shadow")).toBe("shadow")
    expect(parseCiTriageSynthMode("  SHADOW ")).toBe("shadow")
  })
  it("returns enforce only for the literal 'enforce' (trim + case-insensitive)", () => {
    expect(parseCiTriageSynthMode("enforce")).toBe("enforce")
    expect(parseCiTriageSynthMode(" Enforce  ")).toBe("enforce")
  })
})

describe("buildCiSynthUserMessage", () => {
  it("threads the diff and the failure log under their labeled sections", () => {
    const msg = buildCiSynthUserMessage({
      ciLog: "FAIL src/a.ts > does the thing\nExpected 1, got 2",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+const y = 2",
      fileContexts: [],
    })
    expect(msg).toContain("[PR DIFF]")
    expect(msg).toContain("diff --git a/src/a.ts b/src/a.ts")
    expect(msg).toContain("[FAILED CI LOG]")
    expect(msg).toContain("Expected 1, got 2")
    // Instructs the verbatim-logExcerpt + diff-anchor grounding contract.
    expect(msg).toContain("logExcerpt")
    expect(msg).toContain("anchor")
  })

  it("includes a file-context section only when file contexts are present", () => {
    const without = buildCiSynthUserMessage({ ciLog: "log", diff: "diff", fileContexts: [] })
    expect(without).not.toContain("[AFFECTED FILE CONTEXT]")

    const withCtx = buildCiSynthUserMessage({
      ciLog: "log",
      diff: "diff",
      fileContexts: [{ path: "src/a.ts", content: "export const x = 1" }],
    })
    expect(withCtx).toContain("[AFFECTED FILE CONTEXT]")
    expect(withCtx).toContain("--- src/a.ts ---")
    expect(withCtx).toContain("export const x = 1")
  })
})

describe("isLogGrounded (the key gate)", () => {
  const log = "  FAIL  src/a.ts > sums two numbers\n    TS2339: Property 'foo' does not exist on type 'Bar'\n"

  it("passes when the excerpt is a verbatim substring of the log", () => {
    expect(isLogGrounded("TS2339: Property 'foo' does not exist on type 'Bar'", log)).toBe(true)
  })

  it("passes despite whitespace differences (normalized substring)", () => {
    // Re-indented + collapsed internal spacing — still grounded.
    expect(isLogGrounded("FAIL   src/a.ts   >   sums two numbers", log)).toBe(true)
    expect(isLogGrounded("  TS2339: Property 'foo' does not exist on type 'Bar'  ", log)).toBe(true)
  })

  it("fails when the excerpt is NOT in the log (the #24 fabrication)", () => {
    expect(isLogGrounded("SyntaxError: unexpected token", log)).toBe(false)
    expect(isLogGrounded("TS9999: invented error code", log)).toBe(false)
  })

  it("fails for an empty / whitespace-only excerpt (quotes nothing → not corroborated)", () => {
    expect(isLogGrounded("", log)).toBe(false)
    expect(isLogGrounded("   \n  ", log)).toBe(false)
  })

  it("is case-sensitive on error codes (TS2339 != ts2339)", () => {
    expect(isLogGrounded("ts2339: property 'foo'", log)).toBe(false)
  })
})

describe("disposeCiFinding (two-stack disposition)", () => {
  it("anchored + corroborated → inline-clean", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: true, hardWithholdUncorroborated: false })).toBe(
      "inline-clean",
    )
    // The hard-withhold flag does NOT affect the corroborated bucket.
    expect(disposeCiFinding({ anchored: true, logCorroborated: true, hardWithholdUncorroborated: true })).toBe(
      "inline-clean",
    )
  })

  it("anchored + uncorroborated → inline-hedged BY DEFAULT (recall-safe, not dropped)", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: false, hardWithholdUncorroborated: false })).toBe(
      "inline-hedged",
    )
  })

  it("anchored + uncorroborated → withhold ONLY when the hard-withhold flag is set", () => {
    expect(disposeCiFinding({ anchored: true, logCorroborated: false, hardWithholdUncorroborated: true })).toBe(
      "withhold",
    )
  })

  it("not anchored → withhold regardless of corroboration (off-diff: flaky / infra)", () => {
    expect(disposeCiFinding({ anchored: false, logCorroborated: true, hardWithholdUncorroborated: false })).toBe(
      "withhold",
    )
    expect(disposeCiFinding({ anchored: false, logCorroborated: false, hardWithholdUncorroborated: false })).toBe(
      "withhold",
    )
    expect(disposeCiFinding({ anchored: false, logCorroborated: false, hardWithholdUncorroborated: true })).toBe(
      "withhold",
    )
  })
})

describe("ciFindingCoarseKey", () => {
  it("lowercases the path and normalizes the headline (collapse ws + strip trailing punctuation)", () => {
    expect(ciFindingCoarseKey("src/A.ts", "Missing  null   check.")).toBe("src/a.ts|missing null check")
    expect(ciFindingCoarseKey("SRC/a.ts", "Off-by-one in loop!!!")).toBe("src/a.ts|off-by-one in loop")
  })
  it("makes rephrased-only-by-trailing-punctuation headlines collide (the intended coarseness)", () => {
    expect(ciFindingCoarseKey("src/a.ts", "Bad cast")).toBe(ciFindingCoarseKey("src/a.ts", "Bad cast."))
  })
})

describe("isDuplicateOfExistingReview (dedup predicate)", () => {
  const existing: ExistingReviewFindings = {
    fingerprints: new Set(["a".repeat(64)]),
    coarseKeys: new Set(["src/a.ts|missing null check"]),
  }

  it("HARD-DROPS on an exact contentFingerprint match (the review already posted it)", () => {
    const candidate: CiDedupCandidate = { contentFingerprint: "a".repeat(64), coarseKey: "src/b.ts|unrelated" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(true)
  })

  it("KEEPS a genuinely-new finding (no fingerprint match)", () => {
    const candidate: CiDedupCandidate = { contentFingerprint: "b".repeat(64), coarseKey: "src/c.ts|new thing" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
  })

  it("does NOT hard-drop on a coarse-key-only match (recall-safety: coarse is a hint, not a drop)", () => {
    // Same coarse key as an existing manifest finding, but a different (or no)
    // fingerprint — must NOT be suppressed by the hard-drop predicate.
    const candidate: CiDedupCandidate = { contentFingerprint: "c".repeat(64), coarseKey: "src/a.ts|missing null check" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
    const noFingerprint: CiDedupCandidate = { coarseKey: "src/a.ts|missing null check" }
    expect(isDuplicateOfExistingReview(noFingerprint, existing)).toBe(false)
  })

  it("KEEPS a finding with no fingerprint at all (can't fingerprint-match → not a hard dup)", () => {
    const candidate: CiDedupCandidate = { coarseKey: "src/z.ts|brand new" }
    expect(isDuplicateOfExistingReview(candidate, existing)).toBe(false)
  })
})

describe("matchesExistingCoarseKey (secondary hint)", () => {
  const existing: ExistingReviewFindings = {
    fingerprints: new Set<string>(),
    coarseKeys: new Set(["src/a.ts|missing null check"]),
  }
  it("flags a coarse-key match as a hint", () => {
    expect(matchesExistingCoarseKey({ coarseKey: "src/a.ts|missing null check" }, existing)).toBe(true)
  })
  it("returns false when the coarse key is not in the manifest set", () => {
    expect(matchesExistingCoarseKey({ coarseKey: "src/a.ts|something else" }, existing)).toBe(false)
  })
})

describe("renderCiFindingComment (presentation — Kimi's template, NO emojis)", () => {
  const base = {
    statement: "The added `parseAmount` returns a string, but the caller expects a number.",
    runId: 123456,
    runUrl: "https://github.com/o/r/actions/runs/123456",
  }

  it("renders statement, fix block, and the provenance line in order", () => {
    const body = renderCiFindingComment({ ...base, fix: "Wrap the result in `Number(...)`." }, false)
    expect(body).toBe(
      [
        "The added `parseAmount` returns a string, but the caller expects a number.",
        "",
        "Likely fix:\nWrap the result in `Number(...)`.",
        "",
        "Surfaced from failed CI run [123456](https://github.com/o/r/actions/runs/123456).",
      ].join("\n"),
    )
  })

  it("omits the `Likely fix:` block when there is no fix", () => {
    const body = renderCiFindingComment(base, false)
    expect(body).not.toContain("Likely fix:")
    expect(body).toContain("The added `parseAmount` returns a string")
    expect(body).toContain("Surfaced from failed CI run [123456]")
  })

  it("omits the fix block for an empty / whitespace-only fix", () => {
    expect(renderCiFindingComment({ ...base, fix: "" }, false)).not.toContain("Likely fix:")
    expect(renderCiFindingComment({ ...base, fix: "   " }, false)).not.toContain("Likely fix:")
  })

  it("prepends the hedge line for the hedged (uncorroborated) disposition", () => {
    const hedged = renderCiFindingComment({ ...base, fix: "Cast it." }, true)
    expect(hedged.startsWith(CI_HEDGE_LINE)).toBe(true)
    expect(hedged).toContain("Likely fix:\nCast it.")
  })

  it("does NOT prepend the hedge line for the clean disposition", () => {
    expect(renderCiFindingComment(base, false)).not.toContain(CI_HEDGE_LINE)
  })

  it("contains NO emoji (Kimi: drop emojis, model, confidence)", () => {
    const clean = renderCiFindingComment({ ...base, fix: "Cast it." }, false)
    const hedged = renderCiFindingComment({ ...base, fix: "Cast it." }, true)
    // Match any emoji / pictographic codepoint; the legacy CI sticky used 🔴📍📋🤔.
    const emojiRe = /\p{Extended_Pictographic}/u
    expect(emojiRe.test(clean)).toBe(false)
    expect(emojiRe.test(hedged)).toBe(false)
    // And it drops model / confidence framing entirely.
    expect(clean.toLowerCase()).not.toContain("confidence")
    expect(clean.toLowerCase()).not.toContain("model")
  })
})

describe("CI_REVIEW_MARKER", () => {
  it("is the distinct CI-review idempotency marker (not the legacy sticky / suggestion markers)", () => {
    expect(CI_REVIEW_MARKER).toBe("<!-- sigilix:ci-review -->")
    expect(CI_REVIEW_MARKER).not.toBe("<!-- sigilix:ci-triage -->")
    expect(CI_REVIEW_MARKER).not.toBe("<!-- sigilix:ci-suggestion -->")
  })
})

// ─────────────────────────── anchor remap (SIG-433) ─────────────────────────

describe("parseCiTriageAnchorRemap", () => {
  it("is OFF for unset / empty / unknown / 'off' / 'true' (dark default)", () => {
    expect(parseCiTriageAnchorRemap(undefined)).toBe(false)
    expect(parseCiTriageAnchorRemap("")).toBe(false)
    expect(parseCiTriageAnchorRemap("off")).toBe(false)
    expect(parseCiTriageAnchorRemap("true")).toBe(false)
    expect(parseCiTriageAnchorRemap("enforce")).toBe(false)
  })
  it("is ON only for the literal 'on' (trim + case-insensitive)", () => {
    expect(parseCiTriageAnchorRemap("on")).toBe(true)
    expect(parseCiTriageAnchorRemap("  ON ")).toBe(true)
  })
})

describe("isCiTestPath", () => {
  it("flags *.test.* / *.spec.* and tests/ __tests__/ directories", () => {
    expect(isCiTestPath("tests/parse.test.ts")).toBe(true)
    expect(isCiTestPath("src/foo.spec.ts")).toBe(true)
    expect(isCiTestPath("packages/a/__tests__/x.ts")).toBe(true)
    expect(isCiTestPath("test/util.ts")).toBe(true)
  })
  it("does NOT flag ordinary source paths", () => {
    expect(isCiTestPath("src/parse/event.ts")).toBe(false)
    expect(isCiTestPath("src/lib/latest/contestant.ts")).toBe(false) // 'test' as a substring, not a segment
  })
})

describe("extractFindingSymbols", () => {
  it("pulls specific (camelCase / snake_case / backticked) identifiers", () => {
    const syms = extractFindingSymbols("dedupeKey omits attemptKind", "the `dedupeKey` collapses start/end events")
    expect(syms).toContain("dedupeKey")
    expect(syms).toContain("attemptKind")
  })
  it("drops the generic stop-list and bare lowercase English words (no false strong match)", () => {
    const syms = extractFindingSymbols("the value is wrong", "data and result and key and the parse step")
    expect(syms).not.toContain("value")
    expect(syms).not.toContain("data")
    expect(syms).not.toContain("result")
    expect(syms).not.toContain("key")
    expect(syms).not.toContain("parse") // bare lowercase word → not specific
    expect(syms).toEqual([]) // nothing specific named → no remap material
  })
  it("drops sentence-initial Capitalized English words (the P3 review caught), keeps real identifiers", () => {
    const syms = extractFindingSymbols("The Property is wrong", "Name does not exist; see attemptKind and TS2339")
    expect(syms).not.toContain("The")
    expect(syms).not.toContain("Property")
    expect(syms).not.toContain("Name")
    expect(syms).toContain("attemptKind") // camelCase identifier
    expect(syms).toContain("TS2339") // has a digit (error-code-like)
  })
})

describe("classifyChangedLineForSymbol", () => {
  it("STRONG on a real `=` assignment or a return of the symbol", () => {
    expect(classifyChangedLineForSymbol("  const dedupeKey = `${runId}:${idx}`", "dedupeKey")).toBe("strong")
    expect(classifyChangedLineForSymbol("  let dedupeKey = makeKey()", "dedupeKey")).toBe("strong")
    expect(classifyChangedLineForSymbol("  dedupeKey = computeIt()", "dedupeKey")).toBe("strong")
    expect(classifyChangedLineForSymbol("  this.dedupeKey = k", "dedupeKey")).toBe("strong")
    expect(classifyChangedLineForSymbol("  const dedupeKey: string = build()", "dedupeKey")).toBe("strong")
    expect(classifyChangedLineForSymbol("  return computeDedupeKey(e)", "computeDedupeKey")).toBe("strong")
  })
  it("NOT strong on an EQUALITY / comparison of the symbol (the P1 review caught: `===` is not `=`)", () => {
    expect(classifyChangedLineForSymbol("  if (dedupeKey === expected) return true", "dedupeKey")).toBe("weak")
    expect(classifyChangedLineForSymbol("  const ok = dedupeKey === expected", "dedupeKey")).toBe("weak")
    expect(classifyChangedLineForSymbol("  if (dedupeKey == other) {", "dedupeKey")).toBe("weak")
    expect(classifyChangedLineForSymbol("  if (dedupeKey !== other) {", "dedupeKey")).toBe("weak")
    expect(classifyChangedLineForSymbol("  if (dedupeKey >= max) {", "dedupeKey")).toBe("weak")
    expect(classifyChangedLineForSymbol("  dedupeKey += 1", "dedupeKey")).toBe("weak") // compound mutation, not a build
  })
  it("INELIGIBLE on a type/interface field declaration — INCLUDING one with a trailing comma (the P1 review caught)", () => {
    expect(classifyChangedLineForSymbol("  readonly dedupeKey: string", "dedupeKey")).toBe("ineligible")
    expect(classifyChangedLineForSymbol("  dedupeKey: string", "dedupeKey")).toBe("ineligible")
    expect(classifyChangedLineForSymbol("  dedupeKey: string,", "dedupeKey")).toBe("ineligible") // trailing comma ≠ value
    expect(classifyChangedLineForSymbol("  dedupeKey?: AttemptKind", "dedupeKey")).toBe("ineligible")
  })
  it("a colon-form object-property VALUE (`sym: expr,`) is NOT strong — ambiguous with a type field → weak", () => {
    // We can't tell `sym: makeKey(e),` (value) from `sym: SomeType,` (field) on one
    // line, so it's never a strong remap target (bias to withhold).
    expect(classifyChangedLineForSymbol("    dedupeKey: buildKey(e),", "dedupeKey")).not.toBe("strong")
  })
  it("INELIGIBLE on a header / brace / import / a line missing the symbol", () => {
    expect(classifyChangedLineForSymbol("export function parseEvent(line: string): ParsedEvent {", "dedupeKey")).toBe(
      "ineligible",
    )
    expect(classifyChangedLineForSymbol("}", "dedupeKey")).toBe("ineligible")
    expect(classifyChangedLineForSymbol("import { x } from './y'", "dedupeKey")).toBe("ineligible")
    expect(classifyChangedLineForSymbol("  const other = 1", "dedupeKey")).toBe("ineligible")
  })
  it("is case-sensitive and word-bounded (no substring false match)", () => {
    expect(classifyChangedLineForSymbol("  const dedupeKeyMap = new Map()", "dedupeKey")).toBe("ineligible")
    expect(classifyChangedLineForSymbol("  const DEDUPEKEY = 1", "dedupeKey")).toBe("ineligible")
  })
})

describe("isLowQualityAnchorLine", () => {
  it("TRUE for an unknown (off-diff) line, a header, a brace, and a type-field declaration", () => {
    expect(isLowQualityAnchorLine(undefined, ["dedupeKey"])).toBe(true)
    expect(isLowQualityAnchorLine("export function parseEvent(): void {", ["dedupeKey"])).toBe(true)
    expect(isLowQualityAnchorLine("", ["dedupeKey"])).toBe(true)
    expect(isLowQualityAnchorLine("  readonly dedupeKey: string", ["dedupeKey"])).toBe(true)
  })
  it("FALSE for a substantive statement (don't move a good anchor)", () => {
    expect(isLowQualityAnchorLine("  const dedupeKey = `${runId}:${idx}`", ["dedupeKey"])).toBe(false)
  })
})

describe("remapCiFindingAnchor (the deterministic remap)", () => {
  // The canonical #24 geometry: an interface field (110, declaration), the
  // function header (113), and the buggy assignment (118) are all changed lines.
  const ADDED = new Map<string, ReadonlyMap<number, string>>([
    [
      "src/parse/event.ts",
      new Map<number, string>([
        [110, "  readonly dedupeKey: string"],
        [117, "  // Build a stable key so a re-delivered event is dropped as a duplicate."],
        [118, "  const dedupeKey = `${raw.runId}:${attemptIndex}`"],
        [121, "    dedupeKey,"],
      ]),
    ],
  ])
  const base = {
    headline: "dedupeKey omits attemptKind, collapsing distinct-kind events",
    body: "The `dedupeKey` is built from only runId and attemptIndex, so a start and end event for the same attempt collide.",
    addedLineTextByPath: ADDED,
    isTestPath: isCiTestPath,
  }

  it("remaps an anchor on the function HEADER (113) to the dedupeKey assignment (118)", () => {
    const remap = remapCiFindingAnchor({ ...base, path: "src/parse/event.ts", line: 113, currentlyAnchored: true })
    expect(remap).toEqual({ path: "src/parse/event.ts", line: 118, reason: "strong:dedupeKey" })
  })

  it("remaps an OFF-DIFF anchor (currentlyAnchored:false) into the diff at the assignment", () => {
    // e.g. the model anchored the test-assertion line; not RIGHT-reviewable.
    const remap = remapCiFindingAnchor({ ...base, path: "tests/parse.test.ts", line: 50, currentlyAnchored: false })
    expect(remap).toEqual({ path: "src/parse/event.ts", line: 118, reason: "strong:dedupeKey" })
  })

  it("does NOT pick the interface-field declaration (110) over the assignment (118)", () => {
    const remap = remapCiFindingAnchor({ ...base, path: "src/parse/event.ts", line: 113, currentlyAnchored: true })
    expect(remap?.line).not.toBe(110)
    expect(remap?.line).toBe(118)
  })

  it("NO-OP when the flag-gated caller never invokes it — (covered by run-layer test); here: NO-OP on a good anchor", () => {
    // currentlyAnchored on the substantive assignment line itself → leave it.
    const remap = remapCiFindingAnchor({ ...base, path: "src/parse/event.ts", line: 118, currentlyAnchored: true })
    expect(remap).toBeNull()
  })

  it("NO-OP for a generic-only finding (no specific identifier named)", () => {
    const remap = remapCiFindingAnchor({
      path: "src/parse/event.ts",
      line: 113,
      currentlyAnchored: true,
      headline: "the value is wrong",
      body: "the result and the data are off",
      addedLineTextByPath: ADDED,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })

  it("NO-OP (ambiguous) when TWO distinct lines are equally-strong for named symbols (metamorphic)", () => {
    const twoStrong = new Map<string, ReadonlyMap<number, string>>([
      [
        "src/parse/event.ts",
        new Map<number, string>([
          [118, "  const dedupeKey = `${raw.runId}:${attemptIndex}`"],
          [130, "  const groupKey = `${raw.runId}`"],
        ]),
      ],
    ])
    const remap = remapCiFindingAnchor({
      path: "src/parse/event.ts",
      line: 113,
      currentlyAnchored: true,
      headline: "dedupeKey and groupKey are both wrong",
      body: "`dedupeKey` and `groupKey` both omit the kind",
      addedLineTextByPath: twoStrong,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })

  it("NEVER targets a test file (cause is non-test source) — a strong test line is not a target", () => {
    const testOnly = new Map<string, ReadonlyMap<number, string>>([
      ["tests/parse.test.ts", new Map<number, string>([[42, "  const dedupeKey = makeKey(e)"]])],
    ])
    const remap = remapCiFindingAnchor({
      path: "tests/parse.test.ts",
      line: 10,
      currentlyAnchored: false,
      headline: "dedupeKey omits the kind",
      body: "`dedupeKey` is wrong",
      addedLineTextByPath: testOnly,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })

  it("does NOT pull a finding off a TEST line it is ALREADY anchored to", () => {
    const both = new Map<string, ReadonlyMap<number, string>>([
      ["tests/parse.test.ts", new Map<number, string>([[20, "  expect(dedupeEvents(e)).toHaveLength(2)"]])],
      ["src/parse/event.ts", new Map<number, string>([[118, "  const dedupeKey = `${raw.runId}:${attemptIndex}`"]])],
    ])
    const remap = remapCiFindingAnchor({
      path: "tests/parse.test.ts",
      line: 20,
      currentlyAnchored: true, // genuinely-in-test anchor → leave it
      headline: "dedupeKey omits the kind",
      body: "`dedupeKey` is wrong",
      addedLineTextByPath: both,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })

  it("for a non-test SOURCE anchor, restricts the search to the SAME file (no cross-file remap)", () => {
    const twoFiles = new Map<string, ReadonlyMap<number, string>>([
      ["src/parse/event.ts", new Map<number, string>([[113, "export function parseEvent(): void {"]])], // only a header here
      ["src/other.ts", new Map<number, string>([[5, "  const dedupeKey = makeKey(e)"]])], // strong, different file
    ])
    const remap = remapCiFindingAnchor({
      path: "src/parse/event.ts",
      line: 113,
      currentlyAnchored: true,
      headline: "dedupeKey omits the kind",
      body: "`dedupeKey` is wrong",
      addedLineTextByPath: twoFiles,
      isTestPath: isCiTestPath,
    })
    // Same-file has no strong candidate; cross-file is NOT allowed for a source
    // anchor → no-op (never blame src/other.ts from a finding anchored in event.ts).
    expect(remap).toBeNull()
  })

  it("NEVER targets a line absent from the changed-`+`-line map (no fabricated anchor)", () => {
    const remap = remapCiFindingAnchor({ ...base, path: "src/parse/event.ts", line: 113, currentlyAnchored: true })
    expect(remap).not.toBeNull()
    // The returned line is a key of the added-line map (a real `+` line).
    expect(ADDED.get(remap!.path)?.has(remap!.line)).toBe(true)
  })

  it("NO-OP when the only changed line naming the symbol is a COMPARISON/read, not an assignment (P1 regression)", () => {
    // The model names `dedupeKey`; the only changed line is an equality check —
    // that line WITNESSES, it doesn't PRODUCE. Must not be chosen as a target.
    const cmpOnly = new Map<string, ReadonlyMap<number, string>>([
      ["src/parse/event.ts", new Map<number, string>([[60, "  if (dedupeKey === expected) return out"]])],
    ])
    const remap = remapCiFindingAnchor({
      path: "tests/parse.test.ts",
      line: 50,
      currentlyAnchored: false, // off-diff anchor that would otherwise want a re-home
      headline: "dedupeKey omits attemptKind",
      body: "`dedupeKey` is wrong",
      addedLineTextByPath: cmpOnly,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })

  it("NO-OP when the only changed line naming the symbol is a TYPE FIELD with a trailing comma (P1 regression)", () => {
    const fieldOnly = new Map<string, ReadonlyMap<number, string>>([
      ["src/parse/event.ts", new Map<number, string>([[110, "  dedupeKey: string,"]])],
    ])
    const remap = remapCiFindingAnchor({
      path: "tests/parse.test.ts",
      line: 50,
      currentlyAnchored: false,
      headline: "dedupeKey omits attemptKind",
      body: "`dedupeKey` is wrong",
      addedLineTextByPath: fieldOnly,
      isTestPath: isCiTestPath,
    })
    expect(remap).toBeNull()
  })
})
