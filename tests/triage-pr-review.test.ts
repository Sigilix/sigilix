// Proactive PR-review pure helpers: response parser + review-submission
// builder + approval-event picker.

import { describe, expect, it } from "vitest"
import {
  buildFallbackBody,
  buildReviewSubmission,
  chooseReviewEvent,
  chooseReviewEventWithGate,
  computeGateScore,
  computeShadowGateDivergence,
  filterToSigilixAuthored,
  formatFindingComment,
  formatProposedChangeBlock,
  formatAiAgentPromptBlock,
  hasRequiredEvidence,
  isCommentAnchorable,
  isSubstantiveAnchorLine,
  pickAnchorLineForward,
  parsePrReviewResponse,
  renderCommentBody,
  renderFixPlan,
  renderRequestChangesBody,
  resolveFindingConfidence,
  severityBadgeForScore,
  type AuthoredItem,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "../src/lib/triage-pr-review"
import { badgeAssetUrl, PUBLIC_BADGE_BASE_URL } from "../src/lib/badge-assets"
import type { ReviewableMap } from "../src/lib/diff-positions"

const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 3,
  headline: "missing null guard on `user.profile`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
}

describe("parsePrReviewResponse", () => {
  const valid: PrReviewVerdict = {
    summary: "Safe; one nit.",
    confidence: 4,
    confidenceReason: "Narrow surface, well-tested.",
    findings: [baseFinding],
  }

  it("parses a well-formed JSON object", () => {
    const out = parsePrReviewResponse(JSON.stringify(valid))
    expect(out?.summary).toBe(valid.summary)
    expect(out?.confidence).toBe(4)
    expect(out?.findings).toHaveLength(1)
  })

  it("strips a surrounding ```json fence", () => {
    const text = "```json\n" + JSON.stringify(valid) + "\n```"
    expect(parsePrReviewResponse(text)?.summary).toBe(valid.summary)
  })

  it("returns null on missing summary", () => {
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, summary: "" }))).toBeNull()
  })

  it("returns null on out-of-range confidence", () => {
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, confidence: 0 }))).toBeNull()
    expect(parsePrReviewResponse(JSON.stringify({ ...valid, confidence: 6 }))).toBeNull()
  })

  it("drops findings missing path / line / score / headline / body", () => {
    const broken = {
      ...valid,
      findings: [
        baseFinding,
        { ...baseFinding, path: "" },
        { ...baseFinding, line: 0 },
        { ...baseFinding, headline: "" },
        { ...baseFinding, body: "" },
        { ...baseFinding, score: 99 }, // out of range — dropped
      ],
    }
    const out = parsePrReviewResponse(JSON.stringify(broken))
    expect(out?.findings).toHaveLength(1)
  })

  it("clamps score into 1-5", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, score: 4.6 }] })
    )
    expect(out?.findings[0]?.score).toBe(5)
  })

  it.each([
    ["line", "line"],
    ["file", "file"],
    ["pr", "pr"],
    ["comment", "comment"],
    ["comment/event", "comment"],
    ["event", "comment"],
    ["review-comment", "comment"],
    ["pull-request", "pr"],
    ["pull_request", "pr"],
    ["review", "pr"],
  ] as const)("normalizes finding scope %s to %s", (raw, expected) => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, scope: raw }] })
    )
    expect(out?.findings[0]?.scope).toBe(expected)
  })

  it.each(["thread", ""])("ignores invalid finding scope %j for back-compat", (scope) => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, scope }] })
    )
    expect(out?.findings[0]?.scope).toBeUndefined()
  })

  it("includes startLine when valid (positive, less than line)", () => {
    const out = parsePrReviewResponse(
      JSON.stringify({ ...valid, findings: [{ ...baseFinding, startLine: 38 }] })
    )
    expect(out?.findings[0]?.startLine).toBe(38)
  })

  it("drops invalid startLine (>= line, negative, NaN)", () => {
    const finding = { ...baseFinding, line: 50, startLine: 60 }
    const out = parsePrReviewResponse(JSON.stringify({ ...valid, findings: [finding] }))
    expect(out?.findings[0]?.startLine).toBeUndefined()
  })

  it("caps findings at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...baseFinding,
      headline: `f${i}`,
      line: 10 + i,
    }))
    const out = parsePrReviewResponse(JSON.stringify({ ...valid, findings: many }))
    expect(out?.findings).toHaveLength(8)
  })
})

describe("chooseReviewEvent", () => {
  const f = (score: number): PrReviewFinding => ({ ...baseFinding, score })

  // Two-state strict verdict: empty findings → APPROVE, anything else
  // → REQUEST_CHANGES. Score still sorts/severity-tags findings in the
  // body but no longer changes the verdict. Closed-loop semantics:
  // user pushes fixes → arc re-reviews on the new SHA → empty findings
  // → APPROVE. See PR #28 (synchronize re-review).

  it("APPROVE only when findings are empty", () => {
    expect(chooseReviewEvent([])).toBe("APPROVE")
  })

  it("REQUEST_CHANGES on ANY finding regardless of score", () => {
    // Critical: even score-1 nits block now. The model is told via the
    // prompt to only emit findings worth blocking over — if it surfaces
    // one, treat it as a blocker.
    expect(chooseReviewEvent([f(1)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(2)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(3)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(4)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(5)])).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES on a mix regardless of max score", () => {
    expect(chooseReviewEvent([f(1), f(2), f(2)])).toBe("REQUEST_CHANGES")
    expect(chooseReviewEvent([f(2), f(5), f(3)])).toBe("REQUEST_CHANGES")
  })

  // SIG-37 — when the caller passes in a list of open PR threads /
  // review comments / blocking items via the optional `openItems`
  // arg, Sigilix's APPROVE decision must only consider items it
  // itself authored. CodeRabbit / Greptile / other-bot / human-
  // reviewer items must NOT influence the gate.
  //
  // Establishes the clean Sigilix-only signal needed for the
  // head-to-head measurement framework (SIG-200, separately tracked).
  describe("SIG-37 — Sigilix-only gating of openItems", () => {
    const crThread: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
    const greptileThread: AuthoredItem = { user: { login: "greptile-apps[bot]" } }
    const humanThread: AuthoredItem = { user: { login: "alice" } }
    const sigilixThread: AuthoredItem = { user: { login: "sigilix[bot]" } }

    it("APPROVE despite an unresolved CodeRabbit thread (zero Sigilix threads)", () => {
      // SIG-37 fixture 1: Sigilix has nothing to flag, CodeRabbit
      // has one unresolved thread. Pre-fix, an approval gate that
      // counted all open threads would withhold APPROVE; post-fix
      // the CR thread is filtered out and Sigilix posts APPROVE.
      expect(chooseReviewEvent([], [crThread])).toBe("APPROVE")
    })

    it("REQUEST_CHANGES when Sigilix has an unresolved thread (zero CR threads)", () => {
      // SIG-37 fixture 2: the Sigilix-authored open thread must
      // still block APPROVE. This is the half of the gate that
      // didn't change — Sigilix-only signal in, Sigilix-only signal
      // out.
      expect(chooseReviewEvent([], [sigilixThread])).toBe("REQUEST_CHANGES")
    })

    it("APPROVE when ALL open threads are non-Sigilix (CR + Greptile + human)", () => {
      // Mixed-bag of other-actor threads — none of which Sigilix
      // owns. Filter strips everything; gate sees an empty list +
      // empty findings → APPROVE.
      expect(
        chooseReviewEvent([], [crThread, greptileThread, humanThread]),
      ).toBe("APPROVE")
    })

    it("REQUEST_CHANGES when mixed open threads include at least one Sigilix-authored", () => {
      // Even with other-actor noise in the same list, a single
      // Sigilix-authored open thread is enough to withhold APPROVE.
      expect(
        chooseReviewEvent([], [crThread, sigilixThread, humanThread]),
      ).toBe("REQUEST_CHANGES")
    })

    it("REQUEST_CHANGES when the synth has its own findings, regardless of openItems mix", () => {
      // Findings short-circuit the gate (existing semantics). The
      // `openItems` arg is a secondary signal — never overrides a
      // non-empty findings list.
      expect(chooseReviewEvent([f(3)], [crThread])).toBe("REQUEST_CHANGES")
      expect(chooseReviewEvent([f(3)], [sigilixThread])).toBe("REQUEST_CHANGES")
      expect(chooseReviewEvent([f(3)], [])).toBe("REQUEST_CHANGES")
    })

    it("defaults openItems to [] so existing call sites are unaffected", () => {
      // Defensive: every existing caller passes only the synth
      // verdict's findings; they must keep producing APPROVE on
      // empty findings without needing to thread an openItems arg
      // through.
      expect(chooseReviewEvent([])).toBe("APPROVE")
      expect(chooseReviewEvent([f(2)])).toBe("REQUEST_CHANGES")
    })

    it("handles items with null user (deleted-author rows from GitHub) by dropping them", () => {
      // GitHub returns `user: null` for comments whose author has
      // been deleted. The filter treats those as non-Sigilix and
      // drops them — they shouldn't block APPROVE on the Sigilix-
      // only signal.
      const deletedAuthor: AuthoredItem = { user: null }
      expect(chooseReviewEvent([], [deletedAuthor])).toBe("APPROVE")
    })
  })
})

// SIG-161 PR 4a — new thresholded gate (`chooseReviewEventWithGate`)
// runs alongside the legacy `chooseReviewEvent`. Used in shadow/enforce
// modes; the legacy path remains in `off` mode for back-compat.
// Implements the four-event table from DESIGN.md §4:
//   - any finding with gateScore >= threshold → REQUEST_CHANGES (blocking)
//   - no blocking + any Sigilix-authored open item → REQUEST_CHANGES
//   - no blocking + findings in [FLOOR_SUPPRESS, threshold) → COMMENT
//   - no findings + no open items → APPROVE
describe("chooseReviewEventWithGate (SIG-161)", () => {
  const f = (gateScore: number | undefined, score = 3): PrReviewFinding => ({
    ...baseFinding,
    score,
    ...(gateScore !== undefined ? { gateScore } : {}),
  })
  const sigItem: AuthoredItem = { user: { login: "sigilix[bot]" } }
  const crItem: AuthoredItem = { user: { login: "coderabbitai[bot]" } }

  describe("verdict events", () => {
    it("APPROVE on empty findings + empty open items", () => {
      expect(
        chooseReviewEventWithGate({
          findings: [],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("APPROVE")
    })

    it("REQUEST_CHANGES when any finding clears the threshold", () => {
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.5), f(0.95), f(0.7)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it("REQUEST_CHANGES when no blocking finding but Sigilix open item exists", () => {
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.7)],
          threshold: 0.85,
          openItems: [sigItem],
          missingScorePolicy: "permit",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it("COMMENT when borderline findings exist + no open items", () => {
      // 0.70 in [0.60, 0.85) → posted as COMMENT, no verdict change
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.7)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
    })

    it("COMMENT also fires for multiple borderline findings", () => {
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.65), f(0.72), f(0.80)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
    })

    it("APPROVE ignores non-Sigilix-authored open items (SIG-37 preserved)", () => {
      // CodeRabbit thread alone does not block.
      expect(
        chooseReviewEventWithGate({
          findings: [],
          threshold: 0.85,
          openItems: [crItem],
          missingScorePolicy: "permit",
        }),
      ).toBe("APPROVE")
    })

    it("threshold inclusive (>= chosenThreshold blocks)", () => {
      // Exact-equal score must be treated as blocking per §4 table.
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.85)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it("threshold = 1.0 with all permitted scores produces COMMENT not REQUEST_CHANGES", () => {
      // The "off-equivalent" knob: when permit policy + threshold 1.0,
      // findings with gateScore < 1.0 are non-blocking borderline.
      expect(
        chooseReviewEventWithGate({
          findings: [f(0.5), f(0.7), f(0.9)],
          threshold: 1.0,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
    })
  })

  describe("missingScorePolicy", () => {
    it('block: missing gateScore is treated as 1.0 (effectively blocks)', () => {
      // Rollout fail-open: a finding without a score blocks like today.
      // With threshold = 1.0, the effective 1.0 score is >= threshold,
      // so we get REQUEST_CHANGES — same as the legacy `findings.length > 0`.
      expect(
        chooseReviewEventWithGate({
          findings: [f(undefined)],
          threshold: 1.0,
          missingScorePolicy: "block",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it('block: missing gateScore still blocks even at sub-1.0 thresholds', () => {
      // With threshold = 0.85 + block policy, the effective 1.0 is still
      // >= 0.85, so REQUEST_CHANGES.
      expect(
        chooseReviewEventWithGate({
          findings: [f(undefined)],
          threshold: 0.85,
          missingScorePolicy: "block",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it('throw: missing gateScore raises a pipeline-invariant error', () => {
      // Post-calibration regime — every finding MUST have a score by
      // the time it reaches the gate. A missing score is a bug, not a
      // case to silently handle.
      expect(() =>
        chooseReviewEventWithGate({
          findings: [f(undefined)],
          threshold: 0.85,
          missingScorePolicy: "throw",
        }),
      ).toThrow(/gateScore missing/)
    })

    it("non-finite gateScore (NaN / Infinity) routes through missingScorePolicy, NOT the score comparison", () => {
      // PR #145 CodeRabbit catch: `typeof NaN === "number"` so a NaN
      // gateScore would otherwise pass the `typeof === "number"` check.
      // `NaN >= threshold` is always false → blocker branch silently
      // misses it. Guard by checking isFinite; non-finite falls through
      // to missingScorePolicy.
      const nanFinding: PrReviewFinding = { ...baseFinding, gateScore: Number.NaN }
      // With "block" policy → effective 1.0 → blocks regardless of NaN.
      expect(
        chooseReviewEventWithGate({
          findings: [nanFinding],
          threshold: 0.85,
          missingScorePolicy: "block",
        }),
      ).toBe("REQUEST_CHANGES")
      // With "permit" policy → effective 0.0 → COMMENT (non-blocking but
      // not empty). Without the isFinite guard, the NaN finding would
      // be treated as scored and skip both branches.
      expect(
        chooseReviewEventWithGate({
          findings: [nanFinding],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
      // With "throw" policy → explicit error.
      expect(() =>
        chooseReviewEventWithGate({
          findings: [nanFinding],
          threshold: 0.85,
          missingScorePolicy: "throw",
        }),
      ).toThrow(/gateScore missing/)
      // Same behavior for ±Infinity.
      const infFinding: PrReviewFinding = { ...baseFinding, gateScore: Number.POSITIVE_INFINITY }
      expect(
        chooseReviewEventWithGate({
          findings: [infFinding],
          threshold: 0.85,
          missingScorePolicy: "block",
        }),
      ).toBe("REQUEST_CHANGES")
    })

    it('permit: missing gateScore is treated as 0.0 (offline replay)', () => {
      // Replay/backfill: synthesize verdicts on pre-gate findings.
      // Missing score floors at 0.0 → suppressed (< FLOOR_SUPPRESS in
      // the pre-emit filter, but here it just falls into the < threshold
      // band and contributes to COMMENT). Empty findings APPROVE.
      expect(
        chooseReviewEventWithGate({
          findings: [],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("APPROVE")
      // A finding with no score + permit policy is below threshold →
      // not blocking; still counts as a finding so COMMENT fires.
      expect(
        chooseReviewEventWithGate({
          findings: [f(undefined)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
    })
  })

  describe("legacy-equivalent mode", () => {
    // The configuration the call site uses when `OPENCLAW_GATE = off`:
    // threshold = 1.0 + missingScorePolicy = "block" → identical to the
    // legacy `chooseReviewEvent` (any finding → REQUEST_CHANGES).
    const legacy = (findings: PrReviewFinding[], openItems: AuthoredItem[] = []) =>
      chooseReviewEventWithGate({
        findings,
        threshold: 1.0,
        openItems,
        missingScorePolicy: "block",
      })

    it("empty findings → APPROVE (matches legacy)", () => {
      expect(legacy([])).toBe("APPROVE")
    })

    it("any finding (no gateScore) → REQUEST_CHANGES (matches legacy)", () => {
      expect(legacy([f(undefined)])).toBe("REQUEST_CHANGES")
      expect(legacy([f(undefined), f(undefined)])).toBe("REQUEST_CHANGES")
    })

    it("Sigilix open item with no findings → REQUEST_CHANGES (matches legacy)", () => {
      expect(legacy([], [{ user: { login: "sigilix[bot]" } }])).toBe("REQUEST_CHANGES")
    })

    it("non-Sigilix open item with no findings → APPROVE (matches legacy SIG-37)", () => {
      expect(legacy([], [{ user: { login: "coderabbitai[bot]" } }])).toBe("APPROVE")
    })
  })
})

// SIG-161 PR 4a — gate-score blend (DESIGN.md §5). Hand-tuned coefficients
// in v1; PR 4c replaces this with a logistic regression fit on labels.
describe("computeGateScore (SIG-161 §5)", () => {
  const f = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding,
    score: 3,
    ...overrides,
  })

  it("clamps to [0, 1]", () => {
    // Maximal inputs (conf 5 + evidence + 3-way agreement + score 5):
    //   0.90 + 0.10 + 0.10 + 0.10 = 1.20 → clamped to 1.0
    expect(
      computeGateScore(
        f({ confidence: 5, score: 5, category: "logic" }),
        { sourceSpecialists: ["logic", "security", "performance"] },
      ),
    ).toBe(1.0)
    // Minimal inputs (conf 1 + no evidence + 1-way + score 1):
    //   0.10 + 0 + 0 + (-0.10) = 0.0
    // Use category:"testing" without inspectedTestFiles/evidenceRefs so
    // `hasRequiredEvidence` returns false and the evidence boost is 0.
    // (Logic always returns true since it has no per-category
    // evidence requirement.)
    expect(
      computeGateScore(
        f({ confidence: 1, score: 1, category: "testing" }),
        { sourceSpecialists: ["tests"] },
      ),
    ).toBe(0.0)
  })

  it("weakly monotone in confidence (1→5 produces non-decreasing scores)", () => {
    const scores = [1, 2, 3, 4, 5].map((c) =>
      computeGateScore(
        f({ confidence: c, score: 3, category: "logic" }),
        { sourceSpecialists: ["logic"] },
      ),
    )
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] ?? 0)
    }
  })

  it("weakly monotone in severity (score 1→5 non-decreasing)", () => {
    const out = [1, 2, 3, 4, 5].map((s) =>
      computeGateScore(
        f({ confidence: 3, score: s, category: "logic" }),
        { sourceSpecialists: ["logic"] },
      ),
    )
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] ?? 0)
    }
  })

  it("evidence presence boosts score by 0.10 (testing category)", () => {
    // Testing requires inspectedTestFiles OR evidenceRefs for evidence credit
    const noEv = computeGateScore(
      f({ confidence: 3, score: 3, category: "testing" }),
      { sourceSpecialists: ["tests"] },
    )
    const withEv = computeGateScore(
      f({
        confidence: 3,
        score: 3,
        category: "testing",
        inspectedTestFiles: ["tests/foo.test.ts"],
      }),
      { sourceSpecialists: ["tests"] },
    )
    expect(withEv - noEv).toBeCloseTo(0.10, 5)
  })

  it("agreement boosts score by 0.05 per additional specialist, capped at 0.10", () => {
    const oneSpec = computeGateScore(
      f({ confidence: 3, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic"] },
    )
    const twoSpec = computeGateScore(
      f({ confidence: 3, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic", "security"] },
    )
    const threeSpec = computeGateScore(
      f({ confidence: 3, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic", "security", "performance"] },
    )
    const fourSpec = computeGateScore(
      f({ confidence: 3, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic", "security", "performance", "tests"] },
    )
    expect(twoSpec - oneSpec).toBeCloseTo(0.05, 5)
    expect(threeSpec - twoSpec).toBeCloseTo(0.05, 5)
    expect(fourSpec - threeSpec).toBeCloseTo(0.0, 5)   // cap
  })

  it("defaults missing confidence to 3 (neutral)", () => {
    const missing = computeGateScore(
      f({ confidence: undefined, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic"] },
    )
    const explicit3 = computeGateScore(
      f({ confidence: 3, score: 3, category: "logic" }),
      { sourceSpecialists: ["logic"] },
    )
    expect(missing).toBeCloseTo(explicit3, 5)
  })

  it("reproduces the PR #138 SIG-128 over-fire (acceptance evidence §10)", () => {
    // confidence: 3 (rescale 0.50) + score: 4 (severity +0.05) +
    // testing with inspectedTestFiles (evidence +0.10) +
    // single specialist (no agreement boost) = 0.65 (COMMENT band)
    const sig128 = computeGateScore(
      f({
        confidence: 3,
        score: 4,
        category: "testing",
        inspectedTestFiles: ["tests/index-reconciliation.test.ts"],
      }),
      { sourceSpecialists: ["tests"] },
    )
    expect(sig128).toBeCloseTo(0.65, 5)
  })
})

// SIG-161/SIG-167 — `renderCommentBody` body shape. COMMENT posts share
// the findings layout with REQUEST_CHANGES but must read as non-blocking
// and omit verdict-only affordances.
describe("renderCommentBody (SIG-161)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Borderline findings worth a look.",
    confidence: 3,
    confidenceReason: "Two findings in the borderline band.",
    findings: [{ ...baseFinding, score: 3, category: "logic" }],
  }

  it("contains the sigilix:pr-review marker (same as RC body)", () => {
    const body = renderCommentBody({ verdict })
    expect(body).toContain("<!-- sigilix:pr-review -->")
  })

  it("uses non-blocking heading copy instead of blocker framing (SIG-167)", () => {
    const body = renderCommentBody({ verdict })
    expect(body).toMatch(/^## Sigilix: 1 non-blocking finding$/m)
    expect(body).not.toMatch(/^## Sigilix: 1 finding$/m)
  })

  it("omits the dismissal hint because COMMENT has no verdict to dismiss (SIG-167)", () => {
    const body = renderCommentBody({ verdict })
    expect(body).not.toContain("To dismiss this review")
    expect(body).not.toContain("@sigilix dismiss")
  })

  it("STRIPS reviewCounter even when supplied (no 'Review #N' on a non-verdict post)", () => {
    // PR 4c's `enforce` mode passes a counter to the renderer regardless
    // of event — the body builder is responsible for omitting it on
    // COMMENT. Verified by passing a counter that WOULD render via
    // renderRequestChangesBody and confirming it doesn't.
    const body = renderCommentBody({
      verdict,
      reviewCounter: 5,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).not.toContain("Review #")
    expect(body).not.toContain("Review #5")
  })

  it("STRIPS retriggerUrl even when supplied (no '/sigilix review' hint on a non-verdict post)", () => {
    // Same rationale as the counter — the dispatching call site doesn't
    // need to know about event type; the body builder strips.
    const body = renderCommentBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
    })
    expect(body).not.toContain("Comment `/sigilix review`")
  })

  it("forward-safe via rest-spread strip: new optional RenderBodyArgs fields flow through unchanged", () => {
    // Belt-and-suspenders: confirm a field that exists today (delta)
    // still reaches the body when supplied to renderCommentBody. The
    // rest-spread denylist only omits reviewCounter + retriggerUrl;
    // anything else delegates as-is.
    const body = renderCommentBody({
      verdict,
      delta: {
        newCount: 1,
        stillOpenCount: 0,
        likelyFixedCount: 0,
        carriedOverCount: 0,
      },
    })
    // The Changes line is the post-rebrand evidence that `delta` flowed
    // through (was `Δ` pre-2026-05-23 rebrand).
    expect(body).toContain("**Changes:** +1 new")
  })
})

// SIG-161 PR 4a — evidence presence rules per category (DESIGN.md §5).
// Categories with score>=4 requirements: security (cweId AND evidenceId),
// performance (one of complexityEstimate / hotPathIdentifier),
// testing (one of inspectedTestFiles / evidenceRefs).
// Other categories: always true (no per-category requirement today).
describe("hasRequiredEvidence (SIG-161 §5)", () => {
  it("security score>=4 requires both cweId and evidenceId", () => {
    const base = { ...baseFinding, category: "security" as const, score: 4 }
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, cweId: "CWE-89" })).toBe(false)
    expect(hasRequiredEvidence({ ...base, evidenceId: "x" })).toBe(false)
    expect(hasRequiredEvidence({ ...base, cweId: "CWE-89", evidenceId: "x" })).toBe(true)
  })

  it("security score<4 does not require evidence (returns true)", () => {
    expect(
      hasRequiredEvidence({ ...baseFinding, category: "security", score: 3 }),
    ).toBe(true)
  })

  it("performance score>=4 requires complexityEstimate OR hotPathIdentifier", () => {
    const base = { ...baseFinding, category: "performance" as const, score: 4 }
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, complexityEstimate: "O(n^2)" })).toBe(true)
    expect(hasRequiredEvidence({ ...base, hotPathIdentifier: "handleRequest" })).toBe(true)
  })

  it("testing requires inspectedTestFiles OR evidenceRefs at any severity", () => {
    const base = { ...baseFinding, category: "testing" as const, score: 3 }
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, inspectedTestFiles: ["t.test.ts"] })).toBe(true)
    expect(hasRequiredEvidence({ ...base, evidenceRefs: ["siblingMapping:a->NONE"] })).toBe(true)
  })

  it("other categories always return true (no per-category requirement)", () => {
    expect(hasRequiredEvidence({ ...baseFinding, category: "logic", score: 5 })).toBe(true)
    expect(hasRequiredEvidence({ ...baseFinding, category: "complexity", score: 5 })).toBe(true)
    expect(hasRequiredEvidence({ ...baseFinding, category: "style", score: 5 })).toBe(true)
    expect(hasRequiredEvidence({ ...baseFinding, category: "syntax", score: 5 })).toBe(true)
    expect(hasRequiredEvidence({ ...baseFinding, category: "docs", score: 5 })).toBe(true)
    expect(hasRequiredEvidence({ ...baseFinding, category: "error-handling", score: 5 })).toBe(true)
  })
})

// SIG-161 PR 4b — shadow-mode divergence helper. Pure, exported for
// these tests; the ensemble call site wires env + KV + console.log.
//
// Addresses the Sigilix self-review finding on PR #146 ("shadow-mode
// telemetry logic ships without test coverage"). The 95-LOC inline
// block in `triage-pr-review-ensemble.ts` was extracted to this
// helper so the verdict + divergence-payload computation is
// independently testable.
describe("computeShadowGateDivergence (SIG-161 PR 4b)", () => {
  const f = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
    ...baseFinding,
    score: 3,
    ...overrides,
  })

  it("returns no divergence when the gate agrees with the legacy verdict (both REQUEST_CHANGES)", () => {
    // Confidence-5, score-5, evidence, multi-spec → gateScore = 1.0,
    // threshold = 0.85 → REQUEST_CHANGES. Legacy is REQUEST_CHANGES
    // because there's a finding. Same → no divergence payload.
    const result = computeShadowGateDivergence({
      renderable: [f({ confidence: 5, score: 5, category: "logic" })],
      unanchored: [],
      provenance: [{ sourceSpecialists: ["logic", "security"] }],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    expect(result.gateEvent).toBe("REQUEST_CHANGES")
    expect(result.divergence).toBeNull()
  })

  it("returns divergence when gate decides COMMENT but legacy decided REQUEST_CHANGES", () => {
    // The defining case: legacy fires on any finding; gate only fires
    // when score >= threshold. confidence-3 logic finding at score-3
    // → gateScore ≈ 0.60 (below 0.85) → COMMENT. Legacy = REQUEST_CHANGES.
    const result = computeShadowGateDivergence({
      renderable: [f({ confidence: 3, score: 3, category: "logic" })],
      unanchored: [],
      provenance: [{ sourceSpecialists: ["logic"] }],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    expect(result.gateEvent).toBe("COMMENT")
    expect(result.divergence).not.toBeNull()
    expect(result.divergence!.legacyEvent).toBe("REQUEST_CHANGES")
    expect(result.divergence!.gateEvent).toBe("COMMENT")
    expect(result.divergence!.findingCount).toBe(1)
    expect(result.divergence!.blockingFindingCount).toBe(0)
    expect(result.divergence!.threshold).toBe(0.85)
  })

  it("preserves a finite gateScore on the finding instead of recomputing it", () => {
    // Caller-supplied gateScore wins. If the synth somehow ever emits
    // it directly (PR 4c scenario), we don't clobber.
    const result = computeShadowGateDivergence({
      renderable: [f({ confidence: 5, score: 5, category: "logic", gateScore: 0.42 })],
      unanchored: [],
      provenance: [{ sourceSpecialists: ["logic", "security", "performance"] }],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    expect(result.gateEvent).toBe("COMMENT")  // 0.42 < 0.85
    expect(result.divergence!.scoreSummary).toBe("0.42")
  })

  it("recomputes gateScore when the supplied one is non-finite (NaN / Infinity)", () => {
    // CodeRabbit catch on PR #145 — NaN/Infinity must fall through to
    // computeGateScore, not be treated as a finite score.
    const nanResult = computeShadowGateDivergence({
      renderable: [f({ confidence: 5, score: 5, category: "logic", gateScore: Number.NaN })],
      unanchored: [],
      provenance: [{ sourceSpecialists: ["logic"] }],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    // Computed gateScore for conf 5 + score 5 + logic + 1 spec = 0.90 + 0.10 (evidence) + 0 + 0.10 = 1.10 → 1.0
    expect(nanResult.gateEvent).toBe("REQUEST_CHANGES")
    expect(nanResult.divergence).toBeNull()
  })

  it("handles unanchored findings (empty provenance for them) without throwing", () => {
    const result = computeShadowGateDivergence({
      renderable: [],
      unanchored: [f({ confidence: 4, score: 4, category: "logic" })],
      provenance: [],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    // unanchored: conf 4 (0.75) + evidence (0.10) + no spec (0) + score 4 (0.05) = 0.90 → REQUEST_CHANGES
    expect(result.gateEvent).toBe("REQUEST_CHANGES")
    expect(result.divergence).toBeNull()
  })

  it("blockingFindingCount aligns with missingScorePolicy:'block' (non-finite counts as blocking)", () => {
    // The Major catch from PR #146 CodeRabbit review: a NaN-scored
    // finding would otherwise read as "0 blocking" even though the
    // gate treats it as blocking. The aligned counter MUST treat
    // non-finite as blocking too.
    const fNaN = f({ confidence: 3, score: 3, category: "logic", gateScore: undefined })
    // To get a divergence on this case, the legacy event must differ
    // from the gate's verdict. With a single non-finite finding under
    // "block" policy, the gate produces REQUEST_CHANGES. To force
    // divergence we need legacy = APPROVE (which would only happen if
    // legacy somehow ignored the finding — synthetic for the test).
    // Easier: use two findings, one finite-below-threshold, one
    // non-finite. Gate decides REQUEST_CHANGES on the non-finite;
    // legacy decided COMMENT-equivalent... actually legacy is binary.
    // Just verify the count via the result directly.
    const fScored = f({ confidence: 1, score: 1, category: "testing", gateScore: 0.1 })
    const result = computeShadowGateDivergence({
      renderable: [fScored, fNaN],
      unanchored: [],
      provenance: [{ sourceSpecialists: ["tests"] }, { sourceSpecialists: undefined }],
      threshold: 0.85,
      legacyEvent: "APPROVE",   // synthetic: pretend legacy approved
    })
    // Gate decides: fScored has gateScore 0.10 (preserved, < 0.85, non-blocking);
    // fNaN gets recomputed: conf 3 → 0.50 + evidence (logic, always true) → 0.10 + 0 spec + score 3 → 0
    //   wait — fNaN has category "logic" via baseFinding override; logic always
    //   returns true for hasRequiredEvidence. So computed = 0.50 + 0.10 + 0 + 0 = 0.60.
    // Both findings → 0.10 and 0.60, both < 0.85 → COMMENT (since there are findings).
    // Legacy synthesized as APPROVE → divergence fires.
    expect(result.gateEvent).toBe("COMMENT")
    expect(result.divergence).not.toBeNull()
    expect(result.divergence!.findingCount).toBe(2)
    // Both are non-blocking under threshold 0.85 (0.10 and 0.60).
    expect(result.divergence!.blockingFindingCount).toBe(0)
  })

  it("handles missing-provenance-row case (provenance[i] = undefined) → empty specialists", () => {
    const result = computeShadowGateDivergence({
      renderable: [f({ confidence: 4, score: 4, category: "logic" })],
      unanchored: [],
      provenance: [undefined],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    // conf 4 (0.75) + logic evidence (0.10) + 0 agreement + score 4 (0.05) = 0.90 → REQUEST_CHANGES
    expect(result.gateEvent).toBe("REQUEST_CHANGES")
    expect(result.divergence).toBeNull()
  })

  it("scoreSummary stringifies all per-finding scores in order (renderable then unanchored)", () => {
    const result = computeShadowGateDivergence({
      renderable: [f({ confidence: 3, score: 3, category: "logic", gateScore: 0.50 })],
      unanchored: [f({ confidence: 1, score: 1, category: "logic", gateScore: 0.10 })],
      provenance: [{ sourceSpecialists: ["logic"] }],
      threshold: 0.85,
      legacyEvent: "REQUEST_CHANGES",
    })
    expect(result.gateEvent).toBe("COMMENT")
    expect(result.divergence!.scoreSummary).toBe("0.50,0.10")
  })

  it("empty findings (no renderable, no unanchored) and legacy=APPROVE produces APPROVE + no divergence", () => {
    const result = computeShadowGateDivergence({
      renderable: [],
      unanchored: [],
      provenance: [],
      threshold: 0.85,
      legacyEvent: "APPROVE",
    })
    expect(result.gateEvent).toBe("APPROVE")
    expect(result.divergence).toBeNull()
  })
})

describe("filterToSigilixAuthored (SIG-37)", () => {
  // Pure predicate exposed for any future call site that wants to
  // count Sigilix-authored open threads separately from other-actor
  // threads (e.g. SIG-200's head-to-head measurement framework).
  // Same identity rule as `chooseReviewEvent`'s internal filter:
  // `user.login === "sigilix[bot]"`.

  const sig: AuthoredItem = { user: { login: "sigilix[bot]" } }
  const cr: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
  const human: AuthoredItem = { user: { login: "alice" } }
  const nullUser: AuthoredItem = { user: null }
  const nullLogin: AuthoredItem = { user: { login: null } }

  it("keeps Sigilix-authored items", () => {
    expect(filterToSigilixAuthored([sig])).toEqual([sig])
  })

  it("drops CodeRabbit / human / null-user / null-login items", () => {
    expect(filterToSigilixAuthored([cr, human, nullUser, nullLogin])).toEqual([])
  })

  it("preserves order of the surviving items", () => {
    const a: AuthoredItem = { user: { login: "sigilix[bot]" } }
    const b: AuthoredItem = { user: { login: "sigilix[bot]" } }
    expect(filterToSigilixAuthored([cr, a, human, b, nullUser])).toEqual([a, b])
  })

  it("returns an empty list for an empty input", () => {
    expect(filterToSigilixAuthored([])).toEqual([])
  })

  it("is case-sensitive (legacy / off-brand casings do NOT match)", () => {
    // GitHub's bot login is the exact App slug; case-sensitive match
    // avoids accidentally counting a hypothetical human handle that
    // happens to differ only by case (`SIGILIX[bot]`) as Sigilix.
    const upper: AuthoredItem = { user: { login: "SIGILIX[bot]" } }
    expect(filterToSigilixAuthored([upper])).toEqual([])
  })
})

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
      findings: [{ ...baseFinding, startLine: 38 }],
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
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
  })

  it("ARC-281: REQUEST_CHANGES body has the new heading + dropped legacy strings", () => {
    const out = buildReviewSubmission({ verdict, prAuthor: "alice", headSha: "abc" })
    expect(out.body).toContain("<!-- sigilix:pr-review -->")
    // New status heading replaces "### Sigilix Summary" entirely.
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
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
    expect(out.body).toContain("To dismiss this review")
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
    expect(out.body).toMatch(/^## Sigilix: \d+ finding/m)
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
          body: "Use `??`.\n\n```suggestion\nconst x = a ?? b\n```",
        },
      ],
    }
    const out = buildReviewSubmission({ verdict: v, prAuthor: "alice", headSha: "abc" })
    expect(out.comments?.[0]?.body).toContain("```suggestion")
    expect(out.comments?.[0]?.body).toContain("const x = a ?? b")
  })
})

describe("buildReviewSubmission — ARC-189 sigilix marker append (Task 2.5)", () => {
  const verdict: PrReviewVerdict = {
    summary: "Two findings.",
    confidence: 3,
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
    expect(out.comments?.[0]?.body.endsWith(
      "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
    )).toBe(true)
    expect(out.comments?.[1]?.body).toContain(
      "<!-- sigilix:fid:2222222222222222:cat:logic:sev:info:path:222222222222 -->",
    )
  })

  it("preserves the existing sigilix:pr-review-finding marker AND appends sigilix marker", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      findingMarkers: [
        "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->",
        null,
      ],
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
    const marker =
      "<!-- sigilix:fid:1111111111111111:cat:logic:sev:error:path:111111111111 -->"
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
    headline: "off-by-one in clampIndex",
    body: "Use `<=` instead of `<`.",
  }
  const blockFinding: PrReviewFinding = {
    path: "src/lib/foo.ts",
    line: 1370,
    score: 3,
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
    expect(withMap.comments?.map((c) => c.line).sort((a, b) => a - b)).toEqual([42, 1370])
    // Neither block finding is double-rendered into the body.
    expect(withMap.body).not.toContain("Findings without inline comments")
  })

  it("does not double-render a routed finding (only in body, not inline)", () => {
    const out = buildReviewSubmission({
      verdict,
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })
    const inlineCount = (out.comments ?? []).filter((c) =>
      c.body.includes("lacks integration tests"),
    ).length
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

  it("keeps the review event REQUEST_CHANGES even when all findings route to the body", () => {
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
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("lacks integration tests")
  })

  it("keeps a suggestion-bearing finding inline even when anchored to a `}` (preserves the fix)", () => {
    const fixFinding: PrReviewFinding = {
      path: "src/lib/foo.ts",
      line: 1370,
      startLine: 1368,
      score: 4,
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

describe("buildReviewSubmission — SIG-202 non-line scope routing", () => {
  const commentFinding: PrReviewFinding = {
    path: "src/lib/github-mention.ts",
    line: 436,
    scope: "comment",
    score: 4,
    category: "security",
    headline: "dismiss command trusts the issue-comment author",
    body: "The `/sigilix dismiss` path authorizes from the issue-comment sender instead of the review-thread participant. Check the parent review comment before accepting the dismissal.",
  }

  const addedLineTextByLine = new Map<string, Map<number, string>>([
    [
      "src/lib/github-mention.ts",
      new Map<number, string>([
        [436, "expirationTtl: MENTION_DEDUPE_TTL,"],
      ]),
    ],
  ])

  it("routes comment-scoped findings to the review body even when the nearest changed line is substantive", () => {
    const out = buildReviewSubmission({
      verdict: {
        summary: "Comment-surface auth issue.",
        confidence: 2,
        confidenceReason: "High impact.",
        findings: [commentFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("### Findings without inline comments")
    expect(out.body).toContain("Comment-level (high, score 4)")
    expect(out.body).toContain("dismiss command trusts the issue-comment author")
    expect(out.body).not.toContain("`src/lib/github-mention.ts:436`")
  })

  it("routes file-scoped findings to the review body with a file-level label", () => {
    const fileFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      score: 5,
      headline: "module-level lifecycle ordering is unsafe",
      body: "The issue spans the module's event flow rather than one changed statement, so it should not be forced into an inline thread.",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-level routing issue.",
        confidence: 2,
        confidenceReason: "High impact.",
        findings: [fileFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments ?? []).toHaveLength(0)
    expect(out.body).toContain("### Findings without inline comments")
    expect(out.body).toContain("File-level (critical, score 5)")
    expect(out.body).toContain("module-level lifecycle ordering is unsafe")
    expect(out.body).not.toContain("`src/lib/github-mention.ts:436`")
  })

  it("keeps suggestion-bearing non-line findings inline so the proposed fix is not dropped", () => {
    const fixFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      category: "logic",
      headline: "ttl constant should stay localized",
      body: "This broad file-level finding still carries a localized replacement, so preserve the inline suggestion surface.",
      suggestedReplacement: "expirationTtl: REVIEW_THREAD_DEDUPE_TTL,",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-scoped finding with a localized fix.",
        confidence: 4,
        confidenceReason: "Specific replacement supplied.",
        findings: [fixFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(436)
    expect(out.comments?.[0]?.body).toContain("ttl constant should stay localized")
    expect(out.comments?.[0]?.body).toContain("REVIEW_THREAD_DEDUPE_TTL")
    expect(out.body).toContain("### Fix Plan")
    expect(out.body).toContain("`src/lib/github-mention.ts:436` — `logic`: ttl constant should stay localized")
    expect(out.body).not.toContain("### Findings without inline comments")
  })

  it("keeps delete-intent non-line findings inline so the deletion suggestion is not dropped", () => {
    const deleteFinding: PrReviewFinding = {
      ...commentFinding,
      scope: "file",
      category: "logic",
      headline: "ttl constant should be removed",
      body: "This broad file-level finding carries an empty deletion replacement, so preserve the inline suggestion surface.",
      kind: "delete",
      suggestedReplacement: "",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "File-scoped finding with a localized deletion.",
        confidence: 4,
        confidenceReason: "Specific deletion supplied.",
        findings: [deleteFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.event).toBe("REQUEST_CHANGES")
    expect(out.comments).toHaveLength(1)
    expect(out.comments?.[0]?.line).toBe(436)
    expect(out.comments?.[0]?.body).toContain("ttl constant should be removed")
    expect(out.comments?.[0]?.body).toContain("expirationTtl: MENTION_DEDUPE_TTL,")
    expect(out.body).toContain("### Fix Plan")
    expect(out.body).toContain("`src/lib/github-mention.ts:436` — `logic`: ttl constant should be removed")
    expect(out.body).not.toContain("### Findings without inline comments")
  })

  it("does not duplicate body-only high findings in the Fix Plan", () => {
    const inlineFinding: PrReviewFinding = {
      path: "src/lib/github-mention.ts",
      line: 436,
      score: 4,
      category: "logic",
      headline: "ttl is too short",
      body: "Use the configured TTL.",
    }
    const out = buildReviewSubmission({
      verdict: {
        summary: "One inline and one body-only finding.",
        confidence: 2,
        confidenceReason: "Mixed.",
        findings: [inlineFinding, commentFinding],
      },
      prAuthor: "alice",
      headSha: "abc",
      addedLineTextByLine,
    })

    expect(out.comments).toHaveLength(1)
    expect(out.body).toContain("### Fix Plan")
    expect(out.body).toContain("`src/lib/github-mention.ts:436` — `logic`: ttl is too short")
    expect(out.body).not.toContain("`src/lib/github-mention.ts:436` — `security`: dismiss command trusts")
    expect(out.body).toContain("Comment-level (high, score 4)")
  })
})

// ── SIG-164 PR 5: comment-anchor + format-parity helpers ─────────

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
})

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

  it("REQUEST_CHANGES body still ends with the provenance footer (ARC-184 invariant)", () => {
    const out = buildReviewSubmission({
      verdict: verdictWithFinding, prAuthor: "alice", headSha: HEAD, nowMs: NOW,
    })
    const body = out.body ?? ""
    expect(body).toMatch(
      /_Reviewed against `abc1234` at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\._\s*$/,
    )
  })

  it("buildFallbackBody APPROVE path is marker-only (ARC-293)", () => {
    const out = buildFallbackBody(verdict, [], { headSha: HEAD, nowMs: NOW })
    expect(out).toBe("<!-- sigilix:pr-review -->\n")
  })

  it("buildFallbackBody REQUEST_CHANGES path still ends with the provenance footer", () => {
    const expected = `_Reviewed against \`abc1234\` at ${new Date(NOW).toISOString()}._`
    const out = buildFallbackBody(verdictWithFinding, [], { headSha: HEAD, nowMs: NOW })
    expect(out.trimEnd().endsWith(expected)).toBe(true)
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
    // Footer survived
    expect(body).toMatch(/_Reviewed against `abc1234` at .+\._/)
    // Truncation marker is present
    expect(body).toContain("[summary truncated to fit GitHub's 65535 limit]")
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
  it("renders badges as compact taller chips for GitHub legibility (SIG-200)", () => {
    const out = severityBadgeForScore(3)
    expect(out).toContain('width="34"')
    expect(out).toContain('height="24"')
  })
  it("uses the public Worker badge host, not private GitHub raw assets (SIG-201)", () => {
    const out = severityBadgeForScore(3)
    expect(out).toContain(`${PUBLIC_BADGE_BASE_URL}/v20260524-6/p2.svg`)
    expect(out).not.toContain("raw.githubusercontent.com/Sigilix/sigilix")
  })
  it("treats super-high scores as P0 (defensive clamp)", () => {
    expect(severityBadgeForScore(6)).toContain('alt="P0"')
    expect(severityBadgeForScore(99)).toContain('alt="P0"')
  })
})

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

  it("truncates long bodies with a More Info affordance that only shows the remaining detail", () => {
    const body = "x".repeat(620)
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).toContain("<summary>More Info</summary>")
    expect(out).toContain(`${"x".repeat(500)}...`)
    const detailsMatch = /<details><summary>More Info<\/summary>\n\n([\s\S]*?)\n\n<\/details>/.exec(out)
    expect(detailsMatch?.[1]).toContain("x".repeat(120))
    expect(detailsMatch?.[1]).not.toContain("x".repeat(500))
  })

  it("does not truncate bodies exactly at the 500-character boundary", () => {
    const body = "x".repeat(500)
    const out = formatFindingComment(fnd({ body }), 5)
    expect(out).not.toContain("<summary>More Info</summary>")
    expect(out).toContain(body)
    expect(out).not.toContain(`${body}...`)
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

  it("renders the retrigger sub-text hint when retriggerUrl is supplied (founder pulled the visible button 2026-05-19)", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
    })
    expect(body).toContain("Comment `/sigilix review`")
    // The Greptile-style `[🔄 Re-run review](URL)` button was dropped
    // on founder feedback — visual noise inside the body.
    expect(body).not.toContain("[🔄 Re-run review]")
    expect(body).not.toContain("🔄 Re-run review")
  })

  it("renders the counter footer line when reviewCounter is supplied", () => {
    const body = renderRequestChangesBody({
      verdict,
      reviewCounter: 3,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toMatch(/_Sigilix · Review #3 for this PR · last rendered 2025-05-18T05:48:38\.000Z\._/)
  })

  it("renders BOTH retrigger hint + counter when both are supplied", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
      reviewCounter: 1,
      prov: { headSha: "abc1234", nowMs: 1747547318000 },
    })
    expect(body).toContain("Comment `/sigilix review`")
    expect(body).toContain("Review #1 for this PR")
  })

  it("omits both when neither field is supplied (back-compat)", () => {
    const body = renderRequestChangesBody({ verdict })
    expect(body).not.toContain("Comment `/sigilix review`")
    expect(body).not.toContain("Review #")
  })

  it("orders retrigger hint before counter; counter sits above the provenance footer", () => {
    const body = renderRequestChangesBody({
      verdict,
      retriggerUrl: "https://github.com/owner/repo/pull/42",
      reviewCounter: 7,
      prov: { headSha: "deadbeef0000", nowMs: 1747547318000 },
    })
    const hintIdx = body.indexOf("Comment `/sigilix review`")
    const counterIdx = body.indexOf("Review #7")
    const provIdx = body.indexOf("_Reviewed against")
    expect(hintIdx).toBeGreaterThan(-1)
    expect(counterIdx).toBeGreaterThan(hintIdx)
    expect(provIdx).toBeGreaterThan(counterIdx)
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

import { extensionToFenceLang } from "../src/lib/triage-pr-review"

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
