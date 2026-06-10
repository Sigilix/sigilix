import { describe, expect, it } from "vitest"
import {
  buildReviewSubmissionWithMetadata,
  formatFindingComment,
  formatProposedChangeBlock,
  formatAiAgentPromptBlock,
  isCommentAnchorable,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"

describe("isCommentAnchorable (SIG-164 PR 5)", () => {
  // GitHub PR comment endpoints (`start_line` + `line`) must both be
  // on the diff (same side); in-between lines may be context within
  // a hunk. This helper is laxer than `isFindingAnchorable` (which
  // requires every line in the range to be RIGHT-reviewable
  // contiguously — correct for committable suggestion blocks).
  const reviewable: ReviewableMap = new Map([
    ["src/a.ts", [
      { line: 10, side: "RIGHT" as const },
      // gap: lines 11-19 are context (unchanged), NOT in the map
      { line: 20, side: "RIGHT" as const },
    ]],
  ])

  it("allows wide ranges whose endpoints are RIGHT-reviewable but interior is context", () => {
    expect(isCommentAnchorable(reviewable, "src/a.ts", 10, 20)).toBe(true)
  })

  it("returns true for a single-line anchor (startLine undefined)", () => {
    expect(isCommentAnchorable(reviewable, "src/a.ts", undefined, 10)).toBe(true)
  })

  it("returns true when startLine === line (degenerate range collapses to single-line)", () => {
    expect(isCommentAnchorable(reviewable, "src/a.ts", 10, 10)).toBe(true)
  })

  it("rejects when end is not RIGHT-reviewable", () => {
    expect(isCommentAnchorable(reviewable, "src/a.ts", 10, 50)).toBe(false)
  })

  it("rejects when start is not RIGHT-reviewable (only endpoints checked)", () => {
    // startLine: 5 isn't in the map; line: 10 is RIGHT-reviewable.
    // Range is real (5 < 10) so the start-reviewability check fires.
    expect(isCommentAnchorable(reviewable, "src/a.ts", 5, 10)).toBe(false)
  })

  it("rejects when the path is missing from the map", () => {
    expect(isCommentAnchorable(reviewable, "src/missing.ts", 10, 20)).toBe(false)
  })
})

describe("formatProposedChangeBlock (SIG-164 PR 5)", () => {
  const addedLines = new Map([
    ["src/a.ts", new Map<number, string>([
      [10, "  const x = compute()"],
      [11, "  if (x > 100) return"],
      [12, "  return x"],
    ])],
  ])

  it("emits **Current:** + **Proposed:** for a replacement", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, startLine: 10, score: 4,
      category: "logic", headline: "h", body: "b",
      kind: "replace",
      suggestedReplacement: "  const x = computeSafe()\n  return x",
    }
    const out = formatProposedChangeBlock(f, addedLines)
    expect(out).toContain("**Current:**")
    expect(out).toContain("const x = compute()")
    expect(out).toContain("**Proposed:**")
    expect(out).toContain("const x = computeSafe()")
    expect(out).toContain("```ts")
  })

  it("emits ONLY **Current:** for a deletion (no Proposed — the deletion IS the proposal)", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, startLine: 10, score: 4,
      category: "logic", headline: "h", body: "b",
      kind: "delete",
      suggestedReplacement: "",
    }
    const out = formatProposedChangeBlock(f, addedLines)
    expect(out).toContain("**Current:**")
    expect(out).toContain("const x = compute()")
    expect(out).not.toContain("**Proposed:**")
  })

  it("returns empty string when kind is describe-only (no actionable change)", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, startLine: 10, score: 4,
      category: "complexity", headline: "h", body: "b",
      kind: "describe",
    }
    expect(formatProposedChangeBlock(f, addedLines)).toBe("")
  })

  it("returns empty string when no addedLineTextByPath context is available", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, startLine: 10, score: 4,
      category: "logic", headline: "h", body: "b",
      kind: "replace",
      suggestedReplacement: "x = 1",
    }
    expect(formatProposedChangeBlock(f, undefined)).toBe("")
    expect(formatProposedChangeBlock(f, new Map())).toBe("")
  })

  it("returns empty string when finding's range has no added lines (anchored at context only)", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 99, startLine: 95, score: 4,
      category: "logic", headline: "h", body: "b",
      kind: "replace",
      suggestedReplacement: "x = 1",
    }
    // None of 95..99 are in the addedLines map → empty block.
    expect(formatProposedChangeBlock(f, addedLines)).toBe("")
  })

  it("picks the right language fence based on file extension", () => {
    const py = new Map([
      ["src/x.py", new Map([[5, "  return 0"]])],
    ])
    const f: PrReviewFinding = {
      path: "src/x.py", line: 5, score: 4,
      category: "logic", headline: "h", body: "b",
      kind: "replace",
      suggestedReplacement: "  return 1",
    }
    expect(formatProposedChangeBlock(f, py)).toContain("```python")
  })

  it("skips Current/Proposed when replacement scope is much smaller and body names multiple exact lines", () => {
    const wideLines = new Map([
      ["src/a.ts", new Map<number, string>(
        Array.from({ length: 10 }, (_, i) => [i + 1, `  line${i + 1}()`]),
      )],
    ])
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 10, startLine: 1, score: 4,
      category: "logic", headline: "h",
      body: "Add suppression comments on lines 2, 8.",
      kind: "replace",
      suggestedReplacement: "  // suppress line 2\n  // suppress line 8",
    }
    // 2 replacement lines / 10 anchor lines is below the mismatch threshold.
    expect(formatProposedChangeBlock(f, wideLines)).toBe("")
  })

  it("detects comma-free multi-line wording when checking scope mismatch", () => {
    const wideLines = new Map([
      ["src/a.ts", new Map<number, string>(
        Array.from({ length: 10 }, (_, i) => [i + 1, `  line${i + 1}()`]),
      )],
    ])
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 10, startLine: 1, score: 4,
      category: "logic", headline: "h",
      body: "Add suppression comments on lines 2 and 8.",
      kind: "replace",
      suggestedReplacement: "  // suppress line 2\n  // suppress line 8",
    }
    expect(formatProposedChangeBlock(f, wideLines)).toBe("")
  })

  it("keeps Current/Proposed for scope mismatch when the body only names one line", () => {
    const wideLines = new Map([
      ["src/a.ts", new Map<number, string>(
        Array.from({ length: 10 }, (_, i) => [i + 1, `  line${i + 1}()`]),
      )],
    ])
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 10, startLine: 1, score: 4,
      category: "logic", headline: "h",
      body: "Add a guard on line 8.",
      kind: "replace",
      suggestedReplacement: "  if (!ok) return\n  line8()",
    }
    expect(formatProposedChangeBlock(f, wideLines)).toContain("**Current:**")
  })

  it("keeps Current/Proposed when replacement scope roughly matches the anchor", () => {
    const lines = new Map([
      ["src/a.ts", new Map<number, string>([
        [1, "  a()"],
        [2, "  b()"],
        [3, "  c()"],
        [4, "  d()"],
      ])],
    ])
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 4, startLine: 1, score: 4,
      category: "logic", headline: "h",
      body: "Rewrite lines 1, 4.",
      kind: "replace",
      suggestedReplacement: "  aSafe()\n  bSafe()\n  cSafe()",
    }
    expect(formatProposedChangeBlock(f, lines)).toContain("**Current:**")
  })

  it("still emits the committable suggestion when Current/Proposed is skipped for scope mismatch", () => {
    const wideLines = new Map([
      ["src/a.ts", new Map<number, string>(
        Array.from({ length: 10 }, (_, i) => [i + 1, `  line${i + 1}()`]),
      )],
    ])
    const reviewable: ReviewableMap = new Map([
      ["src/a.ts", Array.from({ length: 10 }, (_, i) => ({
        line: i + 1,
        side: "RIGHT" as const,
      }))],
    ])
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 10, startLine: 1, score: 4,
      category: "logic", headline: "h",
      body: "Add suppression comments on lines 2, 8.",
      kind: "replace",
      suggestedReplacement: "  // suppress line 2\n  // suppress line 8",
    }
    const out = formatFindingComment(f, 5, reviewable, wideLines)
    expect(out).not.toContain("**Current:**")
    expect(out).toContain("```suggestion")
    expect(out).toContain("// suppress line 2")
  })
})

describe("formatAiAgentPromptBlock (SIG-164 PR 5)", () => {
  // Mirrors Greptile's exact "Prompt To Fix With AI" shape — no
  // leading emoji on the summary (the words are the affordance) and
  // body matches their copy-pastable structure verbatim.
  const f: PrReviewFinding = {
    path: "src/foo.ts", line: 50, startLine: 42, score: 4,
    category: "logic",
    headline: "missing null guard on `user.profile`",
    body: "Wrap with `if (!user) return` before accessing `user.profile`.",
  }

  it("wraps a structured prompt inside a collapsible <details> block (Greptile shape, no emoji)", () => {
    const out = formatAiAgentPromptBlock(f)
    expect(out.startsWith("<details>")).toBe(true)
    expect(out.endsWith("</details>")).toBe(true)
    expect(out).toContain("<summary>Prompt To Fix With AI</summary>")
    // Affirm the summary has no leading emoji.
    expect(out).not.toContain("🤖")
  })

  it("includes the Greptile preamble + path + line + headline + body verbatim", () => {
    const out = formatAiAgentPromptBlock(f)
    expect(out).toContain("This is a comment left during a code review.")
    expect(out).toContain("Path: src/foo.ts")
    expect(out).toContain("Line: 42-50")
    expect(out).toContain("Comment:")
    expect(out).toContain("**missing null guard on `user.profile`**")
    expect(out).toContain("Wrap with `if (!user) return`")
  })

  it("uses a single-line range when startLine is absent or equal to line", () => {
    const single: PrReviewFinding = { ...f, startLine: undefined }
    expect(formatAiAgentPromptBlock(single)).toContain("Line: 50")
  })

  it("ends with the Greptile-style fix-request question", () => {
    expect(formatAiAgentPromptBlock(f)).toContain("How can I resolve this? If you propose a fix, please make it concise.")
  })

  it("wraps the structured prompt body in a fenced code block (PR #146 founder feedback)", () => {
    // The inner prompt (path / line / comment / question) needs to read
    // as a demarcated copy-pasteable unit, not as flowing markdown
    // inside the <details> chrome. ```text fence makes the block
    // visually distinct AND preserves literal whitespace + asterisks
    // for the AI assistant the reader pastes it into.
    const out = formatAiAgentPromptBlock(f)
    expect(out).toContain("```text")
    expect(out).toContain("```\n")
    // The opening fence sits inside the <details> block, not outside.
    const detailsIdx = out.indexOf("<details>")
    const fenceIdx = out.indexOf("```text")
    const closeIdx = out.indexOf("</details>")
    expect(detailsIdx).toBeLessThan(fenceIdx)
    expect(fenceIdx).toBeLessThan(closeIdx)
    // The closing ``` sits between the closing question and </details>.
    const closeFenceIdx = out.lastIndexOf("```")
    expect(closeFenceIdx).toBeGreaterThan(fenceIdx)
    expect(closeFenceIdx).toBeLessThan(closeIdx)
  })
})

describe("formatFindingComment integration (SIG-164 PR 5)", () => {
  // End-to-end shape check on a high-confidence anchorable replacement
  // finding — should produce ALL THREE block types in order:
  //   1. **Current:** / **Proposed:** illustrative block (always when context available)
  //   2. ```suggestion committable block (high confidence + anchorable)
  //   3. <details>Prompt To Fix With AI</details> (always at bottom)
  const reviewable: ReviewableMap = new Map([
    ["src/a.ts", [
      { line: 10, side: "RIGHT" as const },
      { line: 11, side: "RIGHT" as const },
      { line: 12, side: "RIGHT" as const },
    ]],
  ])
  const addedLines = new Map([
    ["src/a.ts", new Map<number, string>([
      [10, "  const x = compute()"],
      [11, "  if (x > 100) return"],
      [12, "  return x"],
    ])],
  ])

  it("emits Current/Proposed + committable suggestion + AI agent prompt (all three tiers)", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, startLine: 10, score: 5,
      category: "logic", headline: "guard against undefined",
      body: "x can be undefined here.",
      kind: "replace",
      suggestedReplacement: "  const x = compute() ?? 0\n  return x",
    }
    const out = formatFindingComment(f, 5, reviewable, addedLines)

    // 1. Current/Proposed block present
    expect(out).toContain("**Current:**")
    expect(out).toContain("**Proposed:**")
    // 2. Committable ```suggestion present (high confidence + anchorable)
    expect(out).toContain("```suggestion")
    expect(out).toContain("compute() ?? 0")
    // 3. AI agent prompt at the bottom
    expect(out).toContain("<summary>Prompt To Fix With AI</summary>")
    // Order check: Current/Proposed BEFORE suggestion BEFORE AI prompt
    const currentIdx = out.indexOf("**Current:**")
    const suggIdx = out.indexOf("```suggestion")
    const aiIdx = out.indexOf("Prompt To Fix")
    expect(currentIdx).toBeLessThan(suggIdx)
    expect(suggIdx).toBeLessThan(aiIdx)
  })

  it("emits AI agent prompt even on describe-only findings (no fix to commit)", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, score: 3,
      category: "complexity", headline: "this block is hard to read",
      body: "Consider extracting a helper.",
      kind: "describe",
    }
    const out = formatFindingComment(f, 4, reviewable, addedLines)
    expect(out).not.toContain("**Current:**")
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("<summary>Prompt To Fix With AI</summary>")
  })

  it("SIG-282: appends a deterministic remediation for a confirmed security finding", () => {
    // Pattern A: the alarmist secrets-exposure remediation fires only when the
    // CITED line actually holds a credential. Thread an AWS key on line 12.
    const credLines = new Map([
      ["src/config.ts", new Map<number, string>([
        [12, '  const apiKey = "AKIAIOSFODNN7EXAMPLE"'],
      ])],
    ])
    const f: PrReviewFinding = {
      path: "src/config.ts", line: 12, score: 5,
      category: "security", headline: "hardcoded API token committed",
      body: "A live provider token is committed in source.",
      cweId: "CWE-798",
    }
    const out = formatFindingComment(f, 5, reviewable, credLines)
    expect(out).toContain("**Remediation:**")
    expect(out).toContain("revoke and rotate it now") // secrets-exposure template
  })

  it("Pattern A: de-alarms the secrets-exposure remediation when the cited line has no credential", () => {
    // The live bug: the specialist misread `console.log(x.length)` as a leak
    // and the system appended "treat the value as compromised … rewrite
    // history". With the gate, a credential-free cited line gets the
    // CONDITIONAL remediation, never the confident compromise assertion.
    const noCredLines = new Map([
      ["src/log.ts", new Map<number, string>([
        [12, "  console.log(`payload size: ${payload.length}`)"],
      ])],
    ])
    const f: PrReviewFinding = {
      path: "src/log.ts", line: 12, score: 5,
      category: "security", headline: "secret length logged",
      body: "The byte length of a sensitive payload is written to the log.",
      cweId: "CWE-798",
    }
    const out = formatFindingComment(f, 5, reviewable, noCredLines)
    expect(out).toContain("**Remediation:**")
    expect(out).toContain("If this value is an actual credential")
    expect(out).not.toContain("Treat the value as compromised")
    expect(out).not.toContain("rewrite history")
  })

  it("SIG-282: does not append a remediation to non-security findings", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, score: 3,
      category: "logic", headline: "off-by-one",
      body: "loop bound is wrong.",
    }
    const out = formatFindingComment(f, 4, reviewable, addedLines)
    expect(out).not.toContain("**Remediation:**")
  })

  it("renders structured examples, suggested fix shape, and test-gap sections", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, score: 4,
      category: "logic", headline: "greedy regex returns the wrong token",
      body: "`extract()` uses a greedy capture when the response has multiple `FINAL(...)` calls.",
      failureExample: "My first thought was FINAL(wrong) but actually FINAL(correct)",
      fixExample: "match = re.search(r\"FINAL\\\\((.*?)\\\\)\", response, re.DOTALL)",
      testGap: "The existing test only covers a single FINAL(...) occurrence.",
    }
    const out = formatFindingComment(f, 5, reviewable, addedLines)
    expect(out).toContain("**Example:**")
    expect(out).toContain("```text")
    expect(out).toContain("FINAL(wrong)")
    expect(out).toContain("**Suggested fix:**")
    expect(out).toContain("```ts")
    expect(out).toContain("**Why this wasn't caught:** The existing test only covers")
    expect(out).toContain("Suggested fix shape:")
    expect(out).toContain("Why this wasn't caught:")
  })

  it("suppresses illustrative fixExample when an exact suggestedReplacement exists", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, score: 5,
      category: "logic", headline: "guard against undefined",
      body: "x can be undefined here.",
      fixExample: "const x = compute() ?? 0",
      kind: "replace",
      suggestedReplacement: "  const x = compute() ?? 0\n  return x",
    }
    const out = formatFindingComment(f, 5, reviewable, addedLines)
    expect(out).toContain("**Proposed:**")
    expect(out).not.toContain("**Suggested fix:**")
    expect(out).toContain("Suggested fix shape:")
  })

  it("keeps fixExample visible for unsupported insert-shaped replacements", () => {
    const f: PrReviewFinding = {
      path: "src/a.ts", line: 12, score: 4,
      category: "logic", headline: "insert shape needs manual handling",
      body: "Insertion suggestions are not committable yet.",
      kind: "insert",
      suggestedReplacement: "  inserted()",
      fixExample: "insert `inserted()` before `return x`",
    }
    const out = formatFindingComment(f, 5, reviewable, addedLines)
    expect(out).toContain("**Suggested fix:**")
    expect(out).toContain("insert `inserted()` before `return x`")
    expect(out).not.toContain("```suggestion")
    expect(out).not.toContain("**Proposed change:**")
  })
})

describe("buildReviewSubmission — SIG-103 suggestion hardening", () => {
  const reviewable: ReviewableMap = new Map([
    ["src/a.ts", [
      { line: 10, side: "RIGHT" },
      { line: 11, side: "RIGHT" },
    ]],
  ])
  const addedLines = new Map([
    ["src/a.ts", new Map([
      [10, "  const x = compute()"],
      [11, "  return x"],
    ])],
  ])
  const finding = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    path: "src/a.ts",
    line: 10,
    score: 4,
    category: "logic",
    headline: "use nullish fallback",
    body: "`compute()` can return undefined.",
    kind: "replace",
    suggestedReplacement: "  const x = compute() ?? 0",
    ...overrides,
  })
  const submit = (f: PrReviewFinding) =>
    buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "fixture",
        confidence: 4,
        confidenceReason: "fixture",
        findings: [f],
      },
      prAuthor: "a",
      headSha: "abc",
      reviewable,
      addedLineTextByLine: addedLines,
    })

  it("records telemetry metadata only for actually rendered suggestion blocks", () => {
    const out = submit(finding())
    expect(out.submission.comments?.[0]?.body).toContain("```suggestion")
    expect(out.suggestionEmissions).toEqual([{ path: "src/a.ts", line: 10 }])
  })

  it("strips replacement when the anchored range is not fully reviewable", () => {
    const out = submit(finding({ startLine: 10, line: 12 }))
    expect(out.submission.comments?.[0]?.body).not.toContain("```suggestion")
    expect(out.submission.comments?.[0]?.body).not.toContain("**Proposed:**")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("strips replacement when the current line text is unavailable for validation", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "fixture",
        confidence: 4,
        confidenceReason: "fixture",
        findings: [finding()],
      },
      prAuthor: "a",
      headSha: "abc",
      reviewable,
      addedLineTextByLine: new Map([["src/a.ts", new Map()]]),
    })
    expect(out.submission.comments?.[0]?.body).not.toContain("```suggestion")
    expect(out.submission.comments?.[0]?.body).not.toContain("**Proposed:**")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("strips replacement when only line endings differ from current code", () => {
    const out = submit(finding({ suggestedReplacement: "  const x = compute()\r\n" }))
    expect(out.submission.comments?.[0]?.body).not.toContain("```suggestion")
    expect(out.submission.comments?.[0]?.body).not.toContain("**Proposed:**")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("does not count literal suggestion fences inside ordinary code blocks as emissions", () => {
    const out = submit(finding({
      kind: "describe",
      suggestedReplacement: undefined,
      fixExample: "```suggestion\nconst x = compute() ?? 0\n```",
    }))

    expect(out.submission.comments?.[0]?.body).toContain("```suggestion")
    expect(out.submission.comments?.[0]?.body).not.toContain("\n```suggestion\n  const x = compute() ?? 0\n```")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("does not count literal suggestion fences inside tilde code blocks as emissions", () => {
    const out = submit(finding({
      body: "Example:\n~~~text\n```suggestion\nconst x = compute() ?? 0\n```\n~~~",
      kind: "describe",
      suggestedReplacement: undefined,
    }))

    expect(out.submission.comments?.[0]?.body).toContain("~~~text")
    expect(out.submission.comments?.[0]?.body).toContain("```suggestion")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("strips deletion suggestions when the anchored range is not fully reviewable", () => {
    const out = submit(finding({
      kind: "delete",
      suggestedReplacement: "",
      startLine: 10,
      line: 12,
    }))

    expect(out.submission.comments?.[0]?.body).not.toContain("```suggestion")
    expect(out.submission.comments?.[0]?.body).not.toContain("**Proposed change:** remove")
    expect(out.suggestionEmissions).toHaveLength(0)
  })

  it("body-routes a stripped patch when the repaired anchor is not reviewable", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict: {
        summary: "fixture",
        confidence: 4,
        confidenceReason: "fixture",
        findings: [finding({ startLine: 10, line: 12 })],
      },
      prAuthor: "a",
      headSha: "abc",
      reviewable: new Map([["src/a.ts", [{ line: 10, side: "RIGHT" }]]]),
      addedLineTextByLine: addedLines,
    })

    expect(out.submission.comments ?? []).toHaveLength(0)
    expect(out.bodyOnlyFindings[0]?.suggestedReplacement).toBeUndefined()
    expect(out.suggestionEmissions).toHaveLength(0)
  })
})
