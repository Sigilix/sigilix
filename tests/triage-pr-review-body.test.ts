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
  renderCoverageLine,
  renderDeltaBadge,
  renderStackParenthetical,
  type PrReviewVerdict,
  type PrReviewFinding,
  type CoverageRoles,
  type DeltaBadgeCounts,
} from "../src/lib/triage-pr-review"
import type { StackContext, StackPr } from "../src/lib/pr-stack"

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
  const parent: StackPr | null = parentNumber === null
    ? null
    : {
        number: parentNumber,
        title: `PR #${parentNumber}`,
        headSha: "1234567",
        baseSha: "0000000",
        baseRef: "main",
        headRef: `feature-${parentNumber}`,
        author: "alice",
        state: "open" as const,
        isDraft: false,
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
  }
}

// ─── renderCoverageLine ───────────────────────────────────────────────

describe("renderCoverageLine (ARC-281)", () => {
  it("returns null when nothing was dispatched", () => {
    expect(renderCoverageLine({ dispatched: [], succeeded: [] })).toBeNull()
  })

  it("renders the full coverage line when succeeded == dispatched", () => {
    expect(renderCoverageLine(FULL)).toBe(
      "**Coverage:** logic · security · performance · tests",
    )
  })

  it("renders the inline degraded line when 1 role is missing", () => {
    expect(renderCoverageLine(ONE_MISSING)).toBe(
      "**Coverage:** logic · security · tests — _performance specialist unavailable_",
    )
  })

  it("renders the inline degraded line when 2 roles are missing", () => {
    expect(renderCoverageLine({
      dispatched: ["logic", "security", "performance", "tests"],
      succeeded: ["logic", "tests"],
    })).toBe(
      "**Coverage:** logic · tests — _security, performance specialists unavailable_",
    )
  })

  it("renders the count-only summary when 3+ roles are missing (caller may swap to <details>)", () => {
    expect(renderCoverageLine(THREE_MISSING)).toBe(
      "**Coverage:** logic — _3 specialists unavailable_",
    )
  })

  it("falls back to `_none_` when zero succeeded but dispatched > 0", () => {
    expect(renderCoverageLine({
      dispatched: ["logic", "security"],
      succeeded: [],
    })).toBe(
      "**Coverage:** _none_ — _logic, security specialists unavailable_",
    )
  })
})

// ─── renderDeltaBadge ─────────────────────────────────────────────────

describe("renderDeltaBadge (ARC-281)", () => {
  it("returns null when every count is zero", () => {
    expect(renderDeltaBadge({
      newCount: 0, stillOpenCount: 0, likelyFixedCount: 0, carriedOverCount: 0,
    })).toBeNull()
  })

  it("formats the four parts in order: new · still-open · likely-fixed · carried-over", () => {
    expect(renderDeltaBadge({
      newCount: 2, stillOpenCount: 1, likelyFixedCount: 3, carriedOverCount: 1,
    })).toBe("**Δ:** +2 new · 1 still-open · 3 likely-fixed · 1 carried-over")
  })

  it("skips zero parts cleanly", () => {
    expect(renderDeltaBadge({
      newCount: 2, stillOpenCount: 0, likelyFixedCount: 3, carriedOverCount: 0,
    })).toBe("**Δ:** +2 new · 3 likely-fixed")
  })

  it("renders only-fixed and only-new variants", () => {
    expect(renderDeltaBadge({
      newCount: 0, stillOpenCount: 0, likelyFixedCount: 4, carriedOverCount: 0,
    })).toBe("**Δ:** 4 likely-fixed")
    expect(renderDeltaBadge({
      newCount: 3, stillOpenCount: 0, likelyFixedCount: 0, carriedOverCount: 0,
    })).toBe("**Δ:** +3 new")
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

describe("renderApproveBody (ARC-281)", () => {
  it("Variant A — APPROVE, full coverage", () => {
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe([
      "<!-- openclaw:pr-review -->",
      "",
      "## Sigilix: Approved",
      "",
      "**Coverage:** logic · security · performance · tests",
      "",
      "No issues found.",
      "",
      "_Reviewed against `abcdef1` at 2025-05-18T05:48:38.000Z._",
      "",
    ].join("\n"))
  })

  it("Variant B — APPROVE, degraded coverage uses 'in covered areas'", () => {
    const body = renderApproveBody({
      verdict: verdict(),
      coverage: ONE_MISSING,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("**Coverage:** logic · security · tests — _performance specialist unavailable_")
    expect(body).toContain("No issues found in covered areas.")
    expect(body).not.toContain("No issues found.\n") // no plain variant
  })

  it("Variant C — APPROVE without coverage args (back-compat) omits the line entirely", () => {
    const body = renderApproveBody({ verdict: verdict() })
    expect(body).not.toMatch(/^\*\*Coverage:/m)
    expect(body).toContain("No issues found.")
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
      coverage: FULL,
    })
    // CR-quote-free check: no Unicode emoji from the BMP supplementary
    // ranges or common control symbols Sigilix shipped pre-redesign.
    // We are NOT trying to be exhaustive — just guard the specific
    // emoji Kimi explicitly told us to drop.
    expect(body).not.toMatch(/✅|🎉|🤖|🪄/)
  })
})

// ─── renderRequestChangesBody ─────────────────────────────────────────

describe("renderRequestChangesBody (ARC-281)", () => {
  it("Variant D — REQUEST_CHANGES, fresh review with one anchored finding (full coverage)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 5, headline: "broken test" })] }),
      coverage: FULL,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toBe([
      "<!-- openclaw:pr-review -->",
      "",
      "## Sigilix: 1 finding",
      "",
      "**Coverage:** logic · security · performance · tests",
      "",
      "The PR adds a feature flag and a test.",
      "",
      "### Fix Plan",
      "",
      "**Critical (score 5)** — 1 finding",
      "- `src/foo.ts:42` — `logic`: broken test",
      "",
      "To dismiss this review, push new commits or comment `@sigilix dismiss` in a review thread.",
      "",
      "_Reviewed against `abcdef1` at 2025-05-18T05:48:38.000Z._",
      "",
    ].join("\n"))
  })

  it("Variant E — REQUEST_CHANGES with delta badge appends ` · Δ since last review` to heading", () => {
    const delta: DeltaBadgeCounts = {
      newCount: 2, stillOpenCount: 0, likelyFixedCount: 3, carriedOverCount: 0,
    }
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding({ score: 4 }), finding({ line: 99, score: 4 })] }),
      coverage: FULL,
      delta,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toMatch(/^## Sigilix: 2 findings · Δ since last review$/m)
    expect(body).toContain("**Δ:** +2 new · 3 likely-fixed")
    // Badge line MUST appear before the coverage line per Kimi's spec.
    const deltaIdx = body.indexOf("**Δ:**")
    const coverageIdx = body.indexOf("**Coverage:**")
    expect(deltaIdx).toBeGreaterThan(-1)
    expect(coverageIdx).toBeGreaterThan(deltaIdx)
  })

  it("Variant F — REQUEST_CHANGES with degraded coverage shows the inline form", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: ONE_MISSING,
      prov: { headSha: HEAD, nowMs: NOW },
    })
    expect(body).toContain("**Coverage:** logic · security · tests — _performance specialist unavailable_")
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

  it("Variant H — REQUEST_CHANGES with unanchored findings groups them under '### Additional findings'", () => {
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
    expect(body).toContain("### Additional findings (could not anchor to diff)")
    expect(body).toContain("**src/bar.ts**")
    expect(body).toContain("could not anchor")
    // Heading count includes both.
    expect(body).toMatch(/^## Sigilix: 2 findings/m)
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
    expect(body).toContain("To dismiss this review, push new commits or comment `@sigilix dismiss` in a review thread.")
    expect(body).not.toMatch(/✅|🎉|🤖|🪄/)
  })

  it("REQUEST_CHANGES heading uses singular 'finding' for N=1 and plural for N=2+", () => {
    const oneFinding = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
    })
    expect(oneFinding).toMatch(/^## Sigilix: 1 finding$/m)
    const manyFindings = renderRequestChangesBody({
      verdict: verdict({ findings: [finding(), finding({ line: 99 })] }),
      coverage: FULL,
    })
    expect(manyFindings).toMatch(/^## Sigilix: 2 findings$/m)
  })

  it("Marker is line 1 and there's no leading whitespace (cross-renderer invisibility)", () => {
    const body = renderRequestChangesBody({
      verdict: verdict({ findings: [finding()] }),
      coverage: FULL,
    })
    expect(body.startsWith("<!-- openclaw:pr-review -->\n")).toBe(true)
    expect(body).not.toMatch(/^\s+<!--/)
  })
})
