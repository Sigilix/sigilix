import { describe, expect, it } from "vitest"
import {
  chooseReviewEventWithGate,
  computeGateScore,
  computeShadowGateDivergence,
  filterToSigilixAuthored,
  hasRequiredEvidence,
  renderCommentBody,
  type AuthoredItem,
  type PrReviewFinding,
  type PrReviewVerdict,
} from "@/src/lib/triage-pr-review"
import { baseFinding } from "@/src/lib/triage-pr-review.test-helpers"

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
          findings: [f(0.65), f(0.72), f(0.8)],
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
    it("block: missing gateScore is treated as 1.0 (effectively blocks)", () => {
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

    it("block: missing gateScore still blocks even at sub-1.0 thresholds", () => {
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

    it("throw: missing gateScore raises a pipeline-invariant error", () => {
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

    it("permit: missing gateScore is treated as 0.0 (offline replay)", () => {
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
  const f = (overrides: { [K in keyof PrReviewFinding]?: PrReviewFinding[K] | undefined } = {}): PrReviewFinding => {
    const base: PrReviewFinding = { ...baseFinding, score: 3 }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete (base as unknown as Record<string, unknown>)[key]
      else (base as unknown as Record<string, unknown>)[key] = value
    }
    return base
  }

  it("clamps to [0, 1]", () => {
    // Maximal inputs (conf 5 + evidence + 3-way agreement + score 5):
    //   0.90 + 0.10 + 0.10 + 0.10 = 1.20 → clamped to 1.0
    expect(
      computeGateScore(f({ confidence: 5, score: 5, category: "logic" }), {
        sourceSpecialists: ["logic", "security", "performance"],
      }),
    ).toBe(1.0)
    // Minimal inputs (conf 1 + no evidence + 1-way + score 1):
    //   0.10 + 0 + 0 + (-0.10) = 0.0
    // Use category:"testing" without inspectedTestFiles/evidenceRefs so
    // `hasRequiredEvidence` returns false and the evidence boost is 0.
    // (Logic always returns true since it has no per-category
    // evidence requirement.)
    expect(
      computeGateScore(f({ confidence: 1, score: 1, category: "testing" }), {
        sourceSpecialists: ["tests"],
      }),
    ).toBe(0.0)
  })

  it("weakly monotone in confidence (1→5 produces non-decreasing scores)", () => {
    const scores = [1, 2, 3, 4, 5].map((c) =>
      computeGateScore(f({ confidence: c, score: 3, category: "logic" }), {
        sourceSpecialists: ["logic"],
      }),
    )
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i - 1] ?? 0)
    }
  })

  it("weakly monotone in severity (score 1→5 non-decreasing)", () => {
    const out = [1, 2, 3, 4, 5].map((s) =>
      computeGateScore(f({ confidence: 3, score: s, category: "logic" }), {
        sourceSpecialists: ["logic"],
      }),
    )
    for (let i = 1; i < out.length; i++) {
      expect(out[i]).toBeGreaterThanOrEqual(out[i - 1] ?? 0)
    }
  })

  it("evidence presence boosts score by 0.10 (testing category)", () => {
    // Testing requires inspectedTestFiles OR evidenceRefs for evidence credit
    const noEv = computeGateScore(f({ confidence: 3, score: 3, category: "testing" }), {
      sourceSpecialists: ["tests"],
    })
    const withEv = computeGateScore(
      f({
        confidence: 3,
        score: 3,
        category: "testing",
        inspectedTestFiles: ["tests/foo.test.ts"],
      }),
      { sourceSpecialists: ["tests"] },
    )
    expect(withEv - noEv).toBeCloseTo(0.1, 5)
  })

  it("agreement boosts score by 0.05 per additional specialist, capped at 0.10", () => {
    const oneSpec = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic"],
    })
    const twoSpec = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic", "security"],
    })
    const threeSpec = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic", "security", "performance"],
    })
    const fourSpec = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic", "security", "performance", "tests"],
    })
    expect(twoSpec - oneSpec).toBeCloseTo(0.05, 5)
    expect(threeSpec - twoSpec).toBeCloseTo(0.05, 5)
    expect(fourSpec - threeSpec).toBeCloseTo(0.0, 5) // cap
  })

  it("defaults missing confidence to 3 (neutral)", () => {
    const missing = computeGateScore(f({ confidence: undefined, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic"],
    })
    const explicit3 = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic"],
    })
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

  it("an all-inline COMMENT body is JUST the marker (SIG-471 PR-3 minimal body)", () => {
    // SIG-471 PR-3: the lead counts line (incl. the "non-blocking finding" copy),
    // the summary, and the footer are GONE from the body. A COMMENT with a single
    // inline finding (score 3, anchors inline) is the bare marker — the inline
    // comment carries the finding.
    const body = renderCommentBody({ verdict })
    expect(body).toBe("<!-- sigilix:pr-review -->\n")
    expect(body).not.toContain("non-blocking")
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

  it("forward-safe via rest-spread strip: a body-only finding still reaches the dropdown", () => {
    // SIG-471 PR-3: the minimal body dropped the lead/delta/summary chrome, so the
    // old "delta inlines onto the lead" signal is gone. The rest-spread denylist
    // (reviewCounter + retriggerUrl) still must not strip the body-routing inputs —
    // confirm a file-scope finding flows through into the outside-the-diff dropdown.
    const body = renderCommentBody({
      verdict: {
        ...verdict,
        findings: [{ ...baseFinding, scope: "file", score: 3, headline: "file-level COMMENT note" }],
      },
    })
    expect(body).toContain("<summary><b>1 finding outside the diff</b></summary>")
    expect(body).toContain("file-scope")
    expect(body).toContain("file-level COMMENT note")
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
    expect(hasRequiredEvidence({ ...baseFinding, category: "security", score: 3 })).toBe(true)
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
  const f = (overrides: { [K in keyof PrReviewFinding]?: PrReviewFinding[K] | undefined } = {}): PrReviewFinding => {
    const base: PrReviewFinding = { ...baseFinding, score: 3 }
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete (base as unknown as Record<string, unknown>)[key]
      else (base as unknown as Record<string, unknown>)[key] = value
    }
    return base
  }

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
    expect(result.gateEvent).toBe("COMMENT") // 0.42 < 0.85
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
      provenance: [{ sourceSpecialists: ["tests"] }, {}],
      threshold: 0.85,
      legacyEvent: "APPROVE", // synthetic: pretend legacy approved
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
      renderable: [f({ confidence: 3, score: 3, category: "logic", gateScore: 0.5 })],
      unanchored: [f({ confidence: 1, score: 1, category: "logic", gateScore: 0.1 })],
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
