import { describe, expect, it } from "vitest"
import {
  formatFindingComment,
  parsePrReviewResponse,
  renderRequestChangesBody,
  resolveFindingConfidence,
  type PrReviewFinding,
  type PrReviewVerdict,
  extensionToFenceLang,
} from "@/lib/triage-pr-review"
import { badgeAssetUrl } from "@/lib/badge-assets"
import type { ReviewableMap } from "@/shared/util/diff-positions"
import { baseFinding } from "@/lib/triage-pr-review.test-helpers"

describe("resolveFindingConfidence (SIG-101)", () => {
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    ...overrides,
  })

  it("returns the per-finding confidence when present + in range", () => {
    expect(resolveFindingConfidence(fnd({ confidence: 4 }), 2)).toBe(4)
    expect(resolveFindingConfidence(fnd({ confidence: 1 }), 5)).toBe(1)
  })

  it("falls back to the verdict-level confidence when finding lacks one", () => {
    expect(resolveFindingConfidence(fnd({}), 3)).toBe(3)
  })

  it("clamps the verdict-level fallback into 1-5 defensively", () => {
    expect(resolveFindingConfidence(fnd({}), 0)).toBe(1)
    expect(resolveFindingConfidence(fnd({}), 99)).toBe(5)
  })

  it("ignores out-of-range per-finding confidence and falls back", () => {
    expect(resolveFindingConfidence(fnd({ confidence: 0 }), 3)).toBe(3)
    expect(resolveFindingConfidence(fnd({ confidence: 6 }), 3)).toBe(3)
    expect(resolveFindingConfidence(fnd({ confidence: NaN }), 3)).toBe(3)
  })
})

describe("formatFindingComment (SIG-101 badges + confidence + details-wrap)", () => {
  // Local fnd helper that ensures `category` is populated (the
  // file-level `baseFinding` predates the strict category field).
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    category: "logic",
    ...overrides,
  })

  it("prefixes the P0 badge img on score-5 findings", () => {
    const out = formatFindingComment(fnd({ score: 5, headline: "deref crash" }), 5)
    expect(out).toContain('alt="P0"')
    expect(out).toContain(badgeAssetUrl("p0"))
    expect(out).toContain("**deref crash**")
    expect(out).not.toContain("_category: logic_")
    expect(out).not.toContain("_severity:")
  })

  it("prefixes the P1 badge img on score-4 findings", () => {
    const out = formatFindingComment(fnd({ score: 4 }), 4)
    expect(out).toContain('alt="P1"')
  })

  it("prefixes the P2 badge img on score-3 findings", () => {
    const out = formatFindingComment(fnd({ score: 3 }), 4)
    expect(out).toContain('alt="P2"')
  })

  it("uses the P3 badge img on score 1-2 (SIG-164 PR 5: was null pre-SIG-164)", () => {
    const out = formatFindingComment(fnd({ score: 2 }), 4)
    expect(out).toContain('alt="P3"')
    expect(out).toContain(badgeAssetUrl("p3"))
    expect(out).not.toContain("🔴")
    expect(out).not.toContain("🟠")
    expect(out).not.toContain("🟡")
  })

  it("SIG-281 PR A: collapses a low-confidence NIT (score<4) but NEVER a low-confidence P0/P1 (score>=4)", () => {
    const SUMMARY = "Low-confidence finding — expand to read"
    // score 2 (nit) + confidence 2 → collapsed (skim-clean), unchanged.
    expect(formatFindingComment(fnd({ score: 2 }), 2)).toContain(SUMMARY)
    // score 5 (P0) + confidence 2 → MUST render expanded; burying a P0 hurts
    // believability more than the skim-noise the collapse saves.
    expect(formatFindingComment(fnd({ score: 5 }), 2)).not.toContain(SUMMARY)
    // score 4 (P1) + confidence 1 → expanded too.
    expect(formatFindingComment(fnd({ score: 4 }), 1)).not.toContain(SUMMARY)
  })

  it("keeps confidence machine-readable without a visible metadata row", () => {
    expect(formatFindingComment(fnd({ score: 5 }), 5)).toContain("<!-- sigilix:confidence:5 -->")
    expect(formatFindingComment(fnd({ score: 2 }), 4)).toContain("<!-- sigilix:confidence:4 -->")
    expect(formatFindingComment(fnd({ score: 3 }), 1)).toContain("<!-- sigilix:confidence:1 -->")
    expect(formatFindingComment(fnd({ score: 3 }), 3)).not.toContain("_confidence: 3/5_")
  })

  it("keeps category and severity machine-readable without a visible metadata row", () => {
    const out = formatFindingComment(fnd({ score: 4, category: "testing" }), 5)
    expect(out).toContain("<!-- sigilix:category:testing -->")
    expect(out).toContain("<!-- sigilix:severity:4 -->")
    expect(out).not.toContain("_category: testing_")
    expect(out).not.toContain("_severity:")
  })

  it("collapses body inside a <details> block when confidence ≤ 2", () => {
    const out = formatFindingComment(fnd({ score: 3 }), 2)
    expect(out).toContain("<details>")
    expect(out).toContain("<summary>Low-confidence finding")
    expect(out).toContain("</details>")
    // The headline + badge stay outside the details block so a
    // reviewer skimming can still triage.
    const headIdx = out.indexOf("**missing null guard")
    const detailsIdx = out.indexOf("<details>")
    expect(headIdx).toBeGreaterThan(-1)
    expect(detailsIdx).toBeGreaterThan(headIdx)
  })

  it("does NOT collapse the body on confidence ≥ 3", () => {
    // SIG-164 PR 5: <details> can still appear for the always-present
    // "Prompt To Fix With AI" block at the bottom. The body-collapse
    // check is now specifically that the BODY's low-confidence
    // <summary> doesn't appear (that summary is unique to the
    // low-confidence body-collapse path).
    const out = formatFindingComment(fnd({ score: 3 }), 3)
    expect(out).not.toContain("<summary>Low-confidence finding")
  })

  it("preserves the inline-finding marker as the first line", () => {
    const out = formatFindingComment(fnd({ score: 4 }), 4)
    expect(out.split("\n")[0]).toBe("<!-- sigilix:pr-review-finding -->")
  })

  it("does not render a duplicate visible severity/category metadata row", () => {
    const out = formatFindingComment(fnd({ score: 3, category: "testing" }), 5)
    expect(out).toContain('alt="P2"')
    expect(out).not.toContain("_category:")
    expect(out).not.toContain("_severity:")
  })

  // Body split is now STRUCTURAL (split on the first blank-line break), not
  // length-based. The complete issue stays inline (never a mid-thought "..."),
  // only the deeper reasoning collapses into a "Detailed reasoning" dropdown.
  it("splits the body at the first blank-line break: complete issue inline, reasoning in the dropdown", () => {
    const body = "This is the complete issue, stated plainly.\n\nDeeper reasoning for how the model concluded this."
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).toContain("This is the complete issue, stated plainly.")
    expect(out).toContain("<summary>Detailed reasoning</summary>")
    expect(out).not.toContain("More Info")
    expect(out).not.toContain("...") // NEVER a mid-thought ellipsis
    const detailsMatch = /<details><summary>Detailed reasoning<\/summary>\n\n([\s\S]*?)\n\n<\/details>/.exec(out)
    expect(detailsMatch?.[1]).toBe("Deeper reasoning for how the model concluded this.")
  })

  it("a single-paragraph body (no blank-line break) renders fully inline — no dropdown, no truncation", () => {
    // 600+ chars, but a single self-contained thought → shown whole.
    const body = `${"A complete self-contained issue with no paragraph break. ".repeat(11)}done.`
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).not.toContain("<summary>Detailed reasoning</summary>")
    expect(out).not.toContain("<summary>More Info</summary>")
    expect(out).toContain(body)
    expect(out).not.toContain("...")
  })

  it("splits at the FIRST blank-line break — every later paragraph goes to the dropdown", () => {
    const body = "The issue.\n\nReason one.\n\nReason two."
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).toContain("The issue.")
    const detailsMatch = /<details><summary>Detailed reasoning<\/summary>\n\n([\s\S]*?)\n\n<\/details>/.exec(out)
    expect(detailsMatch?.[1]).toBe("Reason one.\n\nReason two.")
  })

  it("never cuts a long issue mid-sentence — a no-break body is shown complete", () => {
    const body = "x".repeat(620) // no blank line → full inline, no '...'
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).toContain("x".repeat(620))
    expect(out).not.toContain("<summary>Detailed reasoning</summary>")
    expect(out).not.toContain("...")
  })

  it("strips AST markers from visible finding text and AI prompt", () => {
    const out = formatFindingComment(
      fnd({
        headline: "bad cache <!-- ast/cache-rule/abc -->",
        body: "Fix the cache. <!-- ast/cache-rule/body --><!-- ast/cache-rule/second -->",
      }),
      5,
    )
    expect(out).toContain("**bad cache**")
    expect(out).toContain("Fix the cache.")
    expect(out).not.toContain("ast/cache-rule")
  })
})

describe("parsePrReviewResponse — SIG-101 per-finding confidence", () => {
  const valid: PrReviewVerdict = {
    summary: "Safe; one nit.",
    confidence: 4,
    confidenceReason: "Narrow surface.",
    findings: [],
  }

  it("reads `finding.confidence` when present and in range", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 5 }] }),
    )
    expect(out?.findings[0]?.confidence).toBe(5)
  })

  it("drops out-of-range confidence (leaves the field undefined)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 0 }] }),
    )
    expect(out?.findings[0]?.confidence).toBeUndefined()
  })

  it("clamps fractional confidence to nearest integer", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic", confidence: 3.7 }] }),
    )
    expect(out?.findings[0]?.confidence).toBe(4)
  })

  it("absent confidence stays undefined (caller defaults to verdict-level)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, category: "logic" }] }),
    )
    expect(out?.findings[0]?.confidence).toBeUndefined()
  })
})

describe("parsePrReviewResponse — SIG-113 evidence citation fields", () => {
  const valid: PrReviewVerdict = {
    summary: "Test",
    confidence: 4,
    confidenceReason: "Reason",
    findings: [],
  }

  it("reads inspectedTestFiles when supplied (array of strings)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["tests/foo.test.ts", "tests/bar.test.ts"],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual([
      "tests/foo.test.ts",
      "tests/bar.test.ts",
    ])
  })

  it("reads evidenceRefs when supplied", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
        }],
      }),
    )
    expect(out?.findings[0]?.evidenceRefs).toEqual([
      "siblingMapping:src/lib/foo.ts->NONE",
    ])
  })

  it("trims whitespace + drops empty entries on both fields", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["  tests/foo.test.ts  ", "", "  "],
          evidenceRefs: ["", "siblingMapping:x->y", "  "],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual(["tests/foo.test.ts"])
    expect(out?.findings[0]?.evidenceRefs).toEqual(["siblingMapping:x->y"])
  })

  it("drops non-string entries (defensive against schema-bypass)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: ["tests/foo.test.ts", 42, null, "tests/bar.test.ts"],
          evidenceRefs: [{ shape: "object" }, "valid:ref"],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toEqual([
      "tests/foo.test.ts",
      "tests/bar.test.ts",
    ])
    expect(out?.findings[0]?.evidenceRefs).toEqual(["valid:ref"])
  })

  it("absent fields stay undefined (back-compat for staged rollout)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{ ...baseFinding, category: "testing" }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toBeUndefined()
    expect(out?.findings[0]?.evidenceRefs).toBeUndefined()
  })

  it("an empty array supplied also leaves the field undefined (less noise downstream)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({
        ...valid,
        findings: [{
          ...baseFinding,
          category: "testing",
          inspectedTestFiles: [],
          evidenceRefs: [],
        }],
      }),
    )
    expect(out?.findings[0]?.inspectedTestFiles).toBeUndefined()
    expect(out?.findings[0]?.evidenceRefs).toBeUndefined()
  })
})

describe("renderRequestChangesBody — SIG-101 retrigger + counter footer", () => {
  const verdict: PrReviewVerdict = {
    summary: "Has issues.",
    confidence: 3,
    confidenceReason: "ok",
    findings: [{ ...baseFinding, score: 4, category: "logic" }],
  }

  it("renders the re-run hint as part of the compact footer (always present, no retriggerUrl gate)", () => {
    // SIG Kimi r1: the re-run hint moved from an optional `<sub>` line
    // (gated on retriggerUrl) into the single `<sub>` footer that's
    // always emitted. The Greptile-style `[🔄 Re-run review](URL)`
    // button was dropped on founder feedback long before r1.
    const body = renderRequestChangesBody({ verdict })
    expect(body).toContain("Re-run: `/sigilix review`")
    expect(body).not.toContain("[🔄 Re-run review]")
    expect(body).not.toContain("🔄 Re-run review")
  })

  it("renders the Review #N counter in the compact footer when supplied", () => {
    // SIG Kimi r1: the dedicated `_Sigilix · Review #N for this PR ·
    // last rendered TS._` line collapsed into the single footer. The
    // standalone timestamp was dropped — GitHub already shows the
    // comment-creation timestamp at the top of the comment header.
    const body = renderRequestChangesBody({
      verdict,
      reviewCounter: 3,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toContain("Review #3")
    // Old "last rendered TIMESTAMP" line MUST be gone — dropped per
    // founder complaint that the body had two timestamps for the
    // same event.
    expect(body).not.toContain("last rendered")
    expect(body).not.toMatch(/_Sigilix · Review #3/)
  })

  it("renders dismiss + re-run + counter + SHA together in the single compact footer", () => {
    // SIG Kimi r1: all four pieces of metadata that used to occupy
    // separate lines now live in one `<sub>` block separated by `·`.
    const body = renderRequestChangesBody({
      verdict,
      reviewCounter: 1,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toMatch(
      /<sub>Dismiss: `@sigilix dismiss <reason>` in thread \(not-a-bug\|bad-anchor\|already-covered\|too-minor\|wrong-context\) · Re-run: `\/sigilix review` · Review #1 · `abc1234`<\/sub>/,
    )
  })

  it("omits the Review #N segment when reviewCounter is absent (other footer pieces still present)", () => {
    // Re-run hint is now ALWAYS present (no retriggerUrl gate in r1)
    // — only the Review #N counter is conditional.
    const body = renderRequestChangesBody({ verdict })
    expect(body).toContain("Re-run: `/sigilix review`")
    expect(body).not.toContain("Review #")
  })

  it("orders Dismiss · Re-run · Review #N · SHA inside the compact footer (single line)", () => {
    // The prior multi-line ordering invariant (hint above counter,
    // counter above provenance) collapses into left-to-right order
    // inside the single `<sub>` block.
    const body = renderRequestChangesBody({
      verdict,
      reviewCounter: 7,
      prov: { headSha: "deadbeef0000", nowMs: 1747547318000 },
    })
    const dismissIdx = body.indexOf("Dismiss:")
    const rerunIdx = body.indexOf("Re-run:")
    const counterIdx = body.indexOf("Review #7")
    const shaIdx = body.indexOf("`deadbee`")
    expect(dismissIdx).toBeGreaterThan(-1)
    expect(rerunIdx).toBeGreaterThan(dismissIdx)
    expect(counterIdx).toBeGreaterThan(rerunIdx)
    expect(shaIdx).toBeGreaterThan(counterIdx)
  })

  it("ignores reviewCounter <= 0 (defensive — counter should always be >= 1)", () => {
    const body = renderRequestChangesBody({ verdict, reviewCounter: 0 })
    expect(body).not.toContain("Review #")
  })
})

describe("parsePrReviewResponse — suggestedReplacement (SIG-125)", () => {
  const base = {
    summary: "s", confidence: 4, confidenceReason: "r",
    findings: [{
      path: "src/a.ts", line: 10, score: 4, category: "performance",
      headline: "h", body: "b", suggestedReplacement: "  return getUsers(ids)\n",
    }],
  }
  it("reads a non-empty suggestedReplacement (raw kept, incl. indentation/newline)", () => {
    const v = parsePrReviewResponse(JSON.stringify(base))
    expect(v?.findings[0]?.suggestedReplacement).toBe("  return getUsers(ids)\n")
  })
  it("drops an empty / whitespace-only suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: "   " }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
  it("ignores a non-string suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: 42 }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
  it("drops suggestedReplacement when the replacement exceeds 10 lines", () => {
    const tooLong = Array.from({ length: 11 }, (_, i) => `  line${i}`).join("\n")
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: tooLong }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })
  it("keeps suggestedReplacement when the replacement is exactly 10 lines", () => {
    const tenLines = Array.from({ length: 10 }, (_, i) => `  line${i}`).join("\n")
    const raw = { ...base, findings: [{ ...base.findings[0], suggestedReplacement: tenLines }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.suggestedReplacement).toBe(tenLines)
  })
})

describe("parsePrReviewResponse — kind / deletion suggestion (SIG-162 PR 5)", () => {
  const base = {
    summary: "s", confidence: 4, confidenceReason: "r",
    findings: [{
      path: "src/a.ts", line: 10, score: 4, category: "logic",
      headline: "h", body: "b",
    }],
  }

  it("preserves kind=\"delete\" + empty suggestedReplacement (deletion intent)", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], kind: "delete", suggestedReplacement: "" }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.kind).toBe("delete")
    expect(v?.findings[0]?.suggestedReplacement).toBe("")
  })

  it("preserves kind=\"replace\" + non-empty suggestedReplacement", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], kind: "replace", suggestedReplacement: "  return ok\n" }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.kind).toBe("replace")
    expect(v?.findings[0]?.suggestedReplacement).toBe("  return ok\n")
  })

  it("coerces kind=\"delete\" + NON-empty suggestedReplacement to kind=\"replace\" (intent inconsistent)", () => {
    // Model said delete but provided replacement content — trust the content
    // (it's the actionable signal), reclassify as replace so the renderer
    // emits a normal replacement suggestion instead of a deletion block.
    const raw = { ...base, findings: [{ ...base.findings[0], kind: "delete", suggestedReplacement: "  return ok\n" }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.kind).toBe("replace")
    expect(v?.findings[0]?.suggestedReplacement).toBe("  return ok\n")
  })

  it("drops kind=\"delete\" when suggestedReplacement is absent (ambiguous intent)", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], kind: "delete" }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.kind).toBeUndefined()
    expect(v?.findings[0]?.suggestedReplacement).toBeUndefined()
  })

  it("defaults kind to undefined when absent (back-compat with pre-PR5 prompts)", () => {
    const v = parsePrReviewResponse(JSON.stringify(base))
    expect(v?.findings[0]?.kind).toBeUndefined()
  })

  it("treats unknown kind values as if absent", () => {
    const raw = { ...base, findings: [{ ...base.findings[0], kind: "rearrange", suggestedReplacement: "x" }] }
    const v = parsePrReviewResponse(JSON.stringify(raw))
    expect(v?.findings[0]?.kind).toBeUndefined()
    // Replacement content is still preserved when present (back-compat).
    expect(v?.findings[0]?.suggestedReplacement).toBe("x")
  })
})

describe("formatFindingComment — deletion suggestion rendering (SIG-162 PR 5)", () => {
  const baseFinding: PrReviewFinding = {
    path: "src/a.ts", line: 12, startLine: 10, score: 5,
    category: "logic", headline: "remove unreachable branch",
    body: "Lines 10-12 are dead code after the refactor.",
    kind: "delete",
    suggestedReplacement: "",
  }
  // Map 10..12 as RIGHT-side reviewable so isFindingAnchorable passes.
  const reviewable: ReviewableMap = new Map([
    ["src/a.ts", [
      { line: 10, side: "RIGHT" as const },
      { line: 11, side: "RIGHT" as const },
      { line: 12, side: "RIGHT" as const },
    ]],
  ])

  it("emits an EMPTY ```suggestion block when kind=delete + anchorable + high-confidence", () => {
    const out = formatFindingComment(baseFinding, 5, reviewable)
    // The literal empty suggestion block: opening fence, empty content, closing fence.
    expect(out).toContain("```suggestion\n\n```")
  })

  it("falls back to descriptive text when kind=delete but NOT anchorable (out of diff hunk)", () => {
    const emptyReviewable: ReviewableMap = new Map()
    const out = formatFindingComment(baseFinding, 5, emptyReviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("**Proposed change:**")
    expect(out.toLowerCase()).toContain("remove")
  })

  it("falls back to descriptive text when kind=delete but confidence is below the committable floor", () => {
    const out = formatFindingComment(baseFinding, 2, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).toContain("**Proposed change:**")
  })

  it("kind=replace + non-empty content still renders as before (regression check)", () => {
    const f: PrReviewFinding = { ...baseFinding, kind: "replace", suggestedReplacement: "  return ok\n" }
    const out = formatFindingComment(f, 5, reviewable)
    expect(out).toContain("```suggestion")
    expect(out).toContain("return ok")
  })

  it("kind absent + suggestedReplacement absent → no suggestion block (back-compat)", () => {
    const f: PrReviewFinding = { path: "src/a.ts", line: 12, score: 4, category: "logic", headline: "x", body: "y" }
    const out = formatFindingComment(f, 5, reviewable)
    expect(out).not.toContain("```suggestion")
    expect(out).not.toContain("**Proposed change:**")
  })
})

describe("extensionToFenceLang (SIG-125)", () => {
  it("maps known extensions", () => {
    expect(extensionToFenceLang("src/a.ts")).toBe("ts")
    expect(extensionToFenceLang("src/a.tsx")).toBe("tsx")
    expect(extensionToFenceLang("x.py")).toBe("python")
    expect(extensionToFenceLang("x.json")).toBe("json")
  })
  it("returns empty string for unknown/extensionless paths", () => {
    expect(extensionToFenceLang("Makefile")).toBe("")
    expect(extensionToFenceLang("x.weird")).toBe("")
  })
  it("returns empty string for Object.prototype-key extensions (no proto pollution)", () => {
    expect(extensionToFenceLang("x.constructor")).toBe("")
    expect(extensionToFenceLang("x.__proto__")).toBe("")
    expect(extensionToFenceLang("x.toString")).toBe("")
    expect(extensionToFenceLang("x.hasOwnProperty")).toBe("")
  })
})
