// SIG-350 deterministic tests for the synthesizer-retention eval oracle.

import { describe, expect, it } from "vitest"
import {
  scoreSynthRetentionCase,
  summarizeSynthRetentionResults,
  SYNTH_RETENTION_CASES,
  type SynthRetentionOutput,
} from "./synth-retention-corpus"

const collisionCase = SYNTH_RETENTION_CASES.find((c) => c.id === "distinct-bugs-same-file")!
const cleanCase = SYNTH_RETENTION_CASES.find((c) => c.id === "fp-filter-plus-tp-retention")!

describe("synth-retention oracle", () => {
  it("counts high-severity true positives as missed when their source IDs disappear", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "Looks clean.",
        confidence: 4,
        confidenceReason: "No actionable issues.",
        findings: [],
      },
      provenance: { findings: [], dropped: [] },
      elapsedMs: 12_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(cleanCase, synthOutput)

    expect(score.totalMustKeep).toBe(1)
    expect(score.retained).toBe(0)
    expect(score.missedSourceIds).toEqual(["logic-0"])
    expect(score.recall).toBe(0)
  })

  it("treats unsupported synth-only findings as hallucinations, not valid positives", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One issue.",
        confidence: 4,
        confidenceReason: "The diff shows it.",
        findings: [
          {
            path: "src/api/orders.ts",
            line: 5,
            score: 4,
            category: "security",
            headline: "SSRF via Content-Type",
            body: "The new parser trusts a response Content-Type header.",
          },
        ],
      },
      provenance: {
        findings: [
          { sourceSpecialists: [], sourceFindingIds: [], action: "kept", verifiedViaRetrieval: false },
        ],
        dropped: [],
      },
      elapsedMs: 11_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(cleanCase, synthOutput)

    expect(score.unsupportedFindings).toBe(1)
    expect(score.retained).toBe(0)
    expect(score.precision).toBe(0)
  })

  it("flags severity drift when a P1 source survives only as a low-severity nit", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One minor issue.",
        confidence: 4,
        confidenceReason: "Source retained.",
        findings: [
          {
            path: "src/api/orders.ts",
            line: 5,
            score: 2,
            category: "logic",
            headline: "Missing authorization check",
            body: "The handler returns another tenant's order without checking `tenantId`.",
          },
        ],
      },
      provenance: {
        findings: [
          { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
        ],
        dropped: [],
      },
      elapsedMs: 9_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(cleanCase, synthOutput)

    expect(score.retained).toBe(0)
    expect(score.severityDriftSourceIds).toEqual(["logic-0"])
    expect(score.recall).toBe(0)
  })

  it("treats a hallucinated claim with a real source ID as unsupported misattribution", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One issue.",
        confidence: 4,
        confidenceReason: "Source ID is present but the claim changed.",
        findings: [
          {
            path: "src/parse/ndjson.ts",
            line: 4,
            score: 4,
            category: "security",
            headline: "SSRF via Content-Type",
            body: "The parser trusts a response Content-Type header, but the cited source was an order authorization bug.",
          },
        ],
      },
      provenance: {
        findings: [
          { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "rewritten", verifiedViaRetrieval: false },
        ],
        dropped: [],
      },
      elapsedMs: 9_500,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(cleanCase, synthOutput)

    expect(score.retained).toBe(0)
    expect(score.unsupportedFindings).toBe(1)
    expect(score.misattributedFindings).toBe(1)
    expect(score.misdiagnosedSourceIds).toEqual(["logic-0"])
    expect(score.precision).toBe(0)
  })

  it("does not satisfy diagnosis tokens from evidence refs alone", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One issue.",
        confidence: 4,
        confidenceReason: "Source retained.",
        findings: [
          {
            path: "src/api/orders.ts",
            line: 5,
            score: 4,
            category: "logic",
            headline: "Missing authorization check",
            body: "The handler returns an arbitrary order without checking ownership.",
            evidenceRefs: ["token:tenantId"],
          },
        ],
      },
      provenance: {
        findings: [
          { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
        ],
        dropped: [],
      },
      elapsedMs: 9_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(cleanCase, synthOutput)

    expect(score.retained).toBe(0)
    expect(score.misdiagnosedSourceIds).toEqual(["logic-0"])
  })

  it("does not let duplicate compression collapse two distinct same-file bugs", () => {
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One merged issue.",
        confidence: 4,
        confidenceReason: "Both sources point at checkout.",
        findings: [
          {
            path: "src/checkout.ts",
            line: 5,
            score: 4,
            category: "logic",
            headline: "Checkout bug",
            body: "The checkout path skips `reserveInventory` and also mishandles idempotency tokens.",
          },
        ],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic", "performance"],
            sourceFindingIds: ["logic-0", "performance-0"],
            action: "merged",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
      },
      elapsedMs: 14_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(collisionCase, synthOutput)

    expect(score.retained).toBe(1)
    expect(score.duplicateCollapses).toBe(1)
    expect(score.missedSourceIds).toEqual(["performance-0"])
  })

  it("allows explicitly combinable expected bugs to share one synth finding", () => {
    const combinableCase = {
      ...collisionCase,
      mustKeep: collisionCase.mustKeep.map((keep) => ({ ...keep, allowCombination: true })),
    }
    const synthOutput: SynthRetentionOutput = {
      verdict: {
        summary: "One combined issue.",
        confidence: 4,
        confidenceReason: "Both failures share the same fix.",
        findings: [
          {
            path: "src/checkout.ts",
            line: 5,
            score: 4,
            category: "logic",
            headline: "Checkout needs an atomic reservation and idempotency guard",
            body: "The checkout path skips `reserveInventory` and also mishandles idempotency tokens.",
          },
        ],
      },
      provenance: {
        findings: [
          {
            sourceSpecialists: ["logic", "performance"],
            sourceFindingIds: ["logic-0", "performance-0"],
            action: "merged",
            verifiedViaRetrieval: false,
          },
        ],
        dropped: [],
      },
      elapsedMs: 14_000,
      modelUsed: "gpt-oss:120b-cloud",
    }

    const score = scoreSynthRetentionCase(combinableCase, synthOutput)

    expect(score.retained).toBe(2)
    expect(score.duplicateCollapses).toBe(0)
    expect(score.missedSourceIds).toEqual([])
  })

  it("rejects must-keep oracle entries without diagnosis tokens", () => {
    const invalidCase = {
      ...cleanCase,
      mustKeep: [{ ...cleanCase.mustKeep[0]!, requiredTokens: [] }],
    }

    expect(() => scoreSynthRetentionCase(invalidCase, {
      verdict: {
        summary: "No issues.",
        confidence: 4,
        confidenceReason: "Clean.",
        findings: [],
      },
      provenance: { findings: [], dropped: [] },
      elapsedMs: 1_000,
      modelUsed: "gpt-oss:120b-cloud",
    })).toThrow(/requiredTokens/)
  })
})

describe("synth-retention summary", () => {
  it("reports recall, FP filtering, hallucination rate, severity drift, duplicate collapse, and runtime", () => {
    const results = [
      scoreSynthRetentionCase(cleanCase, {
        verdict: {
          summary: "One issue.",
          confidence: 4,
          confidenceReason: "Source retained.",
          findings: [
            {
              path: "src/api/orders.ts",
              line: 5,
              score: 4,
              category: "logic",
              headline: "Missing authorization check",
              body: "The handler returns another tenant's order without checking `tenantId`.",
            },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-0"], action: "kept", verifiedViaRetrieval: false },
          ],
          dropped: [
            {
              specialist: "security",
              sourceFindingId: "security-0",
              headline: "SSRF via Content-Type",
              reason: "false positive on diff inspection",
            },
          ],
        },
        elapsedMs: 10_000,
        modelUsed: "gpt-oss:120b-cloud",
      }),
      scoreSynthRetentionCase(cleanCase, {
        verdict: {
          summary: "Invented issue plus one carried FP.",
          confidence: 4,
          confidenceReason: "No source.",
          findings: [
            {
              path: "src/parse/ndjson.ts",
              line: 4,
              score: 4,
              category: "security",
              headline: "SSRF via Content-Type",
              body: "No specialist source backed this finding.",
            },
            {
              path: "src/parse/ndjson.ts",
              line: 4,
              score: 4,
              category: "security",
              headline: "SSRF via Content-Type",
              body: "The parser trusts a response Content-Type header that is not present in the diff.",
            },
          ],
        },
        provenance: {
          findings: [
            { sourceSpecialists: [], sourceFindingIds: ["security-99"], action: "kept", verifiedViaRetrieval: false },
            { sourceSpecialists: ["security"], sourceFindingIds: ["security-0"], action: "kept", verifiedViaRetrieval: false },
          ],
          dropped: [],
        },
        elapsedMs: 20_000,
        modelUsed: "gpt-oss:120b-cloud",
      }),
    ]

    const summary = summarizeSynthRetentionResults(results)

    expect(summary.recall).toBe(0.5)
    expect(summary.fpFilteringRate).toBe(0.5)
    expect(summary.hallucinationRate).toBe(0.5)
    expect(summary.misattributions).toBe(0)
    expect(summary.p95ElapsedMs).toBe(20_000)
  })
})
