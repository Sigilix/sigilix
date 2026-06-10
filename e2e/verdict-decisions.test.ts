// SIG-361 (PR 9) — behavior pin for the review-VERDICT decision logic
// (event selection · gate scoring · score→severity policy) BEFORE it is
// reunited from the two god-files into `ensemble/domain/verdict.ts`. These
// tests import from the CURRENT public paths (`triage-pr-review` +
// `triage-pr-review-ensemble`) and assert OBSERVABLE outputs only — no spies,
// no module-identity checks — so they survive the move through the re-export
// shims unchanged and would fail if any decision semantics drifted.

import { describe, expect, it } from "vitest"
import {
  chooseReviewEvent,
  chooseReviewEventForRenderedFindings,
  chooseRenderedEventWithOverride,
  chooseReviewEventWithGate,
  computeGateScore,
  computeShadowGateDivergence,
  hasRequiredEvidence,
  severityLabelForScore,
  type AuthoredItem,
  type PrReviewFinding,
} from "@/src/lib/triage-pr-review"
import {
  resolveReviewEventOverride,
  LOW_CONFIDENCE_COMMENT_THRESHOLD,
} from "@/src/lib/triage-pr-review-ensemble"
import { severityTierForScore } from "./_golden/validation-matrix-cases"

const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 3,
  headline: "missing null guard on `user.profile`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
}
const f = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
  ...baseFinding,
  ...overrides,
})

const sigilixItem: AuthoredItem = { user: { login: "sigilix[bot]" } }
const crItem: AuthoredItem = { user: { login: "coderabbitai[bot]" } }
const humanItem: AuthoredItem = { user: { login: "alice" } }

// ─── 1) chooseReviewEventForRenderedFindings ───────────────────────────
describe("chooseReviewEventForRenderedFindings (final rendered-surface gate)", () => {
  it("APPROVE when nothing renders", () => {
    expect(
      chooseReviewEventForRenderedFindings({ inlineFindings: [], bodyOnlyFindings: [] }),
    ).toBe("APPROVE")
  })

  it("APPROVE when the only findings are out-of-PR-scope (informational)", () => {
    const outside = f({ score: 5, outOfPrScope: true })
    expect(
      chooseReviewEventForRenderedFindings({ inlineFindings: [], bodyOnlyFindings: [outside] }),
    ).toBe("APPROVE")
  })

  it("COMMENT when the only in-scope findings are testing-category, even at score 5", () => {
    const testing = f({ category: "testing", score: 5 })
    expect(
      chooseReviewEventForRenderedFindings({ inlineFindings: [testing], bodyOnlyFindings: [] }),
    ).toBe("COMMENT")
  })

  it("COMMENT for a truly trivial style/docs nit below P0/P1", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [],
        bodyOnlyFindings: [f({ category: "style", score: 2 }), f({ category: "docs", score: 3 })],
      }),
    ).toBe("COMMENT")
  })

  it("REQUEST_CHANGES when a style finding reaches score 4 (P1 is never trivial)", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [],
        bodyOnlyFindings: [f({ category: "style", score: 4 })],
      }),
    ).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES for a logic finding at any score", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [f({ category: "logic", score: 1 })],
        bodyOnlyFindings: [],
      }),
    ).toBe("REQUEST_CHANGES")
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [],
        bodyOnlyFindings: [f({ category: "logic", score: 5 })],
      }),
    ).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES for a security finding at any score", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [f({ category: "security", score: 2 })],
        bodyOnlyFindings: [],
      }),
    ).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES on a Sigilix-authored open item even with zero findings", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [],
        bodyOnlyFindings: [],
        openItems: [sigilixItem],
      }),
    ).toBe("REQUEST_CHANGES")
  })

  it("ignores a non-Sigilix open item (stays APPROVE)", () => {
    expect(
      chooseReviewEventForRenderedFindings({
        inlineFindings: [],
        bodyOnlyFindings: [],
        openItems: [crItem, humanItem],
      }),
    ).toBe("APPROVE")
  })
})

// ─── 2) chooseRenderedEventWithOverride ─────────────────────────────────
describe("chooseRenderedEventWithOverride (override discipline)", () => {
  const clean = { inlineFindings: [] as PrReviewFinding[], bodyOnlyFindings: [] as PrReviewFinding[] }
  const blocking = { inlineFindings: [f({ category: "logic", score: 4 })], bodyOnlyFindings: [] }

  it("REQUEST_CHANGES override always wins (even over a clean base)", () => {
    expect(chooseRenderedEventWithOverride(clean, "REQUEST_CHANGES")).toBe("REQUEST_CHANGES")
    expect(chooseRenderedEventWithOverride(blocking, "REQUEST_CHANGES")).toBe("REQUEST_CHANGES")
  })

  it("COMMENT override downgrades APPROVE only", () => {
    expect(chooseRenderedEventWithOverride(clean, "COMMENT")).toBe("COMMENT")
  })

  it("COMMENT override never weakens a REQUEST_CHANGES base", () => {
    expect(chooseRenderedEventWithOverride(blocking, "COMMENT")).toBe("REQUEST_CHANGES")
  })

  it("undefined override returns the base decision unchanged", () => {
    expect(chooseRenderedEventWithOverride(clean)).toBe("APPROVE")
    expect(chooseRenderedEventWithOverride(blocking)).toBe("REQUEST_CHANGES")
  })
})

// ─── 3) chooseReviewEvent (legacy two-state) ────────────────────────────
describe("chooseReviewEvent (legacy two-state verdict)", () => {
  it("APPROVE on empty findings", () => {
    expect(chooseReviewEvent([])).toBe("APPROVE")
  })

  it("REQUEST_CHANGES on any finding present", () => {
    expect(chooseReviewEvent([f({ score: 1 })])).toBe("REQUEST_CHANGES")
  })

  it("REQUEST_CHANGES on a Sigilix-authored open item with zero findings", () => {
    expect(chooseReviewEvent([], [sigilixItem])).toBe("REQUEST_CHANGES")
  })

  it("APPROVE on a non-Sigilix open item with zero findings", () => {
    expect(chooseReviewEvent([], [crItem, humanItem])).toBe("APPROVE")
  })
})

// ─── 4) chooseReviewEventWithGate (thresholded gate × missingScorePolicy) ─
describe("chooseReviewEventWithGate (thresholded gate)", () => {
  const fg = (gateScore: number | undefined, score = 3): PrReviewFinding => ({
    ...baseFinding,
    score,
    ...(gateScore !== undefined ? { gateScore } : {}),
  })

  it("APPROVE on empty findings + empty open items", () => {
    expect(
      chooseReviewEventWithGate({ findings: [], threshold: 0.85, missingScorePolicy: "permit" }),
    ).toBe("APPROVE")
  })

  it("REQUEST_CHANGES when a finite gateScore clears the threshold", () => {
    expect(
      chooseReviewEventWithGate({ findings: [fg(0.95)], threshold: 0.85, missingScorePolicy: "permit" }),
    ).toBe("REQUEST_CHANGES")
  })

  it("COMMENT when a finite gateScore is below threshold (finding present, none blocking)", () => {
    expect(
      chooseReviewEventWithGate({ findings: [fg(0.7)], threshold: 0.85, missingScorePolicy: "permit" }),
    ).toBe("COMMENT")
  })

  it("threshold boundary is inclusive: gateScore === threshold blocks", () => {
    expect(
      chooseReviewEventWithGate({ findings: [fg(0.85)], threshold: 0.85, missingScorePolicy: "permit" }),
    ).toBe("REQUEST_CHANGES")
  })

  describe("missing gateScore × policy", () => {
    it("block: treats missing as 1.0 → REQUEST_CHANGES", () => {
      expect(
        chooseReviewEventWithGate({ findings: [fg(undefined)], threshold: 0.85, missingScorePolicy: "block" }),
      ).toBe("REQUEST_CHANGES")
    })

    it("permit: treats missing as 0.0 → COMMENT (finding present, non-blocking)", () => {
      expect(
        chooseReviewEventWithGate({ findings: [fg(undefined)], threshold: 0.85, missingScorePolicy: "permit" }),
      ).toBe("COMMENT")
    })

    it("throw: a missing gateScore is a pipeline-invariant failure", () => {
      expect(() =>
        chooseReviewEventWithGate({ findings: [fg(undefined)], threshold: 0.85, missingScorePolicy: "throw" }),
      ).toThrow()
    })
  })

  describe("non-finite gateScore is treated as missing (routes through policy)", () => {
    it("NaN under block → REQUEST_CHANGES", () => {
      expect(
        chooseReviewEventWithGate({ findings: [fg(Number.NaN)], threshold: 0.85, missingScorePolicy: "block" }),
      ).toBe("REQUEST_CHANGES")
    })

    it("Infinity under permit → COMMENT (not auto-blocking)", () => {
      expect(
        chooseReviewEventWithGate({
          findings: [fg(Number.POSITIVE_INFINITY)],
          threshold: 0.85,
          missingScorePolicy: "permit",
        }),
      ).toBe("COMMENT")
    })

    it("NaN under throw → throws", () => {
      expect(() =>
        chooseReviewEventWithGate({ findings: [fg(Number.NaN)], threshold: 0.85, missingScorePolicy: "throw" }),
      ).toThrow()
    })
  })

  it("REQUEST_CHANGES on a Sigilix open item even when no finding blocks", () => {
    expect(
      chooseReviewEventWithGate({
        findings: [fg(0.5)],
        threshold: 0.85,
        openItems: [sigilixItem],
        missingScorePolicy: "permit",
      }),
    ).toBe("REQUEST_CHANGES")
  })
})

// ─── 5) computeGateScore (deterministic blend) ──────────────────────────
describe("computeGateScore (deterministic 0-1 blend)", () => {
  it("maps confidence 1-5 to the conservative rescale (score 3 neutral, logic, 1 spec)", () => {
    // conf rescale: 1→0.10, 2→0.30, 3→0.50, 4→0.75, 5→0.90; logic evidence +0.10;
    // score 3 severity +0; 1 spec agreement +0.
    const at = (confidence: number) =>
      computeGateScore(f({ confidence, score: 3, category: "logic" }), { sourceSpecialists: ["logic"] })
    expect(at(1)).toBeCloseTo(0.20, 5)
    expect(at(2)).toBeCloseTo(0.40, 5)
    expect(at(3)).toBeCloseTo(0.60, 5)
    expect(at(4)).toBeCloseTo(0.85, 5)
    expect(at(5)).toBeCloseTo(1.0, 5)
  })

  it("missing confidence defaults to 3", () => {
    const missing = computeGateScore(f({ confidence: undefined, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic"],
    })
    const explicit = computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), {
      sourceSpecialists: ["logic"],
    })
    expect(missing).toBeCloseTo(explicit, 5)
    expect(missing).toBeCloseTo(0.60, 5)
  })

  it("evidence presence adds exactly +0.10 (testing category)", () => {
    const noEv = computeGateScore(f({ confidence: 3, score: 3, category: "testing" }), {
      sourceSpecialists: ["tests"],
    })
    const withEv = computeGateScore(
      f({ confidence: 3, score: 3, category: "testing", inspectedTestFiles: ["tests/foo.test.ts"] }),
      { sourceSpecialists: ["tests"] },
    )
    expect(withEv - noEv).toBeCloseTo(0.10, 5)
  })

  it("agreement adds +0.05 per extra specialist, capped at +0.10", () => {
    const at = (specialists: string[]) =>
      computeGateScore(f({ confidence: 3, score: 3, category: "logic" }), { sourceSpecialists: specialists })
    expect(at(["logic", "security"]) - at(["logic"])).toBeCloseTo(0.05, 5)
    expect(at(["logic", "security", "performance"]) - at(["logic", "security"])).toBeCloseTo(0.05, 5)
    // beyond two extra specialists, no further boost (cap)
    expect(at(["logic", "security", "performance", "tests"]) - at(["logic", "security", "performance"])).toBeCloseTo(
      0.0,
      5,
    )
  })

  it("severity contributes score 1→-0.10 … 5→+0.10 (logic, conf 3, 1 spec)", () => {
    const at = (score: number) =>
      computeGateScore(f({ confidence: 3, score, category: "logic" }), { sourceSpecialists: ["logic"] })
    // base conf 3 (0.50) + logic evidence (0.10) = 0.60 before severity
    expect(at(1)).toBeCloseTo(0.50, 5)
    expect(at(2)).toBeCloseTo(0.55, 5)
    expect(at(3)).toBeCloseTo(0.60, 5)
    expect(at(4)).toBeCloseTo(0.65, 5)
    expect(at(5)).toBeCloseTo(0.70, 5)
  })

  it("clamps to [0, 1]", () => {
    expect(
      computeGateScore(f({ confidence: 5, score: 5, category: "logic" }), {
        sourceSpecialists: ["logic", "security", "performance"],
      }),
    ).toBe(1.0)
    expect(
      computeGateScore(f({ confidence: 1, score: 1, category: "testing" }), { sourceSpecialists: ["tests"] }),
    ).toBe(0.0)
  })
})

// ─── 6) resolveReviewEventOverride + LOW_CONFIDENCE_COMMENT_THRESHOLD ────
describe("resolveReviewEventOverride (incomplete/blocker override resolution)", () => {
  it("a blocker escalates to REQUEST_CHANGES (beats incomplete + dropped)", () => {
    expect(
      resolveReviewEventOverride({ hasApprovalBlocker: true, reviewIncomplete: true, filesDroppedCount: 3 }),
    ).toBe("REQUEST_CHANGES")
  })

  it("reviewIncomplete downgrades to COMMENT", () => {
    expect(
      resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: true, filesDroppedCount: 0 }),
    ).toBe("COMMENT")
  })

  it("dropped files (count > 0) downgrade to COMMENT", () => {
    expect(
      resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: false, filesDroppedCount: 1 }),
    ).toBe("COMMENT")
  })

  it("a clean, complete review returns undefined (no override)", () => {
    expect(
      resolveReviewEventOverride({ hasApprovalBlocker: false, reviewIncomplete: false, filesDroppedCount: 0 }),
    ).toBeUndefined()
  })

  it("LOW_CONFIDENCE_COMMENT_THRESHOLD is 2", () => {
    expect(LOW_CONFIDENCE_COMMENT_THRESHOLD).toBe(2)
  })
})

// ─── 7) severityLabelForScore + severityTier mapping ────────────────────
describe("severityLabelForScore (score→severity label, >= semantics)", () => {
  it("maps via >= thresholds", () => {
    expect(severityLabelForScore(6)).toBe("P0")
    expect(severityLabelForScore(5)).toBe("P0")
    expect(severityLabelForScore(4)).toBe("P1")
    expect(severityLabelForScore(3)).toBe("P2")
    expect(severityLabelForScore(2)).toBe("P3")
    expect(severityLabelForScore(1)).toBe("P3")
  })
})

describe("severityTier mapping (documented via the golden mirror severityTierForScore)", () => {
  // The ensemble's private `severityTier` uses exact-equality boundaries
  // (P0 >= 5, P1 === 4, P2 === 3, else P3). Pinned here through the existing
  // mirror in tests/_golden/validation-matrix-cases.ts so the tier mapping is
  // documented without touching the private function or the golden file.
  it("maps via exact-equality thresholds", () => {
    expect(severityTierForScore(5)).toBe("P0")
    expect(severityTierForScore(4)).toBe("P1")
    expect(severityTierForScore(3)).toBe("P2")
    expect(severityTierForScore(2)).toBe("P3")
    expect(severityTierForScore(1)).toBe("P3")
  })
})

// ─── 8) hasRequiredEvidence (per-category evidence predicate) ───────────
describe("hasRequiredEvidence (per-category evidence predicate)", () => {
  it("security score>=4 requires BOTH cweId and evidenceId", () => {
    const base = f({ category: "security", score: 4 })
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, cweId: "CWE-89" })).toBe(false)
    expect(hasRequiredEvidence({ ...base, evidenceId: "ev-1" })).toBe(false)
    expect(hasRequiredEvidence({ ...base, cweId: "CWE-89", evidenceId: "ev-1" })).toBe(true)
  })

  it("security score<4 needs no evidence (true)", () => {
    expect(hasRequiredEvidence(f({ category: "security", score: 3 }))).toBe(true)
  })

  it("performance score>=4 requires complexityEstimate OR hotPathIdentifier", () => {
    const base = f({ category: "performance", score: 4 })
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, complexityEstimate: "O(n^2)" })).toBe(true)
    expect(hasRequiredEvidence({ ...base, hotPathIdentifier: "handleRequest" })).toBe(true)
  })

  it("performance score<4 needs no evidence (true)", () => {
    expect(hasRequiredEvidence(f({ category: "performance", score: 3 }))).toBe(true)
  })

  it("testing requires inspectedTestFiles OR evidenceRefs at any severity", () => {
    const base = f({ category: "testing", score: 3 })
    expect(hasRequiredEvidence({ ...base })).toBe(false)
    expect(hasRequiredEvidence({ ...base, inspectedTestFiles: ["t.test.ts"] })).toBe(true)
    expect(hasRequiredEvidence({ ...base, evidenceRefs: ["siblingMapping:a->NONE"] })).toBe(true)
  })

  it("other categories always return true", () => {
    for (const category of ["logic", "complexity", "style", "syntax", "docs", "error-handling"] as const) {
      expect(hasRequiredEvidence(f({ category, score: 5 }))).toBe(true)
    }
  })
})

// ─── 9) computeShadowGateDivergence (one divergence + one no-divergence) ─
describe("computeShadowGateDivergence (shadow-mode gate vs legacy verdict)", () => {
  it("no divergence when gate and legacy agree (both REQUEST_CHANGES)", () => {
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

  it("divergence payload when gate decides COMMENT but legacy decided REQUEST_CHANGES", () => {
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
})
