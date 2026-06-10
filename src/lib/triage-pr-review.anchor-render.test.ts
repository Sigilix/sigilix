import { describe, expect, it } from "vitest"
import {
  buildFallbackBody,
  buildReviewSubmission,
  buildReviewSubmissionWithMetadata,
  formatFindingComment,
  isSubstantiveAnchorLine,
  pickAnchorLineForward,
  pickSubstantiveAnchorLineForward,
  renderFixPlan,
  severityBadgeForScore,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"
import { badgeAssetUrl, BADGE_ASSET_VERSION, PUBLIC_BADGE_BASE_URL } from "@/src/lib/badge-assets"
import { baseFinding } from "@/src/lib/triage-pr-review.test-helpers"

describe("pickAnchorLineForward (SIG-159 PR1)", () => {
  const lines = new Map<number, string>([
    [42, "  const idx = clampIndex(i)"],
    [100, "  return result"],
    [1370, "}"],
  ])

  it("fast path: returns requested line when it's already an added line", () => {
    expect(pickAnchorLineForward(lines, 42)).toBe(42)
    expect(pickAnchorLineForward(lines, 100)).toBe(100)
    expect(pickAnchorLineForward(lines, 1370)).toBe(1370)
  })

  it("walks forward to the smallest added line > requested", () => {
    expect(pickAnchorLineForward(lines, 30)).toBe(42)
    expect(pickAnchorLineForward(lines, 43)).toBe(100)
    expect(pickAnchorLineForward(lines, 500)).toBe(1370)
  })

  it("returns null when no added line exists at or after the requested line", () => {
    expect(pickAnchorLineForward(lines, 1371)).toBeNull()
    expect(pickAnchorLineForward(lines, 9999)).toBeNull()
  })

  it("returns null when the added-lines map for the path is undefined", () => {
    expect(pickAnchorLineForward(undefined, 42)).toBeNull()
  })

  it("returns null on an empty added-lines map", () => {
    expect(pickAnchorLineForward(new Map(), 42)).toBeNull()
  })
})

describe("pickSubstantiveAnchorLineForward (inline-more-in-diff)", () => {
  const lines = new Map<number, string>([
    [40, "}"], // non-substantive: a closing brace
    [41, "  "], // non-substantive: blank
    [42, "  const idx = clampIndex(i)"], // substantive
    [100, ");"], // non-substantive
    [101, "  return result"], // substantive
    [200, "}"], // trailing non-substantive only
  ])

  it("fast path: returns the requested line when it's a substantive added line", () => {
    expect(pickSubstantiveAnchorLineForward(lines, 42)).toBe(42)
    expect(pickSubstantiveAnchorLineForward(lines, 101)).toBe(101)
  })

  it("skips PAST a non-substantive anchor (brace/blank) to the nearest substantive added line", () => {
    // the model anchored at the `}` (40) / blank (41) above the real code
    expect(pickSubstantiveAnchorLineForward(lines, 40)).toBe(42)
    expect(pickSubstantiveAnchorLineForward(lines, 41)).toBe(42)
    expect(pickSubstantiveAnchorLineForward(lines, 100)).toBe(101)
  })

  it("respects the forward-distance cap: WITHIN the window anchors inline, BEYOND it falls back to body (null)", () => {
    // 101 is the nearest substantive line. From 80 it's 21 lines away (≤25 cap →
    // anchor inline); from 50 it's 51 lines away (>25 → don't mis-anchor across a
    // gap, route to the body).
    expect(pickSubstantiveAnchorLineForward(lines, 80)).toBe(101)
    expect(pickSubstantiveAnchorLineForward(lines, 50)).toBeNull()
  })

  it("returns null when only non-substantive added lines remain (→ body)", () => {
    expect(pickSubstantiveAnchorLineForward(lines, 102)).toBeNull() // only 200:`}` after
    expect(pickSubstantiveAnchorLineForward(lines, 200)).toBeNull()
  })

  it("returns null for an undefined / empty map", () => {
    expect(pickSubstantiveAnchorLineForward(undefined, 42)).toBeNull()
    expect(pickSubstantiveAnchorLineForward(new Map(), 42)).toBeNull()
  })

  it("range-bounded backward fallback: anchors WITHIN [startLine..line] when the bottom line has nothing substantive after it", () => {
    // Sigilix/runner #5 dogfood case: a finding citing a multi-line range whose
    // primary `line` (the range bottom, 185) lands on a trailing blank with no
    // substantive added line AFTER it — the forward walk demotes to body. With
    // the model's range start, anchor INLINE to the nearest substantive line
    // within the range (closest to the bottom) instead.
    const ranged = new Map<number, string>([
      [170, "  base_runs = base.get('runs')"], // substantive, in range
      [180, "  base['runs'] = base_runs"], // the asserted line, in range
      [183, "  f.write(out)"], // substantive, closest to the bottom
      [184, "  "], // blank
      [185, "  "], // blank — the model's primary `line`
    ])
    // forward-only (no range arg): demotes to body — unchanged behavior
    expect(pickSubstantiveAnchorLineForward(ranged, 185)).toBeNull()
    // range-aware: anchors to 183 (nearest substantive within [170..185])
    expect(pickSubstantiveAnchorLineForward(ranged, 185, 170)).toBe(183)
  })

  it("forward result always wins over the range fallback", () => {
    // 101 is substantive at/after the requested line → forward walk wins even
    // with a range start present; the backward fallback never runs.
    expect(pickSubstantiveAnchorLineForward(lines, 100, 40)).toBe(101)
    expect(pickSubstantiveAnchorLineForward(lines, 42, 40)).toBe(42)
  })

  it("range fallback never drifts BELOW startLine (no out-of-range anchor)", () => {
    const m = new Map<number, string>([
      [10, "  const real = compute()"], // substantive but BELOW the range
      [50, "  "], // blank — the requested bottom
    ])
    // startLine 45: nothing substantive in [45..50) → stays body (no drift to 10)
    expect(pickSubstantiveAnchorLineForward(m, 50, 45)).toBeNull()
    // startLine 5: line 10 is in [5..50) → anchors there
    expect(pickSubstantiveAnchorLineForward(m, 50, 5)).toBe(10)
  })
})

describe("isSubstantiveAnchorLine (SIG-127)", () => {
  it("treats a bare closing brace as non-substantive", () => {
    expect(isSubstantiveAnchorLine("}")).toBe(false)
  })

  it("treats a brace with surrounding whitespace as non-substantive", () => {
    expect(isSubstantiveAnchorLine("  } ")).toBe(false)
  })

  it("treats empty string as non-substantive", () => {
    expect(isSubstantiveAnchorLine("")).toBe(false)
  })

  it("treats undefined (line not in map / no map) as non-substantive", () => {
    expect(isSubstantiveAnchorLine(undefined)).toBe(false)
  })

  it("treats structural-punctuation-only lines as non-substantive", () => {
    expect(isSubstantiveAnchorLine("});")).toBe(false)
    expect(isSubstantiveAnchorLine("  ),")).toBe(false)
    expect(isSubstantiveAnchorLine("[")).toBe(false)
  })

  it("treats real code as substantive", () => {
    expect(isSubstantiveAnchorLine("const x = 1")).toBe(true)
    expect(isSubstantiveAnchorLine("  return batch(ids)")).toBe(true)
  })
})

describe("provenance footer (ARC-184)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Solid.",
    confidence: 5,
    confidenceReason: "All passing.",
    findings: [],
  }
  const HEAD = "abc1234567890abcdef1234567890abcdef1234"
  const NOW = 1733494200000 // 2024-12-06T13:30:00.000Z

  // ARC-293: APPROVE bodies are marker-only and intentionally bypass
  // the provenance-footer helper (`capForGitHub`). GitHub's commit
  // attribution on the approve event carries the SHA. The footer
  // assertions below pin the REQUEST_CHANGES path instead — that's
  // where the footer still lives.
  const verdictWithFinding: PrReviewVerdict = {
    summary: "Solid.",
    confidence: 5,
    confidenceReason: "All passing.",
    findings: [baseFinding],
  }

  it("APPROVE body (empty findings) is marker-only and bypasses the provenance footer (ARC-293)", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    const body = out.body ?? ""
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
    expect(body).not.toContain("_Reviewed against")
  })

  it("REQUEST_CHANGES body still ends with the SHA in the compact footer (ARC-184 invariant)", () => {
    // SIG Kimi r1: the separate "_Reviewed against `SHA` at TS._"
    // line merged into the single `<sub>` footer alongside dismiss
    // + re-run + Review #N. The SHA invariant is preserved — it's
    // still the last identifier in the body — just inline now. The
    // timestamp was dropped (GitHub already shows comment-creation
    // time at the top of the comment header).
    const out = buildReviewSubmission({
      verdict: verdictWithFinding, prAuthor: "alice", headSha: HEAD, nowMs: NOW,
    })
    const body = out.body ?? ""
    expect(body.trimEnd()).toMatch(/`abc1234`<\/sub>$/)
  })

  it("buildFallbackBody APPROVE path is marker-only (ARC-293)", () => {
    const out = buildFallbackBody(verdict, [], { headSha: HEAD, nowMs: NOW })
    expect(out).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("buildFallbackBody REQUEST_CHANGES path still ends with the SHA in the compact footer", () => {
    // SIG Kimi r1: the per-body "_Reviewed against `SHA` at TS._"
    // line is now merged into the single `<sub>` footer. The SHA
    // remains the last identifier in the body.
    const out = buildFallbackBody(
      verdictWithFinding, [], { headSha: HEAD, nowMs: NOW },
      undefined, undefined, undefined, undefined, undefined, "REQUEST_CHANGES",
    )
    expect(out.trimEnd()).toMatch(/`abc1234`<\/sub>$/)
  })

  it("body is well under 65000 chars on a small fixture", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    expect((out.body ?? "").length).toBeLessThan(2000)
  })

  it("WRITER-SIDE 65k CAP: when summary is huge, summary truncates but footer stays intact", () => {
    // ARC-281: APPROVE bodies no longer render the model's summary
    // (the renderer prints "No issues found." instead), so the cap
    // test has to exercise the REQUEST_CHANGES path where the
    // summary IS in the body. Use a fixture with one finding so the
    // body goes through `renderRequestChangesBody`. Bump summary to
    // > 65k since confidenceReason is no longer rendered and the
    // (former) 64k summary + 2k confidenceReason combo now fits
    // under the cap.
    const huge: PrReviewVerdict = {
      summary: "x".repeat(66000),
      confidence: 5,
      confidenceReason: "y".repeat(2000),
      findings: [
        {
          path: "src/foo.ts",
          line: 10,
          headline: "headline",
          body: "body",
          score: 3,
          category: "logic",
        },
      ],
    }
    const out = buildReviewSubmission({ verdict: huge, prAuthor: "alice", headSha: HEAD, nowMs: NOW })
    const body = out.body ?? ""
    expect(body.length).toBeLessThanOrEqual(65000)
    // Truncation marker is present
    expect(body).toContain("[summary truncated to fit GitHub's 65535 limit]")
    // Sigilix-bot HIGH + CR MINOR (PR #200): SHA-in-compact-footer
    // survives truncation. `capForGitHub` truncates BODY content and
    // re-appends the footer so the `<sub>...`SHA`</sub>` is never
    // sliced. This is the post-r1 equivalent of the
    // "_Reviewed against `SHA` at TS._" invariant from ARC-184.
    expect(body).toContain("`abc1234`")
    expect(body.trimEnd()).toMatch(/`abc1234`<\/sub>$/)
  })
})

describe("renderFixPlan (ARC-180)", () => {
  const fnd = (overrides: Partial<PrReviewFinding>): PrReviewFinding => ({
    ...baseFinding,
    ...overrides,
  })

  it("returns null when no findings score >= 4", () => {
    expect(renderFixPlan([fnd({ score: 1 }), fnd({ score: 3 })])).toBeNull()
  })

  it("returns null on an empty list", () => {
    expect(renderFixPlan([])).toBeNull()
  })

  it("renders only the Critical section when no High findings exist", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 1, headline: "deref crash" }),
      fnd({ score: 2, path: "b.ts", line: 5, headline: "naming" }),
    ])
    expect(out).not.toBeNull()
    expect(out!).toContain("Fix Plan")
    expect(out!).toContain("Critical (score 5)")
    expect(out!).not.toContain("High (score 4)")
    expect(out!).toContain("a.ts:1")
    expect(out!).not.toContain("b.ts:5")
  })

  it("renders Critical before High and groups within each severity by path then line", () => {
    const out = renderFixPlan([
      fnd({ score: 4, path: "z.ts", line: 10, headline: "h1" }),
      fnd({ score: 5, path: "a.ts", line: 50, headline: "h2" }),
      fnd({ score: 5, path: "a.ts", line: 5, headline: "h3" }),
      fnd({ score: 4, path: "a.ts", line: 20, headline: "h4" }),
    ])!
    // Critical block appears before High block.
    const criticalIdx = out.indexOf("Critical (score 5)")
    const highIdx = out.indexOf("High (score 4)")
    expect(criticalIdx).toBeGreaterThan(-1)
    expect(highIdx).toBeGreaterThan(criticalIdx)
    // Within Critical: a.ts:5 before a.ts:50 (line ASC within same path).
    const a5 = out.indexOf("a.ts:5", criticalIdx)
    const a50 = out.indexOf("a.ts:50", criticalIdx)
    expect(a5).toBeGreaterThan(-1)
    expect(a50).toBeGreaterThan(a5)
    // Within High: a.ts:20 before z.ts:10 (path ASC).
    const a20 = out.indexOf("a.ts:20", highIdx)
    const z10 = out.indexOf("z.ts:10", highIdx)
    expect(a20).toBeGreaterThan(-1)
    expect(z10).toBeGreaterThan(a20)
  })

  it("renders multi-line range when startLine is set", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 20, startLine: 15, headline: "h" }),
    ])!
    expect(out).toContain("a.ts:15-20")
    expect(out).not.toContain("a.ts:20 ")
  })

  it("uses single-line format when startLine equals line", () => {
    const out = renderFixPlan([
      fnd({ score: 5, path: "a.ts", line: 20, startLine: 20, headline: "h" }),
    ])!
    expect(out).toContain("a.ts:20")
    expect(out).not.toContain("a.ts:20-20")
  })

  it("truncates over-long headlines", () => {
    const long = "x".repeat(200)
    const out = renderFixPlan([fnd({ score: 5, headline: long })])!
    expect(out).toContain("…")
    expect(out.length).toBeLessThan(long.length + 200)
  })

  it("singularizes the count label", () => {
    const out = renderFixPlan([fnd({ score: 5, headline: "only one" })])!
    expect(out).toMatch(/Critical \(score 5\)\*\*\s*—\s*1 finding\b/)
    expect(out).not.toMatch(/1 findings\b/)
  })

  it("pluralizes the count label", () => {
    const out = renderFixPlan([
      fnd({ score: 4, path: "a.ts", line: 1, headline: "h1" }),
      fnd({ score: 4, path: "b.ts", line: 1, headline: "h2" }),
    ])!
    expect(out).toMatch(/High \(score 4\)\*\*\s*—\s*2 findings\b/)
  })
})

// ─── SIG-101 — severity badges, confidence, retrigger, counter ─────

describe("severityBadgeForScore (SIG-164 PR 5: SVG badges)", () => {
  // SIG-164 PR 5: emoji badges → hosted SVG <img> tags. Now always
  // returns a string (was string|null) since P3 covers the previously-
  // null low-severity case.
  it("returns the P0 badge img for score 5", () => {
    expect(severityBadgeForScore(5)).toContain('alt="P0"')
    expect(severityBadgeForScore(5)).toContain(badgeAssetUrl("p0"))
  })
  it("returns the P1 badge img for score 4", () => {
    expect(severityBadgeForScore(4)).toContain('alt="P1"')
    expect(severityBadgeForScore(4)).toContain(badgeAssetUrl("p1"))
  })
  it("returns the P2 badge img for score 3", () => {
    expect(severityBadgeForScore(3)).toContain('alt="P2"')
    expect(severityBadgeForScore(3)).toContain(badgeAssetUrl("p2"))
  })
  it("returns the P3 badge img for score 2 (was null pre-SIG-164)", () => {
    expect(severityBadgeForScore(2)).toContain('alt="P3"')
    expect(severityBadgeForScore(2)).toContain(badgeAssetUrl("p3"))
  })
  it("returns the P3 badge img for score 1 (was null pre-SIG-164)", () => {
    expect(severityBadgeForScore(1)).toContain('alt="P3"')
  })
  it("renders badges as <a href=\"#\"><img></a> with NO explicit width/height (SIG-238 r9)", () => {
    // SIG-238 round-9 pattern. Empirically this combo (a-wrap +
    // missing dimensions) defeats Primer's bubble rule. r4 (drop
    // a-wrap) + r7 (32×32 transparent inset) both lost.
    const out = severityBadgeForScore(3)
    expect(out).toMatch(/<a href="#"><img\s/)
    expect(out).toContain('align="top"')
    expect(out).toContain("</a>")
    // Critical absence: explicit IMG width/height. Greptile omits both
    // — adding them re-introduces the bubble on github.com PR comments.
    expect(out).not.toMatch(/<img[^>]*\swidth=/)
    expect(out).not.toMatch(/<img[^>]*\sheight=/)
  })
  it("uses the public Sigilix/sigilix-glyphs raw host so GitHub's js-gh-image-fallback doesn't inject border-radius (SIG-238 round-6)", () => {
    // SIG-238 round-6 = the actual fix. Tonight we created
    // `Sigilix/sigilix-glyphs` (PUBLIC) and pushed the 13 glyph SVGs
    // there under the version tag. The URL pattern
    // `raw.githubusercontent.com/Sigilix/sigilix-glyphs/<version>/<name>.svg`
    // bypasses Camo (same-origin to github.com) AND loads anonymously
    // (public repo). Verified via `gh api /markdown` on the live URL
    // — no Camo proxy, no `border-radius`, no `background-color`.
    const out = severityBadgeForScore(3)
    expect(out).toContain(`${PUBLIC_BADGE_BASE_URL}/${BADGE_ASSET_VERSION}/p2.svg`)
    expect(out).toContain("raw.githubusercontent.com/Sigilix/sigilix-glyphs")
    expect(out).not.toContain("sigilix.dan-martinezjulio.workers.dev")
    expect(out).not.toContain("Sigilix/sigilix/main")
  })
  it("treats super-high scores as P0 (defensive clamp)", () => {
    expect(severityBadgeForScore(6)).toContain('alt="P0"')
    expect(severityBadgeForScore(99)).toContain('alt="P0"')
  })
})

describe("Trust Ledger render (PR3a) — gated on `trustLedger`", () => {
  it("appends the per-finding pill to the inline comment header only when on", () => {
    const grounded = { ...baseFinding, trust: { tier: "grounded-model" as const } }
    expect(formatFindingComment(grounded, 5, undefined, undefined, true)).toContain("trust-grounded")
    const runner = { ...baseFinding, trust: { tier: "runner-confirmed" as const } }
    expect(formatFindingComment(runner, 5, undefined, undefined, true)).toContain("runner-verified")
    const model = { ...baseFinding, trust: { tier: "body-only-ungrounded" as const } }
    expect(formatFindingComment(model, 5, undefined, undefined, true)).toContain("trust-model")
    // backward-compat: a finding with NO trust field (pre-Trust-Ledger) → the muted
    // MODEL pill, not a crash and not an unearned GROUNDED/VERIFIED.
    const noTrust = formatFindingComment(baseFinding, 5, undefined, undefined, true)
    expect(noTrust).toContain("trust-model")
    expect(noTrust).not.toContain("trust-grounded")
    expect(noTrust).not.toContain("runner-verified")
    // off (default) → no pill of any kind; byte-identical header to today.
    const off = formatFindingComment(grounded, 5, undefined, undefined, false)
    expect(off).not.toContain("trust-grounded")
    expect(off).not.toContain("trust-model")
    expect(off).not.toContain("runner-verified")
  })

  it("renders the Trust Summary (Proof line) under the lead only when on", () => {
    const verdict: PrReviewVerdict = {
      summary: "One grounded finding.",
      confidence: 4,
      confidenceReason: "narrow surface",
      findings: [{ ...baseFinding, score: 4, trust: { tier: "grounded-model" } }],
    }
    const on = buildReviewSubmissionWithMetadata({ verdict, prAuthor: null, headSha: "abc1234", trustLedger: true })
    // the segmented summary: total + the proof breakdown (1 grounded-model finding).
    expect(on.submission.body).toContain("**1 finding**")
    expect(on.submission.body).toContain("**Proof**: 1 grounded")
    const off = buildReviewSubmissionWithMetadata({ verdict, prAuthor: null, headSha: "abc1234", trustLedger: false })
    expect(off.submission.body).not.toContain("**Proof**")
    expect(off.submission.body).not.toContain("**1 finding**")
  })

  it("PR3b: restructures body findings — collapsed outside-diff dropdown + PR-level section (on only)", () => {
    const bf = (over: Partial<PrReviewFinding>): PrReviewFinding => ({ ...baseFinding, score: 3, ...over })
    const verdict: PrReviewVerdict = { summary: "Body findings.", confidence: 4, confidenceReason: "x", findings: [] }
    const unanchored: PrReviewFinding[] = [
      bf({ headline: "outside the diff", trust: { tier: "grounded-model", surface: "body", demoteReason: "outside-diff" } }),
      bf({ headline: "no test for this", scope: "pr", trust: { tier: "grounded-model", surface: "body" } }), // genuinely PR-scoped
      bf({ headline: "ungrounded nit", trust: { tier: "body-only-ungrounded", surface: "body", demoteReason: "inline-grounding" } }), // → flat list (not pr-scoped)
    ]
    const on = buildReviewSubmissionWithMetadata({ verdict, prAuthor: null, headSha: "abc1234", unanchored, trustLedger: true }).submission.body
    expect(on).toContain("couldn't be anchored to a specific line") // the collapsed unanchorable dropdown
    expect(on).toContain("<details>")
    expect(on).toContain("**PR-level**")
    expect(on).not.toContain("could not be anchored") // the old generic disclaimer is dropped
    // off → the generic flat section + disclaimer, no dropdown / no PR-level heading.
    const off = buildReviewSubmissionWithMetadata({ verdict, prAuthor: null, headSha: "abc1234", unanchored, trustLedger: false }).submission.body
    expect(off).not.toContain("couldn't be anchored to a specific line")
    expect(off).not.toContain("**PR-level**")
    expect(off).toContain("could not be anchored")
  })

  it("body-row glyph layout: the trust pill LEADS with the badges (before the location), not orphaned after the headline", () => {
    // The dogfood layout bug: the trust pill (GROUNDED/MODEL) was jammed
    // immediately after the bold headline, landing in a random mid-line spot
    // when the title wrapped. It belongs with the leading severity+category
    // badges (`trustPill` doc: "append after the category glyph"), matching the
    // inline `formatFindingComment` render.
    const verdict: PrReviewVerdict = { summary: "Body findings.", confidence: 4, confidenceReason: "x", findings: [] }
    const unanchored: PrReviewFinding[] = [
      { ...baseFinding, score: 3, headline: "evidence rendered without redaction",
        trust: { tier: "grounded-model", surface: "body", demoteReason: "inline-grounding" } },
    ]
    const body = buildReviewSubmissionWithMetadata({ verdict, prAuthor: null, headSha: "abc1234", unanchored, trustLedger: true }).submission.body
    const pillIdx = body.indexOf("trust-grounded")
    const headlineIdx = body.indexOf("evidence rendered without redaction")
    expect(pillIdx).toBeGreaterThanOrEqual(0)
    expect(headlineIdx).toBeGreaterThanOrEqual(0)
    // pill renders BEFORE the bold location + headline (with the leading badges)…
    expect(pillIdx).toBeLessThan(headlineIdx)
    // …and is NOT jammed immediately after the bold headline (the old broken
    // layout). The pill renders as `<a …><img …></a>`, so match the anchor wrapper
    // to actually catch the old `**headline**<pill>` order (a bare `<img` check
    // would pass on both layouts).
    expect(body).not.toMatch(/redaction\*\*\s*<a[^>]*>\s*<img[^>]*trust-grounded/)
  })
})

describe("Evidence provenance render (SIG-112) — gated on `showEvidence`", () => {
  const withEvidence: PrReviewFinding = {
    ...baseFinding,
    evidence: {
      specialistsThatFlagged: ["logic", "security"],
      specialistsThatDeclined: ["performance", "tests"],
      deterministicFactIds: ["secret:generic-api-key:abc123:42", "siblingMapping:src/lib/foo.ts->NONE"],
      retrievalChunkIds: ["chunk-7"],
      relatedPriorPRs: ["#123"],
      synthDecision: "merged",
      consensusScore: 2,
    },
  }

  it("renders the collapsible evidence block in inline comments only when enabled", () => {
    const on = formatFindingComment(withEvidence, 5, undefined, undefined, false, true)
    expect(on).toContain("Why Sigilix flagged this (6 pieces of evidence)")
    expect(on).toContain("Flagged by: logic, security")
    expect(on).toContain("Did not flag: performance, tests")
    expect(on).toContain("Deterministic facts: `secret:generic-api-key:abc123:42`, `siblingMapping:src/lib/foo.ts-&gt;NONE`")
    expect(on).toContain("Retrieval chunks: `chunk-7`")
    expect(on).toContain("Related prior PRs: `#123`")
    expect(on).toContain("Synth decision: merged")

    const off = formatFindingComment(withEvidence, 5, undefined, undefined, false, false)
    expect(off).not.toContain("Why Sigilix flagged this")
  })

  it("escapes evidence values rendered inside the details block", () => {
    const body = formatFindingComment({
      ...baseFinding,
      evidence: {
        specialistsThatFlagged: ["logic<script>"],
        specialistsThatDeclined: ["tests&perf"],
        deterministicFactIds: ["siblingMapping:src/lib/foo.ts->tests/foo.test.ts</script>&"],
        retrievalChunkIds: ["chunk-`quoted`"],
        relatedPriorPRs: [],
        synthDecision: "kept",
        consensusScore: 1,
      },
    }, 5, undefined, undefined, false, true)

    expect(body).toContain("Flagged by: logic&lt;script&gt;")
    expect(body).toContain("Did not flag: tests&amp;perf")
    expect(body).toContain("`siblingMapping:src/lib/foo.ts-&gt;tests/foo.test.ts&lt;/script&gt;&amp;`")
    expect(body).toContain("`chunk-&#96;quoted&#96;`")
    expect(body).not.toContain("tests/foo.test.ts</script>&")
  })

  it("does not render an evidence block for empty structured records", () => {
    const emptyEvidence: PrReviewFinding = {
      ...baseFinding,
      evidence: {
        specialistsThatFlagged: [],
        specialistsThatDeclined: [],
        deterministicFactIds: [],
        retrievalChunkIds: [],
        relatedPriorPRs: [],
        synthDecision: "merged",
        consensusScore: 0,
      },
    }

    const body = formatFindingComment(emptyEvidence, 5, undefined, undefined, false, true)
    expect(body).not.toContain("Why Sigilix flagged this")
  })

  it("renders evidence blocks for body-only findings only when enabled", () => {
    const verdict: PrReviewVerdict = {
      summary: "One body finding.",
      confidence: 4,
      confidenceReason: "Fixture.",
      findings: [],
    }
    const on = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: null,
      headSha: "abc1234",
      unanchored: [{ ...withEvidence, scope: "comment", score: 3 }],
      showEvidence: true,
    }).submission.body
    expect(on).toContain("Why Sigilix flagged this (6 pieces of evidence)")

    const off = buildReviewSubmissionWithMetadata({
      verdict,
      prAuthor: null,
      headSha: "abc1234",
      unanchored: [{ ...withEvidence, scope: "comment", score: 3 }],
      showEvidence: false,
    }).submission.body
    expect(off).not.toContain("Why Sigilix flagged this")
  })
})
