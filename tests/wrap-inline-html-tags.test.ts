// ARC-156 follow-up: wrapInlineHtmlTags — defensive backtick wrap
// for HTML/JSX tag references in the model's prose output, fixing
// the rubberfit PR #232 rendering glitch where an unclosed `<kbd>`
// in the summary opened a real DOM element and wrapped the rest of
// the paragraph in monospace.

import { describe, it, expect } from "vitest"
import {
  wrapInlineHtmlTags,
  buildReviewSubmission,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "../src/lib/triage-pr-review"

describe("wrapInlineHtmlTags", () => {
  it("returns the input unchanged when there are no angle brackets", () => {
    expect(wrapInlineHtmlTags("clean prose, no tags here")).toBe(
      "clean prose, no tags here",
    )
  })

  it("returns the input unchanged on empty string", () => {
    expect(wrapInlineHtmlTags("")).toBe("")
  })

  it("wraps a bare HTML tag in backticks", () => {
    expect(wrapInlineHtmlTags("uses <kbd> elements")).toBe(
      "uses `<kbd>` elements",
    )
  })

  it("wraps a JSX-style PascalCase tag", () => {
    expect(wrapInlineHtmlTags("converts to <Link> components")).toBe(
      "converts to `<Link>` components",
    )
  })

  it("wraps closing tags", () => {
    expect(wrapInlineHtmlTags("after </div> the layout breaks")).toBe(
      "after `</div>` the layout breaks",
    )
  })

  it("wraps tags with attributes", () => {
    expect(wrapInlineHtmlTags('uses <details open> for the disclosure')).toBe(
      'uses `<details open>` for the disclosure',
    )
  })

  it("wraps multiple tags in one string", () => {
    expect(
      wrapInlineHtmlTags("converts <Link> and <kbd> per-key boxes"),
    ).toBe("converts `<Link>` and `<kbd>` per-key boxes")
  })

  it("skips tags that are already wrapped in backticks", () => {
    expect(wrapInlineHtmlTags("uses `<Link>` per docs")).toBe(
      "uses `<Link>` per docs",
    )
  })

  it("does not match math-like comparisons (1 < 2)", () => {
    expect(wrapInlineHtmlTags("when n < 2, return early")).toBe(
      "when n < 2, return early",
    )
  })

  it("does not match `<3` heart-like tokens (no `>` close)", () => {
    expect(wrapInlineHtmlTags("the team votes <3 for this")).toBe(
      "the team votes <3 for this",
    )
  })

  it("does not greedily span across newlines / multiple `<`", () => {
    // A < on one line and a > on the next shouldn't match as a tag.
    const s = "line one <\nline two with > on it"
    expect(wrapInlineHtmlTags(s)).toBe(s)
  })

  it("reproduces the rubberfit PR #232 fix on the actual broken summary", () => {
    const broken =
      "redesigns cmdk shortcuts with per-key <kbd> boxes plus in-input chord capture."
    const fixed =
      "redesigns cmdk shortcuts with per-key `<kbd>` boxes plus in-input chord capture."
    expect(wrapInlineHtmlTags(broken)).toBe(fixed)
  })
})

describe("buildReviewSubmission applies wrapInlineHtmlTags to verdict prose", () => {
  function makeVerdict(): PrReviewVerdict {
    return {
      summary:
        "PR redesigns cmdk shortcuts with per-key <kbd> boxes plus in-input chord capture.",
      confidence: 5,
      confidenceReason: "All changes are clean; uses Next.js <Link> correctly.",
      findings: [],
    }
  }

  it("wraps un-backticked tags in the rendered body summary + confidenceReason", () => {
    const submission = buildReviewSubmission({
      verdict: makeVerdict(),
      prAuthor: "daniel",
      headSha: "a".repeat(40),
    })
    expect(submission.body).toContain("`<kbd>`")
    expect(submission.body).toContain("`<Link>`")
    // The raw "<kbd>" and "<Link>" should no longer appear unwrapped.
    expect(submission.body).not.toMatch(/[^`]<kbd>[^`]/)
    expect(submission.body).not.toMatch(/[^`]<Link>[^`]/)
  })

  it("does not double-wrap tags the model already backticked", () => {
    const verdict: PrReviewVerdict = {
      summary: "PR uses `<Link>` from next/link.",
      confidence: 5,
      confidenceReason: "Clean.",
      findings: [],
    }
    const submission = buildReviewSubmission({
      verdict,
      prAuthor: "daniel",
      headSha: "a".repeat(40),
    })
    expect(submission.body).toContain("`<Link>`")
    // No double-backticked artifact like ``\`<Link>\``.
    expect(submission.body).not.toContain("``<Link>``")
  })

  it("wraps tags inside finding headlines and bodies", () => {
    const finding: PrReviewFinding = {
      path: "src/foo.tsx",
      line: 42,
      score: 3,
      category: "style",
      headline: "Should use <Link> here, not <a>",
      body: "Replace <a href={x}> with <Link href={x}>.",
    }
    const submission = buildReviewSubmission({
      verdict: { summary: "x", confidence: 3, confidenceReason: "y", findings: [finding] },
      prAuthor: "daniel",
      headSha: "a".repeat(40),
    })
    const comment = submission.comments![0]!
    expect(comment.body).toContain("`<Link>`")
    expect(comment.body).toContain("`<a>`")
    // Avoid the raw "<Link>" or "<a>" outside backticks.
    expect(comment.body).not.toMatch(/[^`]<Link>[^`]/)
  })
})
