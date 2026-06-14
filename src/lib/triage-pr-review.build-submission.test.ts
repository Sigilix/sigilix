import { describe, expect, it } from "vitest"
import {
  buildBodyOnlyCheckAnnotations,
  buildFallbackSubmission,
  buildReviewSubmission,
  buildReviewSubmissionWithMetadata,
  CHECK_ANNOTATION_TEXT_LIMIT,
  CHECK_ANNOTATION_TITLE_LIMIT,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"
import { baseFinding } from "@/src/lib/triage-pr-review.test-helpers"

describe("buildReviewSubmission", () => {
  const verdict: PrReviewVerdict = {
    summary: "Mostly clean; one logic bug.",
    confidence: 2,
    confidenceReason: "Off-by-one in the bounds check.",
    findings: [{ ...baseFinding, score: 5, headline: "off-by-one in `clampIndex`" }],
  }

  it("submits REQUEST_CHANGES on a score-5 finding", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc123" })
    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.commit_id).toBe("abc123")
  })

  it("includes one inline comment per finding with `path` + `line`", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.path).toBe(baseFinding.path)
    expect(out.comments?.[0]?.line).toBe(baseFinding.line)
    expect(out.comments?.[0]?.side).toBe("RIGHT")
  })

  it("omits start_line when finding has no startLine", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.start_line).toBeUndefined()
    expect(out.comments?.[0]?.start_side).toBeUndefined()
  })

  it("includes start_line + start_side when finding has startLine", () => {
    const v: PrReviewVerdict = {
      ...verdict,
      // SIG-281 PR B: score 5 keeps this inline (this describe's verdict
      // is confidence 2, so a sub-4 finding would now route to body via
      // the Rec 5 confidence gate — irrelevant to the start_line behavior
      // under test).
      findings: [{ ...baseFinding, score: 5, startLine: 38 }],
    }
    const out = buildReviewSubmission({ verdict: v, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.start_line).toBe(38)
    expect(out.comments?.[0]?.start_side).toBe("RIGHT")
  })

  it("omits comments[] entirely on empty findings (clean approval)", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean — nothing CR missed.",
      confidence: 5,
      confidenceReason: "Mechanical change.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    expect(out.event).toBe("APPROVE")
    expect(out.comments).toBeUndefined()
  })

  // ARC-293: APPROVE bodies render as MARKER-ONLY. The GitHub-native
  // "approved these changes" line carries the signal; the prior
  // verbose card (heading + coverage + "No issues found" + provenance
  // footer) was timeline noise.
  it("renders the ARC-293 marker-only APPROVE body on empty findings", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean — nothing CR missed.",
      confidence: 5,
      confidenceReason: "Mechanical change.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    // ARC-293 minimal: just the marker.
    expect(out.body).toBe("<!-- sigilix:pr-review -->\n")
    // Pre-ARC-281 strings must not survive the redesign.
    expect(out.body).not.toContain("✅ Sigilix reviewed this PR — no issues found")
    expect(out.body).not.toContain("nothing worth flagging")
    expect(out.body).not.toContain("Four-specialist ensemble")
    expect(out.body).not.toContain("### Sigilix Summary")
    // ARC-281 explicitly drops the dismissal hint on APPROVE bodies
    // (no review to dismiss).
    expect(out.body).not.toContain("To dismiss this review")
  })

  it("does NOT render REQUEST_CHANGES heading on an empty-findings APPROVE body", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    // The REQUEST_CHANGES path on `verdict` (which has findings) MUST
    // emit the count heading, not the marker-only APPROVE body.
    expect(out.body).toMatch(/^\*\*\d+ (high-severity|non-blocking|finding)/m)
  })

  it("ARC-281: REQUEST_CHANGES body has the new heading + dropped legacy strings", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).toContain("<!-- sigilix:pr-review -->")
    // New status heading replaces "### Sigilix Summary" entirely.
    expect(out.body).toMatch(/^\*\*\d+ (high-severity|non-blocking|finding)/m)
    // Summary still appears — but as its own paragraph, not under a
    // header.
    expect(out.body).toContain(verdict.summary)
    // confidenceReason is intentionally dropped from the body. The
    // field stays on the type for inline-comment rendering, but the
    // body no longer echoes it.
    expect(out.body).not.toContain(verdict.confidenceReason)
    expect(out.body).not.toContain("### Sigilix Summary")
    // Old format markers also gone.
    expect(out.body).not.toContain("[BLOCKER]")
    expect(out.body).not.toContain("**Confidence:**")
    expect(out.body).not.toContain("max score")
    // Dismissal hint is now required on REQUEST_CHANGES.
    expect(out.body).toContain("Dismiss: `@sigilix dismiss <reason>`")
    expect(out.body).toContain("@sigilix dismiss")
  })

  it("body is prose-only — no hardcoded author dialogue", () => {
    // The body lets the model's summary speak. We don't append
    // canned `@author — flagging items below for visibility...`
    // dialogue because it reads mechanical when it recurs across PRs.
    // Author-facing tone is the model's responsibility via `summary`.
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/@alice — /)
    expect(out.body).not.toMatch(/non-blocking/i)
    expect(out.body).not.toMatch(/Approving\.$/m)
  })

  it("ARC-281: the legacy '_N findings inline below._' pointer is removed entirely", () => {
    // Pre-ARC-281, REQUEST_CHANGES bodies carried a redundant
    // "_1 finding inline below._" line. Kimi's redesign drops it
    // (the heading "## Sigilix: 1 finding" already states the
    // count). This guards against re-adding it.
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/inline below/i)
    // The count IS in the heading though.
    expect(out.body).toMatch(/^\*\*\d+ (high-severity|non-blocking|finding)/m)
  })

  it("omits the count + Fix Plan + dismissal hint when there are zero findings (APPROVE path)", () => {
    const empty: PrReviewVerdict = {
      summary: "Looks clean.",
      confidence: 5,
      confidenceReason: "Mechanical.",
      findings: [],
    }
    const out = buildReviewSubmission({ verdict: empty, prAuthor: "alice", headSha: "abc" })
    expect(out.body).not.toMatch(/inline below/)
    expect(out.body).not.toContain("### Fix Plan")
    expect(out.body).not.toContain("To dismiss this review")
  })

  it("does not @-mention bot authors", () => {
    const empty: PrReviewVerdict = {
      summary: "Clean.",
      confidence: 5,
      confidenceReason: "Mechanical.",
      findings: [],
    }
    const out = buildReviewSubmission({
      verdict: empty,
      prAuthor: "openclaw[bot]",
      headSha: "abc",
    })
    expect(out.body).not.toContain("@openclaw[bot]")
  })

  it("preserves a ```suggestion block in finding body", () => {
    const v: PrReviewVerdict = {
      ...verdict,
      findings: [
        {
          ...baseFinding,
          // SIG-281 PR B: score 5 keeps this inline (verdict confidence 2
          // would otherwise route a sub-4 finding to body). The test is
          // about preserving a ```suggestion fence in the inline body.
          score: 5,
          body: "Use `??`.\n\n```suggestion\nconst x = a ?? b\n```",
        },
      ],
    }
    const out = buildReviewSubmission({ verdict: v, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.body).toContain("```suggestion")
    expect(out.comments?.[0]?.body).toContain("const x = a ?? b")
  })

  it("returns check annotations for findings rendered in the review body", () => {
    const unanchored = {
      ...baseFinding,
      path: "src/body-only.ts",
      line: 12,
      score: 4,
      category: "logic" as const,
      headline: "missing idempotency guard",
      body: "The new branch can process the same event twice.",
      failureExample: "opened/synchronize events are never exercised",
      testGap: "The sibling test only covers push events.",
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      unanchored: [unanchored],
    })

    // SIG-281 PR B (Rec 6): a score>=4 body-only finding is now a Fix Plan
    // table row + a collapsed evidence block (NOT the lower "Review Body
    // Findings" section, which holds only score<4 findings). Its evidence
    // (Example / "Why this wasn't caught") still renders, inside the
    // collapsed details block.
    expect(out.submission.body).toContain("Evidence &amp; suggested changes for body-only blockers")
    expect(out.submission.body).toContain("missing idempotency guard")
    expect(out.submission.body).not.toContain("### Review Body Findings")
    expect(out.submission.body).toContain("**Example:**")
    expect(out.submission.body).toContain("opened/synchronize events")
    expect(out.submission.body).toContain("**Why this wasn't caught:** The sibling test only covers push events.")
    expect(out.bodyOnlyFindings).toEqual([unanchored])
    expect(out.bodyOnlyAnnotations).toEqual([
      expect.objectContaining({
        path: "src/body-only.ts",
        start_line: 12,
        end_line: 12,
        annotation_level: "warning",
        title: "[P1] logic: missing idempotency guard",
      }),
    ])
  })

  it("routes broad-scope findings to body-only annotation metadata", () => {
    const fileFinding = {
      ...baseFinding,
      scope: "file" as const,
      score: 5,
      headline: "module invariant is unclear",
      body: "This is broader than one exact changed line.",
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: { ...verdict, findings: [fileFinding] },
      prAuthor: "alice",
      headSha: "abc",
    })

    // SIG-281 PR A: body-routed score-5 blocker → REQUEST_CHANGES (end-to-end
    // through buildReviewSubmissionWithMetadata), but still body-routed (no
    // inline comments). The merge gate now reflects the blocker.
    expect(out.submission.event).toBe("REQUEST_CHANGES")
    expect(out.submission.comments).toBeUndefined()
    expect(out.bodyOnlyFindings).toEqual([fileFinding])
    expect(out.bodyOnlyAnnotations[0]).toMatchObject({
      path: baseFinding.path,
      annotation_level: "failure",
      title: "[P0] logic: module invariant is unclear",
    })
  })

  it("honors REQUEST_CHANGES override even when every finding renders body-only", () => {
    const fileFinding = {
      ...baseFinding,
      scope: "file" as const,
      score: 5,
      headline: "approval-readiness blocker",
      body: "The finding is policy-level and must block despite body rendering.",
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: { ...verdict, findings: [fileFinding] },
      prAuthor: "alice",
      headSha: "abc",
      eventOverride: "REQUEST_CHANGES",
    })

    expect(out.submission.event).toBe("REQUEST_CHANGES")
    expect(out.submission.comments).toBeUndefined()
    expect(out.submission.body).toContain("Dismiss: `@sigilix dismiss <reason>`")
  })

  it("ignores unsafe non-blocking event overrides even if a caller casts around the type", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      eventOverride: "APPROVE" as unknown as "REQUEST_CHANGES",
    })

    expect(out.submission.event).toBe("REQUEST_CHANGES")
    expect(out.submission.comments).toHaveLength(1)
    expect(out.submission.body).toMatch(/^\*\*1 (high-severity|finding)/m)
  })

  it("renders approval-pending copy for forced blockers with no rendered findings", () => {
    const empty: PrReviewVerdict = {
      summary: "Approval validation still has an unresolved policy blocker.",
      confidence: 4,
      confidenceReason: "The blocker comes from approval-readiness validation.",
      findings: [],
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: empty,
      prAuthor: "alice",
      headSha: "abc",
      eventOverride: "REQUEST_CHANGES",
    })

    expect(out.submission.event).toBe("REQUEST_CHANGES")
    expect(out.submission.comments).toBeUndefined()
    expect(out.submission.body).toMatch(/^\*\*Approval pending\*\*/m)
    expect(out.submission.body).toContain("unresolved policy-level blocker")
    expect(out.submission.body).toContain("Approval validation still has an unresolved policy blocker.")
    expect(out.submission.body).not.toContain("0 findings")
  })

  it("SIG-414: renders distinct oversized + spillover notices, NOT the old lumped 'size budget' copy", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      disclosure: {
        policySkipped: [],
        oversized: ["src/big.ts"],
        spillover: ["src/a.ts", "src/b.ts"],
        reviewedCount: 3,
        totalChangedCount: 5,
      },
    })
    // Oversized — distinct per-file copy.
    expect(out.submission.body).toContain(
      "📄 `src/big.ts` was not reviewed — its diff is too large to analyze inline in this review.",
    )
    // Spillover — reconciled n-of-m copy with the remaining count.
    expect(out.submission.body).toContain(
      "📊 Reviewed 3 of 5 changed files — the remaining 2 were below the priority cutoff",
    )
    // The old conflated framing is gone.
    expect(out.submission.body).not.toContain("size budget")
    expect(out.submission.body).not.toContain("not analyzed")
    // Notices sit up top, under the headline lead line (first third of the body).
    expect(out.submission.body!.indexOf("was not reviewed")).toBeGreaterThanOrEqual(0)
    expect(out.submission.body!.indexOf("was not reviewed")).toBeLessThan(out.submission.body!.length / 3)
  })

  it("SIG-414: the policy note is a calm collapsed <details> with no ⚠️, listing the skipped files", () => {
    const out = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      disclosure: {
        policySkipped: ["package-lock.json", "dist/bundle.min.js"],
        oversized: [],
        spillover: [],
        reviewedCount: 2,
        totalChangedCount: 2,
      },
    })
    expect(out.submission.body).toContain(
      "📋 2 files skipped — lockfiles, generated, vendored, minified, or binary files aren't reviewed by default.",
    )
    expect(out.submission.body).toContain("<details>")
    expect(out.submission.body).toContain("`package-lock.json`")
    expect(out.submission.body).toContain("`dist/bundle.min.js`")
    // Calm — no alarming glyph, no blockquote for the policy note.
    expect(out.submission.body).not.toContain("⚠️")
  })

  it("SIG-414: singular phrasing for one spillover file; no disclosure when nothing dropped", () => {
    const one = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      disclosure: {
        policySkipped: [],
        oversized: [],
        spillover: ["src/a.ts"],
        reviewedCount: 4,
        totalChangedCount: 5,
      },
    })
    expect(one.submission.body).toContain("the remaining 1 was below the priority cutoff")
    const none = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
    })
    expect(none.submission.body).not.toContain("was not reviewed")
    expect(none.submission.body).not.toContain("skipped —")
  })

  it("SIG-414: a POLICY-ONLY skip surfaces on the APPROVE body (no downgrade, but still visible)", () => {
    // The ensemble keeps APPROVE for a policy-only skip (it's "not applicable",
    // not a coverage gap), so renderApproveBody must carry the policy note —
    // the marker-only APPROVE body would otherwise discard it.
    const empty: PrReviewVerdict = {
      summary: "No issues found in the reviewed files.",
      confidence: 4,
      confidenceReason: "Reviewed batch was clean.",
      findings: [],
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: empty,
      prAuthor: "alice",
      headSha: "abc",
      // No eventOverride → clean APPROVE.
      disclosure: {
        policySkipped: ["package-lock.json"],
        oversized: [],
        spillover: [],
        reviewedCount: 3,
        totalChangedCount: 3,
      },
    })
    expect(out.submission.event).toBe("APPROVE")
    expect(out.submission.body).toContain("**Approved**")
    expect(out.submission.body).toContain("1 file skipped — lockfiles, generated, vendored")
    expect(out.submission.body).toContain("`package-lock.json`")
  })

  it("SIG-414: the disclosure survives on a ZERO-findings review downgraded to COMMENT (oversized/spillover hole)", () => {
    // Oversized + spillover are real coverage gaps → the ensemble downgrades
    // APPROVE→COMMENT, so a clean-batch[0] review routes through the findings
    // body (which renders the notice) instead of the marker-only APPROVE body.
    const empty: PrReviewVerdict = {
      summary: "No issues found in the reviewed files.",
      confidence: 4,
      confidenceReason: "Reviewed batch was clean.",
      findings: [],
    }
    const out = buildReviewSubmissionWithMetadata({
      verdict: empty,
      prAuthor: "alice",
      headSha: "abc",
      eventOverride: "COMMENT",
      disclosure: {
        policySkipped: [],
        oversized: ["src/big.ts"],
        spillover: [],
        reviewedCount: 2,
        totalChangedCount: 2,
      },
    })
    expect(out.submission.event).toBe("COMMENT")
    expect(out.submission.body).toContain("📄 `src/big.ts` was not reviewed")
  })

  it("SIG-414: the anchorless fallback body also carries the disclosure (CR #286)", () => {
    // The 422-retry path re-renders via buildFallbackSubmission; it must not
    // silently omit the un-reviewed disclosure either.
    const out = buildFallbackSubmission({
      verdict: {
        summary: "Re-rendered anchorless.",
        confidence: 4,
        confidenceReason: "y",
        findings: [],
      },
      unanchored: [],
      prAuthor: null,
      headSha: "abc",
      eventOverride: "COMMENT",
      disclosure: {
        policySkipped: [],
        oversized: [],
        spillover: ["src/a.ts"],
        reviewedCount: 4,
        totalChangedCount: 5,
      },
    })
    expect(out.event).toBe("COMMENT")
    expect(out.body).toContain("📊 Reviewed 4 of 5 changed files")
  })

  it("SIG-414: the anchorless fallback APPROVE body carries a policy-only disclosure", () => {
    // A policy-only skip stays APPROVE even on the fallback path — the policy
    // note must survive (pre-SIG-414 the APPROVE fallback branch dropped it).
    const out = buildFallbackSubmission({
      verdict: { summary: "Re-rendered anchorless.", confidence: 4, confidenceReason: "y", findings: [] },
      unanchored: [],
      prAuthor: null,
      headSha: "abc",
      // No eventOverride → APPROVE.
      disclosure: {
        policySkipped: ["yarn.lock"],
        oversized: [],
        spillover: [],
        reviewedCount: 1,
        totalChangedCount: 1,
      },
    })
    expect(out.event).toBe("APPROVE")
    expect(out.body).toContain("1 file skipped — lockfiles, generated, vendored")
    expect(out.body).toContain("`yarn.lock`")
  })
})

describe("buildBodyOnlyCheckAnnotations", () => {
  it("sorts annotations by severity and preserves line ranges", () => {
    const annotations = buildBodyOnlyCheckAnnotations([
      { ...baseFinding, path: "b.ts", line: 20, score: 2, headline: "low" },
      { ...baseFinding, path: "a.ts", startLine: 10, line: 14, score: 5, headline: "critical" },
    ])

    expect(annotations[0]).toMatchObject({
      path: "a.ts",
      start_line: 10,
      end_line: 14,
      annotation_level: "failure",
      title: "[P0] logic: critical",
    })
    expect(annotations[1]).toMatchObject({
      path: "b.ts",
      start_line: 20,
      end_line: 20,
      annotation_level: "notice",
      title: "[P3] logic: low",
    })
  })

  it("EXCLUDES out-of-PR-scope findings — no check annotation on an untouched file (CodeRabbit #334)", () => {
    const annotations = buildBodyOnlyCheckAnnotations([
      { ...baseFinding, path: "in-pr.ts", line: 5, score: 5, headline: "real blocker" },
      {
        ...baseFinding,
        path: "other.ts",
        line: 9,
        score: 5,
        headline: "out of scope",
        outOfPrScope: true,
      },
    ])
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ path: "in-pr.ts" })
    expect(annotations.some((a) => a.path === "other.ts")).toBe(false)
  })

  it("drops findings that cannot map to a check-run annotation location", () => {
    const annotations = buildBodyOnlyCheckAnnotations([
      { ...baseFinding, path: "", line: 20, headline: "missing path" },
      { ...baseFinding, path: "src/app.ts", line: 0, headline: "missing line" },
      { ...baseFinding, path: "src/app.ts", line: -5, headline: "negative line" },
      { ...baseFinding, path: "src/valid.ts", line: 7, headline: "valid" },
    ])

    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      path: "src/valid.ts",
      start_line: 7,
      end_line: 7,
    })
  })

  it("truncates oversized annotation titles and messages to GitHub-safe limits", () => {
    const annotations = buildBodyOnlyCheckAnnotations([
      {
        ...baseFinding,
        headline: "x".repeat(400),
        body: "y".repeat(70000),
      },
    ])

    expect(annotations[0]!.title).toHaveLength(CHECK_ANNOTATION_TITLE_LIMIT)
    expect(annotations[0]!.title!.endsWith("…")).toBe(true)
    expect(annotations[0]!.message).toHaveLength(CHECK_ANNOTATION_TEXT_LIMIT)
    expect(annotations[0]!.message.endsWith("…")).toBe(true)
  })

  it("includes structured examples in annotation messages", () => {
    const annotations = buildBodyOnlyCheckAnnotations([
      {
        ...baseFinding,
        path: "src/parser.ts",
        line: 24,
        scope: "file",
        failureExample: "input: FINAL(wrong) then FINAL(correct)",
        testGap: "The existing test only covers one FINAL(...) token.",
      },
    ])

    expect(annotations[0]!.message).toContain("**Example:**")
    expect(annotations[0]!.message).toContain("FINAL(wrong)")
    expect(annotations[0]!.message).toContain("**Why this wasn't caught:**")
  })
})

describe("buildReviewSubmission — ARC-189 sigilix marker append (Task 2.5)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Two findings.",
    // SIG-281 PR B: confidence 4 so the score-2 finding stays inline (the
    // Rec 5 gate only demotes sub-4 findings at confidence <= 3). This
    // describe verifies marker ALIGNMENT across two inline comments, not
    // routing.
    confidence: 4,
    confidenceReason: "Mixed.",
    findings: [
      { ...baseFinding, score: 5, headline: "off-by-one in clampIndex" },
      { ...baseFinding, score: 2, headline: "double-fetch in handler", line: 100 },
    ],
  }

  it("appends the marker on its own line at end of comment body", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [
        "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
        "<!-- sigilix:fid:2222222222222222:cat:logic:sev:info:path:222222222222 -->",
      ],
    })
    expect(
      out.comments?.[0]?.body.endsWith("<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->"),
    ).toBe(true)
    expect(out.comments?.[1]?.body).toContain(
      "<!-- sigilix:fid:2222222222222222:cat:logic:sev:info:path:222222222222 -->",
    )
  })

  it("preserves the existing sigilix:pr-review-finding marker AND appends sigilix marker", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: ["<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->", null],
    })
    const body = out.comments?.[0]?.body ?? ""
    expect(body).toContain("<!-- sigilix:pr-review-finding -->")
    expect(body).toContain("<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->")
  })

  it("emits no marker when findingMarkers entry is null (sparse opt-out per finding)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [null, null],
    })
    expect(out.comments?.[0]?.body).not.toContain("sigilix:fid:")
    expect(out.comments?.[1]?.body).not.toContain("sigilix:fid:")
  })

  it("emits no marker when findingMarkers omitted entirely (backward compat)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
    })
    expect(out.comments?.[0]?.body).not.toContain("sigilix:fid:")
  })

  it("separates marker from body with a blank line", () => {
    const marker = "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->"
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [marker, null],
    })
    expect(out.comments?.[0]?.body).toMatch(
      /[^\n]\n\n<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->$/,
    )
  })
})

describe("buildReviewSubmission — SIG-127 non-substantive anchor routing", () => {
  const codeFinding: PrReviewFinding = {
    path: "src/lib/foo.ts",
    line: 42,
    score: 4,
    category: "logic",
    headline: "off-by-one in clampIndex",
    body: "Use `<=` instead of `<`.",
  }
  const blockFinding: PrReviewFinding = {
    path: "src/lib/foo.ts",
    line: 1370,
    score: 3,
    category: "logic",
    headline: "lacks integration tests for the queue consumer",
    body: "Add an end-to-end test exercising the consumer.",
  }

  const verdict: PrReviewVerdict = {
    summary: "One real finding, one block-level finding.",
    confidence: 4,
    confidenceReason: "Mixed.",
    findings: [codeFinding, blockFinding],
  }

  // Map says line 42 is real code, line 1370 is a bare `}`.
  const addedLineTextByLine = new Map<string, Map<number, string>>([
    [
      "src/lib/foo.ts",
      new Map<number, string>([
        [42, "  const idx = clampIndex(i)"],
        [1370, "}"],
      ]),
    ],
  ])

  it("routes a finding anchored to a `}` into the body, not the inline comments", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    // The non-substantive finding is NOT an inline comment.
    const inlinePaths = (out.comments ?? []).map((c) => c.body)
    expect(inlinePaths.some((b) => b.includes("lacks integration tests"))).toBe(false)
    // It appears in the body instead.
    expect(out.body).toContain("lacks integration tests for the queue consumer")
  })

  it("inline-more-in-diff: a finding anchored to a `}` walks forward to the SUBSTANTIVE added line and stays INLINE", () => {
    // The brace at 1370 has real added code right after it (1372) — instead of
    // demoting to the body, anchor forward to the substantive line (CodeRabbit
    // parity). Score-4 isolates this from the SIG-281 confidence demotion.
    const braceP1: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 1370,
      score: 4,
      category: "logic",
      headline: "race in the queue consumer",
      body: "Guard the check-then-act.",
    }
    const mapWithCodeAfter = new Map<string, Map<number, string>>([
      [
        "src/lib/foo.ts",
        new Map<number, string>([
          [1370, "}"],
          [1372, "  await processQueue(batch)"],
        ]),
      ],
    ])
    const out = buildReviewSubmission({
      verdict: { ...verdict, findings: [braceP1] },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine: mapWithCodeAfter,
    })
    const inline = (out.comments ?? []).find((c) => c.body.includes("race in the queue consumer"))
    expect(inline).toBeDefined()
    expect(inline?.line).toBe(1372) // walked forward from the `}` (1370) to real code
    // (a P1 is ALSO summarized in the Fix Plan table — that's expected; the proof
    // of "stayed inline" is the inline comment above, not a body absence.)
    expect(out.body).not.toContain("### Review Body Findings")
  })

  it("keeps a finding anchored to real code as an inline comment", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(42)
    expect(out.comments?.[0]?.body).toContain("off-by-one in clampIndex")
  })

  it("back-compat: no addedLineTextByLine arg → all findings inline exactly as before", () => {
    const withMap = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
    })
    expect(withMap.comments).toHaveLength(2)
    expect(withMap.comments?.map((c) => c.line).sort((a, b) => a! - b!)).toEqual([42, 1370])
    // Neither block finding is double-rendered into the body.
    expect(withMap.body).not.toContain("Review Body Findings")
  })

  it("does not double-render a routed finding (only in body, not inline)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    const inlineCount = (out.comments ?? []).filter((c) => c.body.includes("lacks integration tests")).length
    expect(inlineCount).toBe(0)
    const bodyOccurrences = (out.body ?? "").split("lacks integration tests").length - 1
    expect(bodyOccurrences).toBe(1)
  })

  it("marker alignment: substantive finding carries ITS marker after a non-substantive one is filtered out", () => {
    // findings[0] = blockFinding (non-substantive → moved to body),
    // findings[1] = codeFinding (substantive → stays inline). The
    // inline comment for codeFinding must carry markers[1], not markers[0].
    const mixedVerdict: PrReviewVerdict = {
      summary: "block then code.",
      confidence: 4,
      confidenceReason: "Mixed.",
      findings: [blockFinding, codeFinding],
    }
    const markerForBlock = "<!-- sigilix:fid:aaaaaaaaaaaaaaaa:cat:testing:sev:warn:path:aaaaaaaaaaaa -->"
    const markerForCode = "<!-- sigilix:fid:bbbbbbbbbbbbbbbb:cat:logic:sev:error:path:bbbbbbbbbbbb -->"
    const out = buildReviewSubmission({
      verdict: mixedVerdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [markerForBlock, markerForCode],
      addedLineTextByLine,
    })
    expect(out.comments).toHaveLength(1)
    const body = out.comments?.[0]?.body ?? ""
    expect(body).toContain("off-by-one in clampIndex")
    expect(body).toContain(markerForCode)
    expect(body).not.toContain(markerForBlock)
  })

  it("routes a substantive finding to the body but still BLOCKS (founder verdict rule)", () => {
    // blockFinding ("lacks integration tests", score 3) is substantive — it has
    // no inline anchor so it renders in the body, but a real finding always
    // gates the merge (REQUEST_CHANGES), never a green COMMENT.
    const allBlock: PrReviewVerdict = {
      summary: "only block-level findings.",
      confidence: 4,
      confidenceReason: "Block.",
      findings: [{ ...blockFinding }],
    }
    const out = buildReviewSubmission({
      verdict: allBlock,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments ?? []).toHaveLength(0) // no inline anchor → routed to body
    expect(out.body).toContain("lacks integration tests")
    expect(out.body).not.toMatch(/non-blocking/) // blocking review never labels its findings "non-blocking"
  })

  it("keeps a suggestion-bearing finding inline even when anchored to a `}` (preserves the fix)", () => {
    const fixFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 1370,
      startLine: 1368,
      score: 4,
      category: "logic",
      headline: "close the missing guard",
      body: "Add the early return.",
      suggestedReplacement: "  if (!ok) return\n}",
    }
    const v: PrReviewVerdict = {
      summary: "One range fix ending on a brace.",
      confidence: 5,
      confidenceReason: "Localized.",
      findings: [fixFinding],
    }
    const out = buildReviewSubmission({
      verdict: v,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    // Stays inline so the suggestion block is not dropped.
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.body).toContain("close the missing guard")
    expect(out.comments?.[0]?.body).toContain("if (!ok) return")
  })

  // SIG-159 PR1: replaces the prior "treats line-absent-from-map as
  // substantive" test (which preserved a buggy back-compat where the
  // model could anchor to a context `}` and the finding stayed inline
  // looking like a comment on punctuation). The new contract: when
  // the map IS provided but the requested line isn't an added line,
  // walk forward to the nearest added line in the same file. If none
  // exists, route to summary.

  it("walk-forward: re-anchors to the nearest later added line when requested line is a context line", () => {
    // codeFinding anchors at line 42 (added, real code — fast path)
    // blockFinding anchors at line 1370 (added, `}` — non-substantive)
    // New finding anchors at line 30 (NOT in map; line 42 is the next added line on the file)
    const contextFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 30,
      score: 4,
      category: "logic",
      headline: "the new handler ignores idempotency",
      body: "Wrap the call in a dedupe gate.",
    }
    const v: PrReviewVerdict = {
      summary: "Anchor walked.",
      confidence: 4,
      confidenceReason: "Walked.",
      findings: [contextFinding],
    }
    const out = buildReviewSubmission({
      verdict: v,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    // Re-anchored to line 42 (the nearest later added line) + still inline.
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(42)
    expect(out.comments?.[0]?.body).toContain("ignores idempotency")
  })

  it("walk-forward: re-anchored line still runs through the substantive check (lands on `}` → routes to summary)", () => {
    // Anchor at line 1000 (not in map); the only added line at-or-after
    // 1000 is 1370, which is `}` → after walking, the non-substantive
    // check fires and routes the finding to summary.
    const orphanFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 1000,
      score: 3,
      category: "complexity",
      headline: "complexity creeping in this block",
      body: "Consider extracting a helper.",
    }
    const v: PrReviewVerdict = {
      summary: "Walks then routes.",
      confidence: 4,
      confidenceReason: "Both gates.",
      findings: [orphanFinding],
    }
    const out = buildReviewSubmission({
      verdict: v,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    // No inline comment (the walked-forward line is `}` → summary).
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("complexity creeping in this block")
  })

  it("walk-forward: routes to summary when there is NO added line at or after the requested line", () => {
    // Anchor at line 9999 — past every added line on the file. No
    // walk-forward target exists → finding routes to summary.
    const tailFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 9999,
      score: 3,
      category: "complexity",
      headline: "structural concern with the file",
      body: "Worth splitting.",
    }
    const v: PrReviewVerdict = {
      summary: "Tail miss.",
      confidence: 4,
      confidenceReason: "Past end.",
      findings: [tailFinding],
    }
    const out = buildReviewSubmission({
      verdict: v,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("structural concern with the file")
    expect(out.body).toContain("(line moved — see file at `abc`)")
  })

  it("walk-forward: a suggestion-bearing finding bypasses walk-forward (preserves the fix)", () => {
    // SIG-127 already pins this: a finding with `suggestedReplacement`
    // stays inline regardless of anchor substance. Re-validate post-PR1:
    // even when the anchor line is absent from the map, the suggestion
    // shield keeps it inline at the model-given line — walk-forward
    // would risk losing the contiguous replacement range.
    const fixFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 700,
      startLine: 698,
      score: 5,
      category: "logic",
      headline: "off-by-one in the loop bound",
      body: "Replace `<` with `<=`.",
      suggestedReplacement: "  for (let i = 0; i <= n; i++) {",
    }
    const v: PrReviewVerdict = {
      summary: "Has a fix.",
      confidence: 5,
      confidenceReason: "Has fix.",
      findings: [fixFinding],
    }
    const out = buildReviewSubmission({
      verdict: v,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    expect(out.comments).toHaveLength(1)
    // Line preserved (no walk) because the suggestion needs the original
    // multi-line range to anchor cleanly.
    expect(out.comments?.[0]?.line).toBe(700)
  })
})
