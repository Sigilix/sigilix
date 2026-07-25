// SIG-606 writer — capture → materialize. The load-bearing guarantee here is that
// `headline` is used to derive the key and then DROPPED, so customer-source-derived
// text never reaches a persistable draft.

import { describe, it, expect } from "vitest"

import {
  captureGateHit,
  capturePostedFinding,
  materializeFindingEvents,
  buildPostedFindingRecords,
  type FindingEventCapture,
} from "@/src/lib/ensemble/app/finding-event-capture"
import { reconcileFindingOutcomes } from "@/src/features/finding-events"

describe("captureGateHit", () => {
  it("records a gate hit with the finding's structural fields", () => {
    const sink: FindingEventCapture[] = []
    captureGateHit(sink, {
      gate: "diff-consistency",
      stage: "validator",
      reason: "contradicts-diff",
      enforced: true,
      finding: { path: "src/a.ts", headline: "Null deref", category: "logic", score: 4, line: 12 },
    })
    expect(sink).toHaveLength(1)
    expect(sink[0]).toMatchObject({
      path: "src/a.ts",
      gate: "diff-consistency",
      reason: "contradicts-diff",
      enforced: true,
      category: "logic",
      score: 4,
      line: 12,
    })
  })

  it("no-ops when no sink is threaded (the sink is optional everywhere)", () => {
    expect(() =>
      captureGateHit(undefined, {
        gate: "tests",
        stage: "validator",
        reason: "r",
        enforced: false,
        finding: { path: "a", headline: "h" },
      }),
    ).not.toThrow()
  })

  it("is TOTAL — a malformed finding yields a capture instead of throwing in the hot path", () => {
    const sink: FindingEventCapture[] = []
    captureGateHit(sink, {
      gate: "logic",
      stage: "validator",
      reason: "r",
      enforced: false,
      finding: { path: null, headline: undefined },
    })
    expect(sink[0]).toMatchObject({ path: "", headline: "" })
  })
})

describe("materializeFindingEvents", () => {
  const capture = (over: Partial<FindingEventCapture> = {}): FindingEventCapture => ({
    path: "src/pay.ts",
    headline: "Double charge on retry",
    stage: "validator",
    ...over,
  })

  it("DROPS the headline — exact key-set on a FULLY-POPULATED capture", async () => {
    // Exact key-set (not spot checks) on a capture with every field set, so ANY
    // future field that leaks customer text turns this red instead of shipping.
    const [draft] = await materializeFindingEvents([
      capture({
        gate: "diff-consistency",
        reason: "contradicts-diff",
        enforced: true,
        category: "logic",
        score: 4,
        confidence: 3,
        gateScore: 0.8,
        contentFingerprint: "fp",
        line: 10,
        startLine: 8,
        sourceSpecialists: ["logic"],
      }),
    ])
    expect(Object.keys(draft!).sort()).toEqual(
      [
        "findingKey",
        "identityResolved",
        "contentFingerprint",
        "category",
        "score",
        "confidence",
        "gateScore",
        "path",
        "line",
        "startLine",
        "sourceSpecialists",
        "trustTier",
        "stage",
        "gate",
        "reason",
        "enforced",
      ].sort(),
    )
    expect(JSON.stringify(draft)).not.toContain("Double charge")
  })

  it("clamps gate/reason codes so an interpolating call site can't ship an essay", async () => {
    const [draft] = await materializeFindingEvents([capture({ reason: "x".repeat(500) })])
    expect(draft!.reason!.length).toBe(120)
  })

  it("caps the batch and LOGS the truncation (never a silent cap)", async () => {
    const many = Array.from({ length: 505 }, (_, i) => capture({ path: `f${i}.ts` }))
    const drafts = await materializeFindingEvents(many)
    expect(drafts).toHaveLength(500)
  })

  it("is total — an undefined path/headline does not reject the whole review's labels", async () => {
    const drafts = await materializeFindingEvents([
      { path: undefined, headline: undefined, stage: "validator" } as unknown as FindingEventCapture,
    ])
    expect(drafts[0]!.path).toBe("")
    expect(drafts[0]!.identityResolved).toBe(false)
  })

  it("derives a stable key from (path, headline) — same input, same key", async () => {
    const [a] = await materializeFindingEvents([capture()])
    const [b] = await materializeFindingEvents([capture()])
    expect(a!.findingKey).toBe(b!.findingKey)
    expect(a!.findingKey).toMatch(/^[0-9a-f]{16}$/)
  })

  it("different findings get different keys", async () => {
    const [a] = await materializeFindingEvents([capture()])
    const [b] = await materializeFindingEvents([capture({ headline: "Something else entirely" })])
    expect(a!.findingKey).not.toBe(b!.findingKey)
  })

  it("preserves order and carries the structural fields through", async () => {
    const drafts = await materializeFindingEvents([
      capture({ path: "a.ts", gate: "tests", enforced: true, score: 2 }),
      capture({ path: "b.ts", stage: "render-prep", gate: "precision-profile" }),
    ])
    expect(drafts.map((d) => d.path)).toEqual(["a.ts", "b.ts"])
    expect(drafts[0]).toMatchObject({ gate: "tests", enforced: true, score: 2, stage: "validator" })
    expect(drafts[1]).toMatchObject({ gate: "precision-profile", stage: "render-prep", enforced: false })
  })
})

describe("buildPostedFindingRecords", () => {
  it("on a duplicate key, keeps the richer record instead of dropping the comment id", () => {
    // A finding present inline AND in the body rollup: last-write-wins would let the
    // posted-body entry clobber the inline one and lose inlineCommentId.
    const out = buildPostedFindingRecords([
      { findingKey: "k", surface: "posted-inline", inlineCommentId: 42 },
      { findingKey: "k", surface: "posted-body" },
    ])
    expect(out.get("k")).toMatchObject({ surface: "posted-inline", inlineCommentId: 42 })
  })

  it("skips entries with no key rather than creating a bogus join target", () => {
    expect(buildPostedFindingRecords([{ findingKey: "", surface: "posted-body" }]).size).toBe(0)
  })
})

describe("end-to-end: capture → materialize → reconcile", () => {
  it("a shadow-gate hit that publication posted is labelled posted, not suppressed", async () => {
    const sink: FindingEventCapture[] = []
    captureGateHit(sink, {
      gate: "diff-consistency",
      stage: "validator",
      reason: "contradicts-diff",
      enforced: false, // shadow — flagged but NOT acted on
      finding: { path: "src/pay.ts", headline: "Double charge on retry" },
    })
    const drafts = await materializeFindingEvents(sink)
    const posted = buildPostedFindingRecords([
      { findingKey: drafts[0]!.findingKey, surface: "posted-inline", inlineCommentId: 77 },
    ])

    const [event] = reconcileFindingOutcomes(drafts, posted)
    expect(event!.outcome).toBe("posted-inline")
    expect(event!.inlineCommentId).toBe(77)
  })

  it("an enforced gate hit absent from the posted set is labelled suppressed", async () => {
    const sink: FindingEventCapture[] = []
    captureGateHit(sink, {
      gate: "security-grounding",
      stage: "validator",
      reason: "no-evidence",
      enforced: true,
      finding: { path: "src/auth.ts", headline: "Missing authz check" },
    })
    const drafts = await materializeFindingEvents(sink)
    const [event] = reconcileFindingOutcomes(drafts, buildPostedFindingRecords([]))
    expect(event!.outcome).toBe("suppressed")
  })

  it("the posted-set takes the ALREADY-COMPUTED key, so the join cannot drift", async () => {
    const [draft] = await materializeFindingEvents([{ path: "src/x.ts", headline: "Same finding", stage: "publish" }])
    const posted = buildPostedFindingRecords([{ findingKey: draft!.findingKey, surface: "posted-body" }])
    expect(posted.has(draft!.findingKey)).toBe(true)
  })

  it("a candidate with NO derivable identity reconciles to `unknown`, never `suppressed`", async () => {
    // Its fabricated key can never match the posted set; calling that "suppressed"
    // would record a finding we may well have posted as rejected.
    const drafts = await materializeFindingEvents([{ path: "src/a.ts", headline: "", stage: "validator" }])
    expect(drafts[0]!.identityResolved).toBe(false)
    const [event] = reconcileFindingOutcomes(drafts, buildPostedFindingRecords([]))
    expect(event!.outcome).toBe("unknown")
  })

  it("a resolvable candidate still reconciles to suppressed (the guard is narrow)", async () => {
    const drafts = await materializeFindingEvents([{ path: "src/a.ts", headline: "Real", stage: "validator" }])
    expect(drafts[0]!.identityResolved).toBe(true)
    expect(reconcileFindingOutcomes(drafts, buildPostedFindingRecords([]))[0]!.outcome).toBe("suppressed")
  })
})

describe("capturePostedFinding (publish-stage coverage)", () => {
  it("records EVERY survivor, so a finding that tripped no gate still gets a row", async () => {
    const sink: FindingEventCapture[] = []
    capturePostedFinding(sink, {
      key: "abc123",
      path: "src/x.ts",
      score: 3,
      line: 4,
      category: "logic",
      contentFingerprint: "fp-64hex",
    })
    const [draft] = await materializeFindingEvents(sink)
    expect(draft).toMatchObject({
      findingKey: "abc123",
      stage: "publish",
      contentFingerprint: "fp-64hex",
      category: "logic",
      score: 3,
      identityResolved: true,
    })
  })

  it("uses the manifest's PRE-COMPUTED key — no second derivation site", async () => {
    const sink: FindingEventCapture[] = []
    // headline is deliberately empty; the supplied key must win and identity must
    // still count as resolved (a derived key would differ and break the join).
    capturePostedFinding(sink, { key: "manifest-key", path: "src/x.ts" })
    const [draft] = await materializeFindingEvents(sink)
    expect(draft!.findingKey).toBe("manifest-key")
    expect(draft!.identityResolved).toBe(true)
  })

  it("carries the manifest's content_fingerprint through to the draft", async () => {
    // The fingerprint is the ONLY join key a human dismissal has (dismissals carry a
    // fingerprint, not a headline), and validator-stage captures can't supply it
    // because it is assigned later in the pipeline.
    const postSink: FindingEventCapture[] = []
    capturePostedFinding(postSink, { key: "k", path: "a.ts", contentFingerprint: "fp" })
    const [postDraft] = await materializeFindingEvents(postSink)
    expect(postDraft!.contentFingerprint).toBe("fp")
  })

  it("the cap keeps PUBLISH rows and drops gate rows — not the other way round", async () => {
    // A positional slice would drop 100% of publish rows (they are appended last),
    // silently losing every fingerprint on exactly the largest reviews.
    const gates = Array.from({ length: 505 }, (_, i) => ({
      path: `f${i}.ts`,
      headline: `h${i}`,
      stage: "validator" as const,
    }))
    const sink: FindingEventCapture[] = [...gates]
    capturePostedFinding(sink, { key: "survivor", path: "s.ts", contentFingerprint: "fp" })

    const drafts = await materializeFindingEvents(sink)
    expect(drafts).toHaveLength(500)
    expect(drafts.some((d) => d.stage === "publish")).toBe(true)
    expect(drafts.find((d) => d.stage === "publish")!.contentFingerprint).toBe("fp")
  })

  it("no-ops without a sink", () => {
    expect(() => capturePostedFinding(undefined, { key: "k", path: "p" })).not.toThrow()
  })
})
