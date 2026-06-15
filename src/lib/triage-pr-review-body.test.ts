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
  type DeltaBadgeCounts,
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
})

// ─── renderRequestChangesBody ─────────────────────────────────────────

describe("renderRequestChangesBody (ARC-281)", () => {
  it("Variant D — REQUEST_CHANGES, fresh review with one anchored finding (full coverage)", () => {
    // SIG (Kimi K2.6 r1 2026-05-27): compact redesign. Was H2 heading
    // + H3 Fix Plan + bullet + 4 separate footer lines (10+ lines of
    // chrome around 1 finding); now lead line + table + single footer.
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5, headline: "broken test" })] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe(
      [
        "<!-- sigilix:pr-review -->",
        "",
        "**1 high-severity finding** · coverage: logic · security · performance · tests",
        "",
        "The PR adds a feature flag and a test.",
        "",
        "| Severity | Location | Issue |",
        "|:---|:---|:---|",
        "| **Critical (5)** | `src/foo.ts:42` | `logic`: broken test |",
        "",
        "<sub>Dismiss: `@sigilix dismiss <reason>` in thread (not-a-bug|bad-anchor|already-covered|too-minor|wrong-context) · Re-run: `/sigilix review` · `abcdef1`</sub>",
      ].join("\n"),
    )
  })

  it("out-of-PR-scope: renders inside the single non-inline dropdown, NOT the Fix Plan; lead counts only in-scope", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({
        findings: [
          finding({ score: 5, headline: "real in-PR blocker" }), // in-scope, inline
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
    expect(body).toContain("real in-PR blocker") // Fix Plan
    expect(body).not.toContain("### Outside your changes")
    expect(body).toContain("Outside this PR's changes")
    expect(body).toContain("issue in another file")
    expect(body).toContain("Shown for awareness; these don't block the merge")
    // the lead counts ONLY the in-scope blocker (1), not the out-of-scope finding
    expect(body).toContain("**1 high-severity finding**")
    // the out-of-scope P1 is NOT in the Fix Plan table (no second Critical row)
    expect(body).not.toMatch(/Critical \(5\)[^|]*issue in another file/)
  })

  it("renderApproveBody: marker-only on a clean approve; posts the non-inline dropdown + reconciliation when out-of-scope findings exist", () => {
    const clean = renderApproveBody({
      verdict: verdict({ findings: [] }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(clean).not.toContain("Outside your changes")

    const withNote = renderApproveBody({
      verdict: verdict({
        findings: [finding({ score: 5, outOfPrScope: true, headline: "SQLi in unrelated module" })],
      }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(withNote).toContain("**Approved**")
    expect(withNote).toContain("1 note about code outside this PR")
    expect(withNote).not.toContain("### Outside your changes")
    expect(withNote).toContain("Outside this PR's changes")
    expect(withNote).toContain("SQLi in unrelated module")
  })

  it("outside-this-PR findings collapse into the single default-collapsed non-inline dropdown", () => {
    const body = renderApproveBody({
      verdict: verdict({
        findings: [finding({ score: 5, outOfPrScope: true, headline: "SQLi in unrelated module" })],
      }),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // Collapsed dropdown so a long list doesn't eat the review body.
    expect(body).toContain("<details>")
    expect(body).toContain("</details>")
    expect(body).not.toContain("<details open") // default collapsed
    // Summary states scope + count so a reader who never expands still understands.
    expect(body).toContain("<summary>")
    expect(body).toContain("1 finding that couldn't be anchored to a line")
    expect(body).toContain("Outside this PR's changes")
    expect(body).toContain("Shown for awareness; these don't block the merge")
    // The finding itself lives inside the dropdown.
    expect(body).toContain("SQLi in unrelated module")
  })

  it("SIG-440: all non-inline findings share one dropdown and the Review Body Findings heading is gone", () => {
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

    expect(body).not.toContain("### Review Body Findings")
    expect(body).not.toContain("### Outside your changes")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).toContain("Outside this PR's changes")
    expect(body).toContain("file-level note")
    expect(body).toContain("issue in untouched file")
    expect(body).toContain("no reviewable line")
    expect(body.match(/<details>/g) ?? []).toHaveLength(1)
  })

  it("Phase 3 (#333): an oversized body sheds the low-severity tail end-to-end, NEVER the security blocker (Sigilix #333)", () => {
    // A security blocker (score 5) + many huge low-severity body-only findings
    // that push the body past GitHub's 65,535-char limit. The end-to-end render
    // (headLineCount snapshot → slice → capForGitHubPrioritized) must keep the
    // blocker + drop the low-sev tail with a counted marker.
    const blocker = finding({
      score: 5,
      category: "security",
      headline: "CRITICAL_SQL_INJECTION_BLOCKER",
      path: "src/auth.ts",
      line: 7,
    })
    const huge = Array.from({ length: 12 }, (_, i) =>
      finding({
        score: 2,
        category: "logic",
        scope: "file",
        path: `src/mod${i}.ts`,
        headline: `low-sev nit ${i}`,
        body: `UNIQUE_NONBLOCKER_MARKER_${i} ` + "x".repeat(6000),
      }),
    )
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [blocker, ...huge] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // fits GitHub's limit...
    expect(body.length).toBeLessThanOrEqual(65000)
    // ...the security blocker's Fix Plan row SURVIVES...
    expect(body).toContain("CRITICAL_SQL_INJECTION_BLOCKER")
    // ...the SHA-bearing footer survives...
    expect(body).toContain("`abcdef1`")
    // ...the low-sev tail is shed with an honest counted marker...
    expect(body).toContain("non-inline findings omitted to meet GitHub's 65,535-character limit")
    expect(body).toContain("every blocker is shown above")
    // ...and the dropped findings' bodies are actually gone.
    expect(body).not.toContain("UNIQUE_NONBLOCKER_MARKER_11")
  })

  it("Variant E — REQUEST_CHANGES with delta badge appends ` · since last review` to heading", () => {
    const delta: DeltaBadgeCounts = {
      newCount: 2,
      stillOpenCount: 0,
      likelyFixedCount: 3,
      carriedOverCount: 0,
    }
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 4 }), finding({ line: 99, score: 4 })] }),
      coverage: FULL,
      delta,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // SIG Kimi r1: lead line carries "**2 high-severity findings**"
    // + inlined delta + coverage on a single line. The previous
    // 3-line block (H2 heading + Changes badge + Coverage line)
    // collapses into one line with `·` separators.
    expect(body).toMatch(/^\*\*2 high-severity findings\*\*/m)
    expect(body).toContain("since last review: +2 new · 3 likely-fixed")
    // Body MUST NOT carry the Δ triangle glyph (2026-05-23 rebrand).
    expect(body).not.toContain("Δ")
    // Delta MUST appear before coverage on the lead line.
    const deltaIdx = body.indexOf("since last review:")
    const coverageIdx = body.indexOf("coverage:")
    expect(deltaIdx).toBeGreaterThan(-1)
    expect(coverageIdx).toBeGreaterThan(deltaIdx)
  })

  it("Variant F — REQUEST_CHANGES with degraded coverage shows the inline form", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: ONE_MISSING,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("coverage: logic · security · tests — _performance specialist unavailable_")
  })

  it("Variant G — REQUEST_CHANGES stacked appends `_(Stacked on #N)_` to the summary paragraph", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
      stack: stack(87),
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // The stack parenthetical attaches to the summary line directly,
    // not to a separate line — that's the compressed form Kimi asked
    // for over the multi-line block.
    expect(body).toContain("The PR adds a feature flag and a test. _(Stacked on #87)_")
    // Old `### Stack context` header must not appear anywhere.
    expect(body).not.toContain("Stack context")
  })

  it("Variant H — REQUEST_CHANGES with unanchored findings renders body-only findings", () => {
    const anchored = finding({ score: 5 })
    const unanchored = finding({
      path: "src/bar.ts",
      line: 99,
      headline: "could not anchor",
      score: 3,
    })
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [anchored] }),
      unanchored: [unanchored],
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).not.toContain("### Review Body Findings")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body.match(/<details>/g) ?? []).toHaveLength(1)
    expect(body).toContain("`src/bar.ts:99`")
    expect(body).not.toContain("**src/bar.ts**")
    expect(body).toContain("could not anchor")
    // SIG Kimi r1 + CR Major fold: lead line says "**1 high-severity
    // finding**" — the anchored critical goes in the Fix Plan table,
    // the unanchored P2 (score < 4) lives in the body-only section
    // below. No "+ 1 body" suffix because the body-only section is
    // its own surface; only LOWER-severity inline findings get a
    // dedicated lead clause ("+ M lower-severity inline").
    expect(body).toMatch(/^\*\*1 high-severity finding\*\*/m)
    expect(body).not.toMatch(/\+ \d+ body/)
  })

  it("SIG-440 — body-only blockers surface in the Fix Plan table + the single non-inline dropdown", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 2, headline: "minor inline note" })] }),
      unanchored: [
        finding({
          path: "src/bar.ts",
          line: 99,
          headline: "body-only blocker",
          score: 5,
        }),
      ],
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // No legacy "### Fix Plan" H3 heading (it's a table now).
    expect(body).not.toContain("### Fix Plan")
    // SIG-440: the score-5 body-only blocker lives in the Fix Plan table for
    // prominence, with detail in the same dropdown as every other non-inline finding.
    expect(body).toContain("| Severity | Location | Issue |")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).not.toContain("### Review Body Findings")
    // SIG-216: meta tightened to `\`src/bar.ts:99\` · score 5`.
    expect(body).toContain("**`src/bar.ts:99`**:")
    expect(body).toContain("score 5")
    expect(body).not.toContain("(critical, score 5)")
    expect(body).toContain("body-only blocker")
  })

  it("CR Major (PR #200) — lead-line counts body-only high-severity findings", () => {
    // Pre-fix: the lead line only counted inlineFindings, so an
    // unanchored CRITICAL finding rendered as "**1 finding**"
    // instead of "**1 high-severity finding**", weakening the
    // prioritization signal in the compact summary. Fix: include
    // bodyOnlyFindings with score>=4 in highOrCriticalCount.
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [] }),
      unanchored: [finding({ path: "src/bar.ts", line: 99, headline: "unanchored critical", score: 5 })],
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // High-severity tier copy must fire even though there are zero
    // inline findings — the unanchored critical IS the signal.
    expect(body).toMatch(/^\*\*1 high-severity finding\*\*/m)
    // SIG-440: the body-only critical now surfaces in the
    // Fix Plan table + single non-inline dropdown (no separate "+ 1 body"
    // clause in the lead — it's already counted in the high-severity tier).
    expect(body).toContain("| Severity | Location | Issue |")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).toContain("unanchored critical")
  })

  it("SIG-202/SIG-5 — direct renderer routes non-line findings out of Fix Plan", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({
        findings: [
          finding({
            path: "src/bar.ts",
            line: 99,
            headline: "pr-level blocker",
            score: 5,
            scope: "pr",
          }),
        ],
      }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    // SIG Kimi r1 + CR Major fold (PR #200): PR-scope critical
    // (score 5) routes to body-only. CR's fix made `highOrCriticalCount`
    // include body-only findings too, so the lead now reads
    // "**1 high-severity finding**" — the critical IS the signal.
    expect(body).toMatch(/^\*\*1 high-severity finding\*\*/m)
    expect(body).not.toContain("### Fix Plan")
    // SIG-440: pr-scope critical surfaces in the Fix Plan table and the
    // single non-inline dropdown, not the deleted body-findings section.
    expect(body).toContain("| Severity | Location | Issue |")
    expect(body).toContain("couldn't be anchored to a line")
    expect(body).not.toContain("### Review Body Findings")
    // SIG-216: pr-scope renders the bare path (no `:line`) + tightened
    // `<anchor> · score N` meta — no "PR-level (critical, ...)" prefix.
    // (The Fix Plan caption legitimately says "PR-level scope", so guard
    // the old per-finding "PR-level (" label format specifically.)
    expect(body).toContain("**`src/bar.ts`**:")
    expect(body).toContain("score 5")
    expect(body).not.toContain("PR-level (")
    expect(body).not.toContain("(critical, score 5)")
    expect(body).toContain("pr-level blocker")
  })

  it("Variant I — REQUEST_CHANGES omits Fix Plan when no findings are score >= 4", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 2 }), finding({ line: 99, score: 3 })] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).not.toContain("### Fix Plan")
  })

  it("REQUEST_CHANGES always carries the dismissal hint (and never an emoji)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
    })
    expect(body).toContain(
      "Dismiss: `@sigilix dismiss <reason>` in thread (not-a-bug|bad-anchor|already-covered|too-minor|wrong-context)",
    )
    expect(body).not.toMatch(/✅|🎉|🤖|🪄/)
  })

  it("REQUEST_CHANGES lead-line uses singular 'finding' for N=1 and plural for N=2+", () => {
    // SIG Kimi r1: high-severity count (score >= 4) drives singular/
    // plural copy on the lead line. Override default score (3) to 4
    // so the tier-aware "high-severity finding(s)" copy fires; the
    // singular/plural switch itself is the point of the test, not
    // which tier the default finding lands in.
    const oneFinding = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 4 })] }),
      coverage: FULL,
    })
    expect(oneFinding).toMatch(/^\*\*1 high-severity finding\*\*/m)
    const manyFindings = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 4 }), finding({ line: 99, score: 4 })] }),
      coverage: FULL,
    })
    expect(manyFindings).toMatch(/^\*\*2 high-severity findings\*\*/m)
  })

  it("Marker is line 1 and there's no leading whitespace (cross-renderer invisibility)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
    })
    expect(body.startsWith("<!-- sigilix:pr-review -->\n")).toBe(true)
    expect(body).not.toMatch(/^\s+<!--/)
  })

  // Founder-mandated invariant (2026-05-18): the verdict summary MUST
  // appear before the Fix Plan / body-only findings sections in every
  // body variant. A review that leads with the diff before saying what
  // the diff is about is the CodeRabbit failure mode the founder
  // explicitly called out — Sigilix must never replicate it. The
  // existing exact-match fixture at "Variant D" pins this for ONE
  // happy path; this block pins it across every variant combination.
  describe("summary-before-findings ordering invariant", () => {
    const SUMMARY_PARAGRAPH = "The PR adds a feature flag and a test."
    const FIX_PLAN_TABLE = "| Severity | Location | Issue |"
    const BODY_ONLY_SUMMARY = "couldn't be anchored to a line"

    function assertSummaryFirst(body: string, label: string): void {
      const summaryIdx = body.indexOf(SUMMARY_PARAGRAPH)
      expect(summaryIdx, `${label}: summary paragraph must appear in body`).toBeGreaterThan(-1)
      const fixPlanIdx = body.indexOf(FIX_PLAN_TABLE)
      if (fixPlanIdx !== -1) {
        expect(summaryIdx, `${label}: summary must precede Fix Plan`).toBeLessThan(fixPlanIdx)
      }
      const bodyOnlyIdx = body.indexOf(BODY_ONLY_SUMMARY)
      if (bodyOnlyIdx !== -1) {
        expect(summaryIdx, `${label}: summary must precede body-only findings`).toBeLessThan(bodyOnlyIdx)
      }
    }

    it("summary precedes Fix Plan on the minimal happy path", () => {
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 })] }),
        coverage: FULL,
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "minimal")
    })

    it("summary precedes Fix Plan with delta badge present", () => {
      const delta: DeltaBadgeCounts = {
        newCount: 2,
        stillOpenCount: 0,
        likelyFixedCount: 3,
        carriedOverCount: 0,
      }
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 }), finding({ line: 99, score: 4 })] }),
        coverage: FULL,
        delta,
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "with delta")
    })

    it("summary precedes Fix Plan with degraded coverage", () => {
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 })] }),
        coverage: ONE_MISSING,
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "degraded coverage")
    })

    it("summary (with stack parenthetical) precedes Fix Plan when stacked", () => {
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 })] }),
        coverage: FULL,
        stack: stack(87),
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "stacked")
      expect(body).toContain("_(Stacked on #87)_")
    })

    it("summary precedes BOTH Fix Plan AND body-only findings when unanchored present", () => {
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 })] }),
        unanchored: [finding({ path: "src/bar.ts", line: 99, score: 3 })],
        coverage: FULL,
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "with unanchored")
      // Fix Plan must also precede body-only findings — diff context
      // (anchored, severity-gated) remains the primary repair queue.
      expect(body.indexOf(FIX_PLAN_TABLE)).toBeLessThan(body.indexOf("couldn't be anchored to a line"))
    })

    it("summary precedes body-only findings even when Fix Plan is absent (low-severity only)", () => {
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 2 })] }),
        unanchored: [finding({ path: "src/bar.ts", line: 99, score: 3 })],
        coverage: FULL,
        prov: { headSha: HEAD, nowMs: NOW },
      })
      // Fix Plan header MUST be absent when no score >= 4 finding exists.
      expect(body).not.toContain(FIX_PLAN_TABLE)
      assertSummaryFirst(body, "low-severity only")
    })

    it("summary precedes Fix Plan with all four variants combined", () => {
      const delta: DeltaBadgeCounts = {
        newCount: 1,
        stillOpenCount: 1,
        likelyFixedCount: 0,
        carriedOverCount: 0,
      }
      const body = renderRequestChangesBody({
        verdict: verdict({ findings: [finding({ score: 5 })] }),
        unanchored: [finding({ path: "src/bar.ts", line: 99, score: 3 })],
        coverage: ONE_MISSING,
        delta,
        stack: stack(87),
        prov: { headSha: HEAD, nowMs: NOW },
      })
      assertSummaryFirst(body, "all variants")
    })
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
    expect(body).toContain("Outside this PR's changes")
    expect(body).not.toContain("### Outside your changes")
    expect(body).toContain("📋 1 file skipped")
  })
})
