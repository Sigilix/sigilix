// ARC-281 — exhaustive variant tests for the new body renderers.
//
// `renderApproveBody` and `renderRequestChangesBody` replace
// `formatReviewBody`. Per the AC, every body variant must have a
// snapshot-style assertion: approve, request_changes, degraded,
// stacked, delta, with-unanchored, plus the markup-level rules
// Kimi specified (marker at line 1, no emoji, dismissal hint on
// REQUEST_CHANGES only, etc.). This file covers them all so the
// design doc and code can't drift apart silently.

import { describe, expect, it } from "vitest"

import {
  renderApproveBody,
  renderRequestChangesBody,
  renderCommentBody,
  renderCoverageLine,
  renderDeltaBadge,
  renderStackParenthetical,
  type PrReviewVerdict,
  type PrReviewFinding,
  type CoverageRoles,
  type ReviewDisclosure,
} from "@/src/lib/triage-pr-review"
import type { StackContext, StackPr } from "@/src/lib/pr-stack"
// SIG-417: the cost-trim disclosure aspect lives in `triage-pr-review-body.cost-trim.test.ts`.

const HEAD = "abcdef1234567890abcdef1234567890abcdef12"
const NOW = 1747547318000 // 2025-05-18T05:48:38.000Z

function verdict(overrides: Partial<PrReviewVerdict> = {}): PrReviewVerdict {
  return {
    summary: "The PR adds a feature flag and a test.",
    confidence: 4,
    confidenceReason: "All changes are clean.",
    findings: [],
    ...overrides,
  }
}

function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/foo.ts",
    line: 42,
    headline: "Headline text",
    body: "Body text.",
    score: 3,
    category: "logic",
    ...overrides,
  }
}

const FULL: CoverageRoles = {
  dispatched: ["logic", "security", "performance", "tests"],
  succeeded: ["logic", "security", "performance", "tests"],
}

const ONE_MISSING: CoverageRoles = {
  dispatched: ["logic", "security", "performance", "tests"],
  succeeded: ["logic", "security", "tests"],
}

const THREE_MISSING: CoverageRoles = {
  dispatched: ["logic", "security", "performance", "tests"],
  succeeded: ["logic"],
}

function stack(parentNumber: number | null): StackContext {
  const parent: StackPr | null =
    parentNumber === null
      ? null
      : {
          number: parentNumber,
          title: `PR #${parentNumber}`,
          baseRef: "main",
          headRef: `feature-${parentNumber}`,
          headRepo: "Sigilix/sigilix",
          baseRepo: "Sigilix/sigilix",
          author: "alice",
          updatedAt: "2026-05-01T00:00:00Z",
        }
  return {
    isStacked: parentNumber !== null,
    position: parentNumber === null ? 1 : 2,
    depth: parentNumber === null ? 1 : 2,
    parent,
    ancestors: parent ? [parent] : [],
    children: [],
    root: parent,
    cycleDetected: false,
    stackWalkCapped: false,
    hasUpstackFork: false,
  }
}

// ─── renderCoverageLine ───────────────────────────────────────────────

describe("renderCoverageLine (ARC-281)", () => {
  it("returns null when nothing was dispatched", () => {
    expect(renderCoverageLine({ dispatched: [], succeeded: [] })).toBeNull()
  })

  it("renders the full coverage line when succeeded == dispatched", () => {
    expect(renderCoverageLine(FULL)).toBe("**Coverage:** logic · security · performance · tests")
  })

  it("renders the inline degraded line when 1 role is missing", () => {
    expect(renderCoverageLine(ONE_MISSING)).toBe(
      "**Coverage:** logic · security · tests — _performance specialist unavailable_",
    )
  })

  it("renders the inline degraded line when 2 roles are missing", () => {
    expect(
      renderCoverageLine({
        dispatched: ["logic", "security", "performance", "tests"],
        succeeded: ["logic", "tests"],
      }),
    ).toBe("**Coverage:** logic · tests — _security, performance specialists unavailable_")
  })

  it("renders the count-only summary when 3+ roles are missing (caller may swap to <details>)", () => {
    expect(renderCoverageLine(THREE_MISSING)).toBe("**Coverage:** logic — _3 specialists unavailable_")
  })

  it("falls back to `_none_` when zero succeeded but dispatched > 0", () => {
    expect(
      renderCoverageLine({
        dispatched: ["logic", "security"],
        succeeded: [],
      }),
    ).toBe("**Coverage:** _none_ — _logic, security specialists unavailable_")
  })
})

// ─── renderDeltaBadge ─────────────────────────────────────────────────

describe("renderDeltaBadge (ARC-281)", () => {
  it("returns null when every count is zero", () => {
    expect(
      renderDeltaBadge({
        newCount: 0,
        stillOpenCount: 0,
        likelyFixedCount: 0,
        carriedOverCount: 0,
      }),
    ).toBeNull()
  })

  it("formats the four parts in order: new · still-open · likely-fixed · carried-over", () => {
    expect(
      renderDeltaBadge({
        newCount: 2,
        stillOpenCount: 1,
        likelyFixedCount: 3,
        carriedOverCount: 1,
      }),
    ).toBe("**Changes:** +2 new · 1 still-open · 3 likely-fixed · 1 carried-over")
  })

  it("skips zero parts cleanly", () => {
    expect(
      renderDeltaBadge({
        newCount: 2,
        stillOpenCount: 0,
        likelyFixedCount: 3,
        carriedOverCount: 0,
      }),
    ).toBe("**Changes:** +2 new · 3 likely-fixed")
  })

  it("renders only-fixed and only-new variants", () => {
    expect(
      renderDeltaBadge({
        newCount: 0,
        stillOpenCount: 0,
        likelyFixedCount: 4,
        carriedOverCount: 0,
      }),
    ).toBe("**Changes:** 4 likely-fixed")
    expect(
      renderDeltaBadge({
        newCount: 3,
        stillOpenCount: 0,
        likelyFixedCount: 0,
        carriedOverCount: 0,
      }),
    ).toBe("**Changes:** +3 new")
  })

  it("does NOT emit the Δ triangle glyph (rebrand 2026-05-23)", () => {
    const out = renderDeltaBadge({
      newCount: 2,
      stillOpenCount: 1,
      likelyFixedCount: 3,
      carriedOverCount: 1,
    })
    expect(out).not.toContain("Δ")
    expect(out).toContain("Changes")
  })
})

// ─── renderStackParenthetical ─────────────────────────────────────────

describe("renderStackParenthetical (ARC-281)", () => {
  it("returns null when unstacked", () => {
    expect(renderStackParenthetical(stack(null))).toBeNull()
  })

  it("returns null when undefined", () => {
    expect(renderStackParenthetical(undefined)).toBeNull()
  })

  it("renders `_(Stacked on #N)_` when isStacked with parent", () => {
    expect(renderStackParenthetical(stack(87))).toBe("_(Stacked on #87)_")
  })
})

// ─── renderApproveBody ────────────────────────────────────────────────

describe("renderApproveBody (ARC-293 / SIG-94)", () => {
  it("Variant A — APPROVE, full coverage = marker only", () => {
    // ARC-293 + SIG-94: APPROVE bodies are MARKER-ONLY on every
    // APPROVE. GitHub's native "approved these changes" line carries
    // all the signal; the prior heading + coverage + 'No issues found'
    // + provenance footer was timeline noise.
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("Variant B — APPROVE, degraded coverage is ALSO marker only (SIG-94)", () => {
    // SIG-94: the "Approved on partial coverage." compromise line that
    // survived SIG-87 is gone. Degraded coverage no longer surfaces on
    // the PR body — operators still see it via the
    // `ensemble-specialists-degraded` log event.
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: ONE_MISSING,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("Variant C — APPROVE without coverage args (back-compat) = marker only", () => {
    const body = renderApproveBody({ verdict: verdict() })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("APPROVE body never carries the dismissal hint (nothing to dismiss)", () => {
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: FULL,
    })
    expect(body).not.toContain("To dismiss this review")
    expect(body).not.toContain("@sigilix dismiss")
  })

  it("APPROVE body never carries emoji (cross-renderer consistency)", () => {
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: ONE_MISSING,
    })
    // CR-quote-free check: no Unicode emoji from the BMP supplementary
    // ranges or common control symbols Sigilix shipped pre-redesign.
    expect(body).not.toMatch(/✅|🎉|🤖|🪄/)
  })

  it("APPROVE body bypasses the provenance footer (ARC-293)", () => {
    // capForGitHub appends `_Reviewed against...` unconditionally —
    // the new renderer skips it. GitHub's commit attribution on the
    // approve event ("approved these changes via <commit>") carries
    // the SHA signal already.
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).not.toContain("_Reviewed against")
  })

  it("APPROVE with an out-of-PR finding → reconciliation line + collapsed out-of-diff dropdown (SIG-471 PR-3)", () => {
    const clean = renderApproveBody({
      verdict: verdict({ findings: [] }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(clean).toBe("<!-- sigilix:pr-review -->\n")

    const withNote = renderApproveBody({
      verdict: verdict({
        findings: [finding({ score: 5, outOfPrScope: true, headline: "SQLi in unrelated module" })],
      }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(withNote).toContain("**Approved**")
    expect(withNote).toContain("1 note about code outside this PR")
    expect(withNote).toContain("<details>")
    expect(withNote).not.toContain("<details open")
    expect(withNote).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(withNote).toContain("out-of-diff")
    expect(withNote).toContain("SQLi in unrelated module")
  })
})

// ─── renderRequestChangesBody ─────────────────────────────────────────

describe("renderRequestChangesBody (SIG-471 PR-3 minimal body)", () => {
  it("all-inline findings → the body is JUST the marker (the inline comments speak for themselves)", () => {
    // SIG-471 PR-3: the lead counts, summary, Fix Plan, coverage, Trust/Proof,
    // and the <sub> Dismiss/Re-run footer are GONE from the body. When every
    // finding anchors inline, the body is the bare marker — nothing else.
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5, headline: "broken test" })] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("multiple inline findings still render as the bare marker (no lead/summary/Fix Plan)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 }), finding({ line: 99, score: 4 })] }),
      coverage: FULL,
      delta: { newCount: 2, stillOpenCount: 0, likelyFixedCount: 3, carriedOverCount: 0 },
      stack: stack(87),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
    // None of the cut chrome appears anywhere.
    expect(body).not.toContain("high-severity")
    expect(body).not.toContain("Fix Plan")
    expect(body).not.toContain("coverage:")
    expect(body).not.toContain("since last review")
    expect(body).not.toContain("Stacked on")
    expect(body).not.toContain("The PR adds a feature flag")
    expect(body).not.toContain("<sub>")
    expect(body).not.toContain("@sigilix dismiss")
    expect(body).not.toContain("Re-run")
  })

  it("out-of-PR-scope finding → marker + collapsed dropdown row (scope `out-of-diff`), no Fix Plan", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({
        findings: [
          finding({ score: 5, headline: "real in-PR blocker" }), // in-scope, inline → no body row
          finding({
            score: 5,
            scope: "file",
            outOfPrScope: true,
            headline: "issue in another file",
            body: "Not in this PR.",
          }),
        ],
      }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // The inline blocker is NOT echoed in the body (it posts as an inline comment).
    expect(body).not.toContain("real in-PR blocker")
    // The dropdown is the ONLY content besides the marker.
    expect(body).toContain("<details>")
    expect(body).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(body).toContain("| File | Scope | Finding |")
    expect(body).toContain("out-of-diff")
    expect(body).toContain("issue in another file")
    // No legacy chrome.
    expect(body).not.toContain("Fix Plan")
    expect(body).not.toContain("high-severity")
  })

  it("file-scope (body-only) finding → marker + dropdown row with scope `file-scope`", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({
        findings: [finding({ scope: "file", score: 5, headline: "file-level blocker", body: "needs attention" })],
      }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(body).toContain("| File | Scope | Finding |")
    expect(body).toContain("file-scope")
    expect(body).toContain("file-level blocker")
    expect(body).not.toContain("out-of-diff")
  })

  it("SIG-471 PR-3: ALL body-only AND out-of-diff findings appear in the ONE dropdown (recall-safety)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({
        findings: [
          finding({ scope: "file", score: 3, headline: "file-level note" }),
          finding({
            scope: "file",
            score: 5,
            outOfPrScope: true,
            headline: "issue in untouched file",
            body: "Not in this PR.",
          }),
        ],
      }),
      unanchored: [finding({ path: "src/bar.ts", line: 99, score: 3, headline: "no reviewable line" })],
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // One dropdown, three rows — none dropped.
    expect(body.match(/<details>/g) ?? []).toHaveLength(1)
    expect(body).toContain("<summary><b>3 findings outside the diff</b></summary>")
    expect(body).toContain("file-level note")
    expect(body).toContain("issue in untouched file")
    expect(body).toContain("no reviewable line")
    // file-scope and out-of-diff both labeled.
    expect(body).toContain("file-scope")
    expect(body).toContain("out-of-diff")
  })

  it("policy-blocker REQUEST_CHANGES (zero inline AND zero body findings) → marker + one sentence", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("<!-- sigilix:pr-review -->")
    expect(body).toContain(
      "This review was submitted as **Request changes** due to a repository policy blocker. " +
        "No automated findings were generated.",
    )
    // No dropdown, no chrome.
    expect(body).not.toContain("<details>")
    expect(body).not.toContain("Fix Plan")
  })

  it("Phase 3: an oversized dropdown sheds the tail under the 65k cap (defense-in-depth, no footer)", () => {
    // The dropdown renders each finding's HEADLINE (the long `body` field is no longer
    // echoed), so make the HEADLINES long: 30 × ~3000 chars ≈ 90k raw forces the 65k
    // cap to actually fire and shed the tail. (These are score-2 NON-blockers, so
    // shedding the tail is recall-safe — blockers are never the droppable tail.)
    const huge = Array.from({ length: 30 }, (_, i) =>
      finding({
        score: 2,
        category: "logic",
        scope: "file",
        path: `src/mod${i}.ts`,
        headline: `nit ${i} ` + "x".repeat(3000),
      }),
    )
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: huge }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // The cap genuinely fired (raw would be ~90k): body stays under the limit, the
    // marker survives, and the oversized dropdown is shed (collapsed to a count note,
    // so no individual nit row — incl. the tail `nit 29` — is rendered).
    expect(body.length).toBeLessThanOrEqual(65000)
    expect(body).toContain("<!-- sigilix:pr-review -->")
    expect(body).not.toContain("nit 29")
  })

  it("the body never carries the relocated footer (Dismiss/Re-run/Review#/SHA live in the overview now)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      reviewCounter: 3,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).not.toContain("<sub>")
    expect(body).not.toContain("@sigilix dismiss")
    expect(body).not.toContain("Re-run")
    expect(body).not.toContain("Review #3")
    expect(body).not.toContain("`abcdef1`")
  })

  it("Marker is line 1 and there's no leading whitespace (cross-renderer invisibility)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
    })
    expect(body.startsWith("<!-- sigilix:pr-review -->\n")).toBe(true)
    expect(body).not.toMatch(/^\s+<!--/)
  })

  it("the un-reviewed disclosure (recall-safety) survives the gutting, rendered under the marker", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ oversized: ["src/huge.ts"], reviewedCount: 1, totalChangedCount: 1 }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain(
      "> 📄 `src/huge.ts` was not reviewed — its diff is too large to analyze inline in this review.",
    )
  })
})

// ─── SIG-414 Phase 1.2: honest 3-way un-reviewed disclosure ───────────

function disclosure(overrides: Partial<ReviewDisclosure> = {}): ReviewDisclosure {
  return {
    policySkipped: [],
    oversized: [],
    spillover: [],
    reviewedCount: 0,
    totalChangedCount: 0,
    ...overrides,
  }
}

describe("renderReviewDisclosure (SIG-414 Phase 1.2) — three distinct cases", () => {
  it("POLICY: calm collapsed <details>, no ⚠️, the verbatim copy + the file list", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5, headline: "blocker" })] }),
      coverage: FULL,
      disclosure: disclosure({
        policySkipped: ["package-lock.json", "dist/app.min.js"],
        reviewedCount: 3,
        totalChangedCount: 3,
      }),
    })
    expect(body).toContain(
      "📋 2 files skipped — lockfiles, generated, vendored, minified, or binary files aren't reviewed by default.",
    )
    expect(body).toContain("<details>")
    expect(body).toContain("</details>")
    expect(body).toContain("`package-lock.json`")
    expect(body).toContain("`dist/app.min.js`")
    // Policy is "not applicable", not a coverage gap — never alarming.
    expect(body).not.toContain("⚠️")
  })

  it("POLICY: singular phrasing for one file", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ policySkipped: ["yarn.lock"], reviewedCount: 1, totalChangedCount: 1 }),
    })
    expect(body).toContain(
      "📋 1 file skipped — lockfiles, generated, vendored, minified, or binary files aren't reviewed by default.",
    )
  })

  it("OVERSIZED: one calm blockquote per too-large file, verbatim copy, no ⚠️", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({
        oversized: ["src/huge.ts", "src/also-huge.ts"],
        reviewedCount: 2,
        totalChangedCount: 2,
      }),
    })
    expect(body).toContain(
      "> 📄 `src/huge.ts` was not reviewed — its diff is too large to analyze inline in this review.",
    )
    expect(body).toContain(
      "> 📄 `src/also-huge.ts` was not reviewed — its diff is too large to analyze inline in this review.",
    )
    expect(body).not.toContain("⚠️")
  })

  it("SPILLOVER: reconciled n-of-m copy where remaining == m − n; plural", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ spillover: ["src/a.ts", "src/b.ts"], reviewedCount: 3, totalChangedCount: 5 }),
    })
    expect(body).toContain(
      "> 📊 Reviewed 3 of 5 changed files — the remaining 2 were below the priority cutoff for this very large PR. Split into smaller PRs to cover them.",
    )
  })

  it("SPILLOVER: singular phrasing for one remaining file (m − n == 1)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ spillover: ["src/a.ts"], reviewedCount: 4, totalChangedCount: 5 }),
    })
    expect(body).toContain("the remaining 1 was below the priority cutoff")
  })

  it("SPILLOVER: cumulative incremental coverage copy", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({
        spillover: ["src/deferred.ts"],
        reviewedCount: 4,
        totalChangedCount: 5,
        scope: "cumulative",
      }),
    })
    expect(body).toContain("Reviewed 4 of 5 changed files across this PR so far")
  })

  it("ALL THREE render together, each independent (a PR can hit every case)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({
        policySkipped: ["package-lock.json"],
        oversized: ["src/huge.ts"],
        spillover: ["src/a.ts"],
        reviewedCount: 2,
        totalChangedCount: 3,
      }),
    })
    expect(body).toContain("📋 1 file skipped")
    expect(body).toContain("📄 `src/huge.ts` was not reviewed")
    expect(body).toContain("📊 Reviewed 2 of 3 changed files")
    // Render order (Codex): oversized, spillover, then policy last.
    expect(body.indexOf("📄 `src/huge.ts`")).toBeLessThan(body.indexOf("📊 Reviewed"))
    expect(body.indexOf("📊 Reviewed")).toBeLessThan(body.indexOf("📋 1 file skipped"))
  })

  it("renders the same on the COMMENT posture (oversized/spillover downgrade to COMMENT)", () => {
    const body = renderCommentBody({
      verdict: verdict({ findings: [] }),
      coverage: FULL,
      disclosure: disclosure({ oversized: ["src/huge.ts"], reviewedCount: 1, totalChangedCount: 1 }),
    })
    expect(body).toContain("📄 `src/huge.ts` was not reviewed")
  })

  it("the legacy lumped 'size budget' / 'not analyzed' framing is gone (SIG-411 consistency)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5 })] }),
      coverage: FULL,
      disclosure: disclosure({ spillover: ["src/a.ts"], reviewedCount: 1, totalChangedCount: 2 }),
    })
    expect(body).not.toContain("size budget")
    expect(body).not.toContain("not analyzed")
  })
})

describe("renderApproveBody disclosure exception (SIG-414 Phase 1.2)", () => {
  it("a POLICY-only skip surfaces on the APPROVE body (must NOT downgrade, but stay visible)", () => {
    const body = renderApproveBody({
      verdict: verdict({ findings: [] }),
      disclosure: disclosure({ policySkipped: ["package-lock.json"], reviewedCount: 3, totalChangedCount: 3 }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("**Approved**")
    expect(body).toContain(
      "📋 1 file skipped — lockfiles, generated, vendored, minified, or binary files aren't reviewed by default.",
    )
    expect(body).toContain("`package-lock.json`")
    expect(body).not.toContain("⚠️")
  })

  it("a clean APPROVE with NO disclosure stays marker-only (byte-identical to pre-SIG-414)", () => {
    const body = renderApproveBody({
      verdict: verdict({ findings: [] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("an APPROVE with an empty disclosure object (all sets empty) stays marker-only", () => {
    const body = renderApproveBody({
      verdict: verdict({ findings: [] }),
      disclosure: disclosure(),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("the APPROVE policy note coexists with the non-inline dropdown", () => {
    const body = renderApproveBody({
      verdict: verdict({ findings: [] }),
      unanchored: [
        finding({ score: 5, scope: "file", outOfPrScope: true, headline: "issue elsewhere", body: "not in this PR" }),
      ],
      disclosure: disclosure({ policySkipped: ["package-lock.json"], reviewedCount: 2, totalChangedCount: 2 }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("note") // out-of-scope reconciliation line
    // SIG-471 PR-3: the out-of-PR finding renders in the collapsed dropdown table.
    expect(body).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(body).toContain("out-of-diff")
    expect(body).toContain("issue elsewhere")
    expect(body).toContain("📋 1 file skipped")
  })
})
