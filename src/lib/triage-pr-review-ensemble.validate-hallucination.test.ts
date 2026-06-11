import { describe, expect, it } from "vitest"
import { validateForSubmission, type SynthesizerProvenance } from "@/src/lib/triage-pr-review-ensemble"
import { type PrReviewFinding } from "@/src/lib/triage-pr-review"
import { applySynthSourceFindingFloor } from "@/src/lib/degraded-finding-floor"
import type { ReviewableMap } from "@/src/shared/util/diff-positions"
import { baseFinding, baseVerdict } from "@/src/lib/triage-pr-review-ensemble.test-helpers"

describe("validateForSubmission — hallucination guard + line validity + score-1 handling", () => {
  const reviewable: ReviewableMap = new Map([
    [
      "src/lib/foo.ts",
      [
        { line: 42, side: "RIGHT" },
        { line: 50, side: "RIGHT" },
      ],
    ],
  ])

  const specialistVerdicts = [
    {
      role: "logic" as const,
      verdict: {
        ...baseVerdict,
        findings: [
          { ...baseFinding, id: "logic-0", line: 42, score: 4 },
          { ...baseFinding, id: "logic-1", line: 50, score: 1, headline: "minor nit" },
        ],
      },
      elapsedMs: 100,
    },
  ]

  it("keeps a finding with valid provenance + reviewable line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{ ...baseFinding, line: 42, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.droppedForHallucination).toBe(0)
    expect(out.droppedForInvalidLine).toBe(0)
    expect(out.demotedScore1).toBe(0)
  })

  it("SIG-351 source floor restores an omitted blocker before the validation path", () => {
    const floored = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [
        {
          specialist: "logic",
          sourceFindingId: "logic-0",
          headline: "off-by-one in `clampIndex`",
          reason: "duplicate",
        },
      ],
      specialists: specialistVerdicts.map((v) => ({ role: v.role, findings: v.verdict!.findings })),
    })

    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: floored.findings,
        },
        provenance: {
          findings: floored.provenanceFindings,
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })

    expect(floored.restored.map((x) => x.id)).toEqual(["logic-0"])
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.headline).toBe("off-by-one in `clampIndex`")
    expect(out.cleanFindingProvenance[0]?.sourceFindingIds).toEqual(["logic-0"])
    expect(out.droppedForHallucination).toBe(0)
  })

  it("SIG-311 demotes a security-sourced usage-vs-mention finding to the body in enforce mode", () => {
    const path = "src/lib/ast-rules/scan-dynamic-html-sink.ts"
    const securityFinding: PrReviewFinding = {
      path,
      line: 10,
      score: 5,
      category: "security",
      cweId: "CWE-78",
      headline: "Command injection sink via shell interpolation in `exec`",
      body: "`re.exec(line)` executes attacker-controlled input as a shell command.",
    }
    const synthOutput = () => ({
      verdict: {
        summary: "ok",
        confidence: 4,
        confidenceReason: "...",
        findings: [{ ...securityFinding }],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["security"],
            sourceFindingIds: ["security-0"],
            action: "kept" as const,
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
      },
    })
    const securityVerdicts = [
      {
        role: "security" as const,
        verdict: {
          ...baseVerdict,
          findings: [{ ...securityFinding, id: "security-0" }],
        },
        elapsedMs: 100,
      },
    ]
    const securityReviewable: ReviewableMap = new Map([[path, [{ line: 10, side: "RIGHT" }]]])
    const addedLineTextByLine = new Map<string, Map<number, string>>([
      [path, new Map([[10, "  for (const re of HTML_WRITE_SINK_EXTRACTORS) { re.exec(line); }"]])],
    ])

    const shadow = validateForSubmission({
      synthOutput: synthOutput(),
      reviewable: securityReviewable,
      specialistVerdicts: securityVerdicts,
      addedLineTextByLine,
      securityUsageValidatorMode: "shadow",
    })
    expect(shadow.verdict.findings).toHaveLength(1)
    expect(shadow.unanchoredFindings).toHaveLength(0)
    expect(shadow.droppedForFailedSecurityUsageValidation).toBe(1)

    const enforce = validateForSubmission({
      synthOutput: synthOutput(),
      reviewable: securityReviewable,
      specialistVerdicts: securityVerdicts,
      addedLineTextByLine,
      securityUsageValidatorMode: "enforce",
      trustLedgerEnabled: true,
    })
    expect(enforce.verdict.findings).toHaveLength(0)
    expect(enforce.unanchoredFindings).toHaveLength(1)
    expect(enforce.unanchoredFindings[0]?.headline).toContain("Command injection")
    expect(enforce.unanchoredFindings[0]?.trust).toEqual({
      tier: "body-only-ungrounded",
      surface: "body",
      demoteReason: "security-usage",
    })
    expect(enforce.droppedForFailedSecurityUsageValidation).toBe(1)
  })

  it("attaches EvidenceRecord from validated synth provenance without changing score or confidence", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [
            {
              ...baseFinding,
              line: 42,
              score: 4,
              confidence: 4,
              evidenceId: "freeform-model-id",
              evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE", "freeform:<script>"],
            },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0", "security-0", astId],
              action: "merged",
              verifiedViaRetrieval: true,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts: [
        ...specialistVerdicts,
        {
          role: "security" as const,
          verdict: {
            ...baseVerdict,
            findings: [
              {
                ...baseFinding,
                id: "security-0",
                line: 42,
                score: 4,
                evidenceId: "secret:generic-api-key:abc123:42",
              },
            ],
          },
          elapsedMs: 100,
        },
        {
          role: "performance" as const,
          verdict: { ...baseVerdict, findings: [] },
          elapsedMs: 100,
        },
        {
          role: "tests" as const,
          verdict: null,
          elapsedMs: 100,
        },
      ],
      astFindingIds: [astId],
    })

    const finding = out.verdict.findings[0]
    expect(finding?.score).toBe(4)
    expect(finding?.confidence).toBe(4)
    expect(finding?.evidence).toEqual({
      specialistsThatFlagged: ["logic", "security"],
      specialistsThatDeclined: ["performance"],
      deterministicFactIds: ["secret:generic-api-key:abc123:42", "siblingMapping:src/lib/foo.ts->NONE", astId],
      retrievalChunkIds: [],
      relatedPriorPRs: [],
      synthDecision: "merged",
      consensusScore: 2,
    })
  })

  it("does not attribute fallback sourceSpecialists that returned no findings", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{ ...baseFinding, line: 42, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["security"],
              sourceFindingIds: [astId],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts: [
        ...specialistVerdicts,
        {
          role: "security" as const,
          verdict: { ...baseVerdict, findings: [] },
          elapsedMs: 100,
        },
      ],
      astFindingIds: [astId],
    })

    expect(out.verdict.findings[0]?.evidence?.specialistsThatFlagged).toEqual([])
    expect(out.verdict.findings[0]?.evidence?.consensusScore).toBe(0)
    expect(out.verdict.findings[0]?.evidence?.specialistsThatDeclined).toEqual(["logic", "security"])
  })

  it("uses sourceSpecialists fallback only for a matching specialist finding", () => {
    const astId = "ast/no-unsafe-call/abc123/42"
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{ ...baseFinding, line: 42, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: [astId],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      astFindingIds: [astId],
    })

    expect(out.verdict.findings[0]?.evidence?.specialistsThatFlagged).toEqual(["logic"])
    expect(out.verdict.findings[0]?.evidence?.consensusScore).toBe(1)
    expect(out.verdict.findings[0]?.evidence?.specialistsThatDeclined).toEqual([])
  })

  it("normalizes malformed synth evidence actions before rendering metadata", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [{ ...baseFinding, line: 42, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "split" as unknown as SynthesizerProvenance["findings"][number]["action"],
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })

    expect(out.verdict.findings[0]?.evidence?.synthDecision).toBe("unknown")
  })

  it("tags a finding on a NON-changed file as outOfPrScope; a mis-anchored finding on a CHANGED file is NOT (Codex recall-hole fix)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          summary: "ok",
          confidence: 4,
          confidenceReason: "...",
          findings: [
            // a finding about code in a file NOT in this PR's diff → out-of-PR-scope
            {
              ...baseFinding,
              path: "src/other-unchanged.ts",
              line: 5,
              score: 5,
              headline: "in another file",
            },
            // a real finding on the CHANGED file but a non-reviewable line (mis-anchored) → NOT out-of-scope
            {
              ...baseFinding,
              path: "src/lib/foo.ts",
              line: 999,
              score: 5,
              headline: "mis-anchored blocker",
            },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable, // only src/lib/foo.ts is a changed file
      specialistVerdicts,
    })
    const other = out.unanchoredFindings.find((f) => f.path === "src/other-unchanged.ts")
    const misAnchored = out.unanchoredFindings.find((f) => f.path === "src/lib/foo.ts")
    expect(other?.outOfPrScope).toBe(true) // not a changed file → out-of-PR-scope (won't block / auto-approves)
    expect(misAnchored?.outOfPrScope).toBeUndefined() // changed file, just unanchorable → STILL blocks (recall hole closed)
  })

  it("DROPS findings whose provenance references a non-existent specialist finding (hallucination guard)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 42, score: 4, headline: "FAKE FINDING" }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-99"], // doesn't exist!
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForHallucination).toBe(1)
  })

  it("DROPS findings with empty sourceFindingIds (hallucination)", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 42, score: 4 }] },
        provenance: {
          findings: [
            {
              sourceSpecialists: [],
              sourceFindingIds: [], // empty!
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForHallucination).toBe(1)
  })

  it("DROPS score-1 findings with empty sourceFindingIds before advisory provenance recording", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 42, score: 1, headline: "tiny nit" }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: [],
              sourceFindingIds: [],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.demotedScore1).toBe(0)
    expect(out.droppedForHallucination).toBe(1)
    expect(out.provenance.dropped).toEqual([])
  })

  it("DROPS findings whose (path, line) is not a reviewable position", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 999, score: 4 }], // line 999 not in diff
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
  })

  it("repairs a nearby line-scoped finding to the nearest substantive added line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        [
          "src/lib/foo.ts",
          new Map([
            [42, "  const idx = clampIndex(i)"],
            [50, "  return result"],
          ]),
        ],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.cleanFindingProvenance).toHaveLength(1)
    expect(out.droppedForInvalidLine).toBe(0)
    expect(out.remappedInvalidLineToInline).toBe(1)
    expect(out.unanchoredFindings).toHaveLength(0)
  })

  it("skips closer LEFT-only candidates and repairs to a farther RIGHT-side line", () => {
    const sideAwareReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 46, side: "LEFT" },
          { line: 50, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable: sideAwareReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        [
          "src/lib/foo.ts",
          new Map([
            [46, "  oldOnlyCandidate()"],
            [50, "  return result"],
          ]),
        ],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.remappedInvalidLineToInline).toBe(1)
    expect(out.droppedForInvalidLine).toBe(0)
  })

  it("prefers the forward candidate when repair candidates are equidistant", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 46, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        [
          "src/lib/foo.ts",
          new Map([
            [42, "  const idx = clampIndex(i)"],
            [50, "  return result"],
          ]),
        ],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(50)
    expect(out.remappedInvalidLineToInline).toBe(1)
  })

  it("does not repair when every substantive candidate is outside the repair window", () => {
    const distantReviewable: ReviewableMap = new Map([
      [
        "src/lib/foo.ts",
        [
          { line: 87, side: "RIGHT" },
          { line: 113, side: "RIGHT" },
        ],
      ],
    ])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 100, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable: distantReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([
        [
          "src/lib/foo.ts",
          new Map([
            [87, "  beforeWindow()"],
            [113, "  afterWindow()"],
          ]),
        ],
      ]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.line).toBe(100)
  })

  it("does not repair structured one-click suggestions", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [
            {
              ...baseFinding,
              line: 47,
              score: 4,
              kind: "replace",
              suggestedReplacement: "  return safeResult",
            },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([["src/lib/foo.ts", new Map([[50, "  return result"]])]]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.suggestedReplacement).toBe("  return safeResult")
  })

  it("keeps invalid multi-line range findings body-only instead of collapsing them to one line", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, startLine: 44, line: 47, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([["src/lib/foo.ts", new Map([[50, "  return result"]])]]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.startLine).toBe(44)
    expect(out.unanchoredFindings[0]?.line).toBe(47)
  })

  it("keeps header-line findings body-only instead of repairing them", () => {
    const lineOneReviewable: ReviewableMap = new Map([["src/lib/foo.ts", [{ line: 2, side: "RIGHT" }]]])
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 1, score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable: lineOneReviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([["src/lib/foo.ts", new Map([[2, "export const value = 1"]])]]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.line).toBe(1)
  })

  // SIG Trust Ledger v0: the body-demote sites tag `trust.demoteReason` when
  // `trustLedgerEnabled` (flag != off). Exercises the shared gating + the in-place
  // annotation survival through to `unanchoredFindings` on the line-1 path
  // (outside-diff); the other 4 demote sites use the identical
  // `if (trustLedgerEnabled) annotateFindingTrust(...)` mechanism with their own
  // reason string. Guards against a silent regression in the threading.
  describe("trust-ledger demote-reason threading", () => {
    const lineOneReviewable: ReviewableMap = new Map([["src/lib/foo.ts", [{ line: 2, side: "RIGHT" }]]])
    // Fresh per call — the line-1 demote site annotates the finding object IN
    // PLACE, so a shared fixture would leak the mutation between the two tests.
    const mkSynthOutput = () => ({
      verdict: { ...baseVerdict, findings: [{ ...baseFinding, line: 1, score: 4 }] },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic"],
            sourceFindingIds: ["logic-0"],
            action: "kept" as const,
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
      },
    })
    const addedLineTextByLine = new Map([["src/lib/foo.ts", new Map([[2, "export const value = 1"]])]])

    it("tags a line-1 body-routed finding with demoteReason outside-diff when enabled", () => {
      const out = validateForSubmission({
        synthOutput: mkSynthOutput(),
        reviewable: lineOneReviewable,
        specialistVerdicts,
        addedLineTextByLine,
        trustLedgerEnabled: true,
      })
      expect(out.verdict.findings).toHaveLength(0)
      expect(out.unanchoredFindings).toHaveLength(1) // demoted, not dropped
      expect(out.droppedForInvalidLine).toBe(1)
      expect(out.unanchoredFindings[0]?.trust).toEqual({
        tier: "body-only-ungrounded",
        surface: "body",
        demoteReason: "outside-diff",
      })
    })

    it("is a true no-op when disabled (default) — no trust mutation", () => {
      const out = validateForSubmission({
        synthOutput: mkSynthOutput(),
        reviewable: lineOneReviewable,
        specialistVerdicts,
        addedLineTextByLine,
      })
      expect(out.verdict.findings).toHaveLength(0)
      expect(out.unanchoredFindings).toHaveLength(1) // still demoted (flag only gates the trust tag)
      expect(out.droppedForInvalidLine).toBe(1)
      expect(out.unanchoredFindings[0]?.line).toBe(1)
      expect(out.unanchoredFindings[0]?.trust).toBeUndefined() // but untagged
    })
  })

  it("does not repair broad-scope findings into inline comments", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [{ ...baseFinding, line: 47, scope: "file", score: 4 }],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      addedLineTextByLine: new Map([["src/lib/foo.ts", new Map([[50, "  return result"]])]]),
    })
    expect(out.verdict.findings).toHaveLength(0)
    expect(out.droppedForInvalidLine).toBe(1)
    expect(out.remappedInvalidLineToInline).toBe(0)
    expect(out.unanchoredFindings[0]?.scope).toBe("file")
  })

  it("drops score-1 findings from chill reviews and records provenance", () => {
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          summary: "ok",
          findings: [
            { ...baseFinding, line: 42, score: 1, headline: "first nit" },
            { ...baseFinding, line: 50, score: 1, headline: "second nit" },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-1"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-1"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      profile: "chill",
    })
    expect(out.verdict.findings).toHaveLength(0) // score-1 never goes inline
    expect(out.demotedScore1).toBe(2)
    expect(out.verdict.summary).not.toContain("Advisory nits:")
    expect(out.verdict.summary).not.toContain("first nit")
    expect(out.provenance.dropped).toEqual([
      {
        specialist: "logic",
        sourceFindingId: "logic-1",
        headline: "first nit",
        reason: "score-1-advisory",
      },
      {
        specialist: "logic",
        sourceFindingId: "logic-1",
        headline: "second nit",
        reason: "score-1-advisory",
      },
    ])
  })

  it("caps advisory nits at 5 for assertive profile and appends 'plus N more'", () => {
    const findings = Array.from({ length: 8 }, (_, i) => ({
      ...baseFinding,
      line: 42,
      score: 1,
      headline: `nit ${i}`,
    }))
    const provenance = findings.map(() => ({
      sourceSpecialists: ["logic" as const],
      sourceFindingIds: ["logic-1"],
      action: "kept" as const,
      verifiedViaRetrieval: false,
    }))
    const out = validateForSubmission({
      synthOutput: {
        verdict: { ...baseVerdict, summary: "ok", findings },
        provenance: {
          findings: provenance,
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
      profile: "assertive",
    })
    // Top 5 emitted in summary, "plus 3 more" appended.
    expect(out.verdict.summary).toContain("plus 3 more advisory nits")
    expect(out.provenance.dropped).toHaveLength(8)
    expect(out.provenance.dropped.every((d) => d.reason === "score-1-advisory")).toBe(true)
  })

  it("matches provenance to verdict findings BY INDEX, not by headline", () => {
    // Two findings with similar headlines — index match must still
    // resolve correctly (Codex catch round 3).
    const out = validateForSubmission({
      synthOutput: {
        verdict: {
          ...baseVerdict,
          findings: [
            { ...baseFinding, line: 42, score: 4, headline: "common headline" },
            { ...baseFinding, line: 50, score: 3, headline: "common headline" },
          ],
        },
        provenance: {
          findings: [
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-0"],
              action: "kept",
              verifiedViaRetrieval: false,
            },
            {
              sourceSpecialists: ["logic"],
              sourceFindingIds: ["logic-99"],
              action: "kept",
              verifiedViaRetrieval: false,
            }, // index 1 = bad source
          ],
          dropped: [],
        },
      },
      reviewable,
      specialistVerdicts,
    })
    // First finding (index 0) keeps; second (index 1) drops despite identical headline.
    expect(out.verdict.findings).toHaveLength(1)
    expect(out.verdict.findings[0]?.line).toBe(42)
    expect(out.droppedForHallucination).toBe(1)
  })
})
