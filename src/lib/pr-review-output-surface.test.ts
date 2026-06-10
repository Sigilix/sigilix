// SIG-144 — unit tests for the PURE review-output-surface helpers in
// `pr-review-check-run.ts`: surface parsing/predicates, the plain-text
// annotation sanitizer, the primary-submit annotation selection, and the
// inline-comment suppression. Split out of `pr-review-check-run.test.ts`
// (which carries the check-run lifecycle + GitHub-API integration tests, and
// is large enough that the review bot skips it for size) so these
// fast, mock-free unit tests live in a small, independently-reviewable file.

import { describe, expect, it } from "vitest"

import {
  parseReviewOutputSurface,
  surfacePostsAnnotations,
  surfacePostsInlineComments,
  selectPrimarySubmitAnnotations,
  applyOutputSurfaceToSubmission,
  ANNOTATIONS_ONLY_BODY_NOTE,
  toPlainTextAnnotation,
} from "@/lib/pr-review-check-run"
import type { CheckRunAnnotation } from "@/shared/types/github"

describe("SIG-144: parseReviewOutputSurface + surface predicates", () => {
  it("defaults to `comments` when unset / empty / unrecognized", () => {
    expect(parseReviewOutputSurface(undefined)).toBe("comments")
    expect(parseReviewOutputSurface(null)).toBe("comments")
    expect(parseReviewOutputSurface("")).toBe("comments")
    expect(parseReviewOutputSurface("nonsense")).toBe("comments")
    expect(parseReviewOutputSurface("off")).toBe("comments")
  })

  it("parses `annotations` / `both` / `comments`, case- + whitespace-insensitive", () => {
    expect(parseReviewOutputSurface("annotations")).toBe("annotations")
    expect(parseReviewOutputSurface("  Annotations ")).toBe("annotations")
    expect(parseReviewOutputSurface("BOTH")).toBe("both")
    expect(parseReviewOutputSurface("comments")).toBe("comments")
  })

  it("predicates gate the right surfaces", () => {
    expect(surfacePostsAnnotations("comments")).toBe(false)
    expect(surfacePostsAnnotations("annotations")).toBe(true)
    expect(surfacePostsAnnotations("both")).toBe(true)
    expect(surfacePostsInlineComments("comments")).toBe(true)
    expect(surfacePostsInlineComments("annotations")).toBe(false)
    expect(surfacePostsInlineComments("both")).toBe(true)
  })
})

describe("SIG-144: toPlainTextAnnotation", () => {
  it("strips markdown + HTML so GitHub's plain-text rendering reads cleanly", () => {
    const a: CheckRunAnnotation = {
      path: "src/app.ts",
      start_line: 10,
      end_line: 12,
      annotation_level: "warning",
      title: "[P1] **logic**: `foo` is wrong",
      message: "**Bold** body with `code` and a [link](https://x.test) <img src=\"b.svg\" />\n\n\n\nmore",
      raw_details: "```ts\nconst x = 1\n```",
    }
    const out = toPlainTextAnnotation(a)

    expect(out.title).toBe("[P1] logic: foo is wrong")
    expect(out.message).toContain("Bold body with code and a link (https://x.test)")
    expect(out.message).toContain("more")
    expect(out.message).not.toContain("**")
    expect(out.message).not.toContain("<")
    expect(out.message).not.toContain("`")
    expect(out.message).not.toMatch(/\n{3,}/)
    expect(out.raw_details).toBe("const x = 1")
    // structural fields preserved verbatim
    expect(out.path).toBe("src/app.ts")
    expect(out.start_line).toBe(10)
    expect(out.end_line).toBe(12)
    expect(out.annotation_level).toBe("warning")
  })

  it("preserves TypeScript generics in finding text (does NOT treat them as HTML tags)", () => {
    const out = toPlainTextAnnotation({
      path: "a.ts", start_line: 1, end_line: 1,
      annotation_level: "warning",
      title: "Type `Map<string, number>` is wrong",
      message: "Use `Promise<void>` not `Promise<any>`; also `Array<Record<string, T>>` and a < b comparison.",
    })
    expect(out.title).toBe("Type Map<string, number> is wrong")
    expect(out.message).toContain("Promise<void>")
    expect(out.message).toContain("Promise<any>")
    expect(out.message).toContain("Array<Record<string, T>>")
    expect(out.message).toContain("a < b")
  })

  it("strips REAL renderer tags but PRESERVES entity-encoded markup as readable example text", () => {
    // Real <details> emitted by our renderer → unwrapped. Entity-encoded
    // markup is example text the author wrote → decoded LAST to readable
    // literal characters, NOT mistaken for a tag and deleted. (PR #339:
    // CodeRabbit code-span corruption + Sigilix decode-order.)
    const out = toPlainTextAnnotation({
      path: "a.ts", start_line: 1, end_line: 1,
      annotation_level: "notice",
      message: "<details><summary>x</summary>Use `&lt;details&gt;` not `&lt;div&gt;`</details> **bold**",
    })
    expect(out.message).not.toContain("**")            // markdown stripped
    expect(out.message).toContain("Use <details> not <div>") // example text survives
    expect(out.message).toContain("bold")
    // the real <summary>/<details> wrappers are gone (only the decoded
    // example angle-brackets remain)
    expect(out.message).not.toContain("<summary>")
  })

  it("removes dangerous element bodies entirely (script/style) — defense in depth", () => {
    const out = toPlainTextAnnotation({
      path: "a.ts", start_line: 1, end_line: 1,
      annotation_level: "warning",
      message: "before <script>alert(1)</script> after <style>.x{}</style> end",
    })
    expect(out.message).not.toContain("alert(1)")
    expect(out.message).not.toContain("script")
    expect(out.message).not.toContain(".x{}")
    expect(out.message).toContain("before")
    expect(out.message).toContain("after")
    expect(out.message).toContain("end")
  })

  it("preserves entity-encoded dangerous markup as readable text (plain-text sink, not stripped)", () => {
    // The deny-list runs before the entity decode, so an author's literal
    // example `&lt;script&gt;…` decodes to readable text rather than being
    // removed — which is correct here because GitHub renders this field as
    // PLAIN TEXT (inert). Pins the decode-order/deny-list interaction so a
    // future reader doesn't mistake the deny-list for a load-bearing sanitizer.
    const out = toPlainTextAnnotation({
      path: "a.ts", start_line: 1, end_line: 1,
      annotation_level: "warning",
      message: "Reject untrusted `&lt;script&gt;alert(1)&lt;/script&gt;` payloads",
    })
    expect(out.message).toBe("Reject untrusted <script>alert(1)</script> payloads")
  })

  it("leaves an undefined title/raw_details undefined", () => {
    const out = toPlainTextAnnotation({
      path: "a.ts", start_line: 1, end_line: 1,
      annotation_level: "notice", message: "plain",
    })
    expect(out.title).toBeUndefined()
    expect(out.raw_details).toBeUndefined()
    expect(out.message).toBe("plain")
  })
})

describe("SIG-144: selectPrimarySubmitAnnotations", () => {
  const bodyOnly: CheckRunAnnotation[] = [
    { path: "a.ts", start_line: 1, end_line: 1, annotation_level: "notice", message: "unanchored" },
  ]
  const all: CheckRunAnnotation[] = [
    ...bodyOnly,
    { path: "b.ts", start_line: 2, end_line: 2, annotation_level: "warning", message: "anchored" },
  ]

  it("comments / both → body-only (anchored findings are inline comments; no double-post)", () => {
    expect(selectPrimarySubmitAnnotations("comments", bodyOnly, all)).toBe(bodyOnly)
    expect(selectPrimarySubmitAnnotations("both", bodyOnly, all)).toBe(bodyOnly)
  })

  it("annotations → ALL findings (inline comments suppressed; nothing dropped)", () => {
    expect(selectPrimarySubmitAnnotations("annotations", bodyOnly, all)).toBe(all)
  })
})

describe("SIG-144: applyOutputSurfaceToSubmission (inline-comment suppression)", () => {
  function makeSubmission() {
    return {
      event: "REQUEST_CHANGES" as const,
      body: "<!-- sigilix:pr-review -->\nVerdict body.",
      comments: [{ path: "a.ts", line: 1, body: "x" }, { path: "b.ts", line: 2, body: "y" }],
    }
  }

  it("annotations mode strips inline comments and appends the Checks pointer to the body", () => {
    const submission = makeSubmission()
    const { suppressedComments } = applyOutputSurfaceToSubmission(submission, "annotations")

    expect(suppressedComments).toBe(2)
    expect(submission.comments).toEqual([])
    expect(submission.body).toContain("Verdict body.")
    expect(submission.body).toContain(ANNOTATIONS_ONLY_BODY_NOTE)
  })

  it("comments / both leave the submission untouched", () => {
    for (const surface of ["comments", "both"] as const) {
      const submission = makeSubmission()
      const before = JSON.parse(JSON.stringify(submission))
      const { suppressedComments } = applyOutputSurfaceToSubmission(submission, surface)
      expect(suppressedComments).toBe(0)
      expect(submission).toEqual(before)
    }
  })

  it("annotations mode with no inline comments is a no-op (no spurious body note)", () => {
    const submission = { event: "APPROVE" as const, body: "All good.", comments: [] as unknown[] }
    const { suppressedComments } = applyOutputSurfaceToSubmission(submission, "annotations")
    expect(suppressedComments).toBe(0)
    expect(submission.body).toBe("All good.")
  })
})
