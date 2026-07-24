// SIG-606 — reconciliation semantics. These guard the single easiest way to
// corrupt the finding-event corpus: reading a gate's enforce/shadow flag as if it
// meant "suppressed".

import { describe, it, expect } from "vitest"

import { reconcileFindingOutcomes } from "@/src/features/finding-events/domain/reconcile"
import type { FindingEventDraft, PostedFindingRecord } from "@/src/features/finding-events/domain/types"

const draft = (over: Partial<FindingEventDraft> = {}): FindingEventDraft => ({
  findingKey: "k1",
  stage: "validator",
  ...over,
})

describe("reconcileFindingOutcomes", () => {
  it("a SHADOW-mode gate hit on a finding that was still POSTED is NOT suppressed", () => {
    // The corpus-corrupting case: gate fired, enforced=false, finding shipped anyway.
    const drafts = [draft({ findingKey: "k1", gate: "diff-consistency", reason: "contradicts-diff", enforced: false })]
    const posted = new Map<string, PostedFindingRecord>([["k1", { surface: "posted-inline", inlineCommentId: 55 }]])

    const [event] = reconcileFindingOutcomes(drafts, posted)
    expect(event!.outcome).toBe("posted-inline")
    expect(event!.inlineCommentId).toBe(55)
    // The gate record survives — we keep WHY it was flagged, we just don't call it suppressed.
    expect(event!.gate).toBe("diff-consistency")
    expect(event!.enforced).toBe(false)
  })

  it("an ENFORCED gate hit absent from the posted set is suppressed", () => {
    const drafts = [draft({ findingKey: "k2", gate: "security-grounding", enforced: true })]
    const [event] = reconcileFindingOutcomes(drafts, new Map())
    expect(event!.outcome).toBe("suppressed")
  })

  it("records the surface publication ACTUALLY used, not the one a gate implied", () => {
    const drafts = [draft({ findingKey: "k3", gate: "inline-grounding", reason: "demote-to-body", enforced: true })]
    const posted = new Map<string, PostedFindingRecord>([["k3", { surface: "posted-body" }]])
    const [event] = reconcileFindingOutcomes(drafts, posted)
    expect(event!.outcome).toBe("posted-body")
  })

  it("null posted set (errored/aborted review) → `unknown`, never a guessed `suppressed`", () => {
    // Guessing here would inject false negatives — findings we may well have posted,
    // recorded as rejected. Recall-safety: unknown is the honest label.
    const drafts = [draft({ findingKey: "k4", gate: "logic-refutation", enforced: true }), draft({ findingKey: "k5" })]
    const events = reconcileFindingOutcomes(drafts, null)
    expect(events.map((e) => e.outcome)).toEqual(["unknown", "unknown"])
    expect(events.some((e) => e.outcome === "suppressed")).toBe(false)
  })

  it("EMPTY posted map is different from null — publication ran and posted nothing", () => {
    const events = reconcileFindingOutcomes([draft({ findingKey: "k6" })], new Map())
    expect(events[0]!.outcome).toBe("suppressed")
  })

  it("publication's trust tier wins over a stale draft value", () => {
    const drafts = [draft({ findingKey: "k7", trustTier: "grounded-model" })]
    const posted = new Map<string, PostedFindingRecord>([
      ["k7", { surface: "posted-inline", trustTier: "reproduced-by-execution" }],
    ])
    const [event] = reconcileFindingOutcomes(drafts, posted)
    expect(event!.trustTier).toBe("reproduced-by-execution")
  })

  it("publication assigning NO tier (ledger off) nulls a stale draft tier — it does not leak through", () => {
    // The schema invariant is "trust_tier is NULL unless the ledger was on AND the
    // finding survived". A draft value winning here would persist a tier as though
    // publication had assigned one.
    const drafts = [draft({ findingKey: "k10", trustTier: "grounded-model" })]
    const posted = new Map<string, PostedFindingRecord>([["k10", { surface: "posted-inline" }]])
    const [event] = reconcileFindingOutcomes(drafts, posted)
    expect(event!.trustTier).toBeNull()
  })

  it("a SUPPRESSED candidate never carries a trust tier (it did not survive)", () => {
    const drafts = [draft({ findingKey: "k11", trustTier: "grounded-model" })]
    const [suppressed] = reconcileFindingOutcomes(drafts, new Map())
    expect(suppressed!.trustTier).toBeNull()
    const [unknown] = reconcileFindingOutcomes(drafts, null)
    expect(unknown!.trustTier).toBeNull()
  })

  it("tolerates an undefined posted set the same as null (never throws)", () => {
    const events = reconcileFindingOutcomes([draft({ findingKey: "k12" })], undefined)
    expect(events[0]!.outcome).toBe("unknown")
  })

  it("keeps one row per candidate-stage observation (multi-stage history is preserved)", () => {
    // The same finding hit by two gates yields two rows — the timeline is the point.
    const drafts = [
      draft({ findingKey: "k8", stage: "validator", gate: "tests" }),
      draft({ findingKey: "k8", stage: "render-prep", gate: "precision-profile" }),
    ]
    const events = reconcileFindingOutcomes(drafts, new Map())
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.stage)).toEqual(["validator", "render-prep"])
    expect(events.every((e) => e.outcome === "suppressed")).toBe(true)
  })

  it("does not mutate the input drafts", () => {
    const input = draft({ findingKey: "k9" })
    reconcileFindingOutcomes([input], new Map([["k9", { surface: "posted-inline", inlineCommentId: 1 }]]))
    expect("outcome" in input).toBe(false)
    expect("inlineCommentId" in input).toBe(false)
  })

  it("empty drafts → empty result", () => {
    expect(reconcileFindingOutcomes([], new Map())).toEqual([])
  })
})
