import { describe, expect, it } from "vitest"

import { decideLearningSuppressions, type SuppressibleFinding } from "@/src/features/learnings/domain/suppress"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import { SUPPRESS_FLOOR_TIER } from "@/src/features/precision-profile"

const TS = "2026-06-15T12:00:00.000Z"

function learning(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "rule1",
    rule: overrides.rule ?? "Treat generated SDK files as context only.",
    polarity: overrides.polarity ?? "suppress",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "command", prNumber: 7, commentId: 99 },
    createdTs: overrides.createdTs ?? TS,
    appliedCount: overrides.appliedCount ?? 0,
  }
}

function finding(overrides: Partial<SuppressibleFinding> = {}): SuppressibleFinding {
  return {
    score: overrides.score ?? 2,
    category: overrides.category ?? "style",
    path: overrides.path ?? "src/generated/sdk.ts",
    sourceSpecialists: overrides.sourceSpecialists ?? ["tests"],
    ...(overrides.sourceFindingIds !== undefined ? { sourceFindingIds: overrides.sourceFindingIds } : {}),
    ...(overrides.astEvidence !== undefined ? { astEvidence: overrides.astEvidence } : {}),
    ...(overrides.cweId !== undefined ? { cweId: overrides.cweId } : {}),
    ...(overrides.evidenceId !== undefined ? { evidenceId: overrides.evidenceId } : {}),
    ...(overrides.evidenceRefs !== undefined ? { evidenceRefs: overrides.evidenceRefs } : {}),
  }
}

describe("decideLearningSuppressions — happy path", () => {
  it("suppresses a low-severity noise finding on a narrow pathGlob match", () => {
    const result = decideLearningSuppressions(
      [finding({ path: "src/generated/sdk.ts", category: "style", score: 2, sourceSpecialists: ["tests"] })],
      [learning({ id: "gen", pathGlob: "src/generated/**" })],
    )
    expect(result.suppressions).toHaveLength(1)
    expect(result.suppressions[0]).toMatchObject({ index: 0, learningId: "gen", basis: "path" })
    expect(result.carveOutKeeps).toHaveLength(0)
  })

  it("suppresses on a category match and reports path+category for a doubly-scoped learning", () => {
    const catOnly = decideLearningSuppressions(
      [finding({ category: "style", path: "src/app/x.ts", sourceSpecialists: ["performance"] })],
      [learning({ id: "cat", category: "style", pathGlob: null })],
    )
    expect(catOnly.suppressions[0]).toMatchObject({ basis: "category" })

    const both = decideLearningSuppressions(
      [finding({ category: "style", path: "src/generated/x.ts", sourceSpecialists: ["performance"] })],
      [learning({ id: "both", category: "style", pathGlob: "src/generated/**" })],
    )
    expect(both.suppressions[0]).toMatchObject({ basis: "path+category" })
  })

  it("only acts on suppress-polarity learnings — require/context never suppress", () => {
    const result = decideLearningSuppressions(
      [finding({ path: "src/generated/sdk.ts" })],
      [
        learning({ id: "req", polarity: "require", pathGlob: "src/generated/**" }),
        learning({ id: "ctx", polarity: "context", pathGlob: "src/generated/**" }),
      ],
    )
    expect(result.suppressions).toHaveLength(0)
    expect(result.carveOutKeeps).toHaveLength(0)
  })
})

// ── THE RECALL-SAFETY CARVE-OUTS — each test FAILS if its guard is removed ──
describe("decideLearningSuppressions — hard carve-outs (recall-safety)", () => {
  it("NEVER suppresses a P0/P1 (score >= SUPPRESS_FLOOR_TIER), recording it as a carve-out keep", () => {
    for (const score of [SUPPRESS_FLOOR_TIER, 5]) {
      const result = decideLearningSuppressions(
        // A perfectly-matching suppress learning on a blocker finding.
        [finding({ score, path: "src/generated/sdk.ts", category: "style", sourceSpecialists: ["tests"] })],
        [learning({ id: "gen", pathGlob: "src/generated/**" })],
      )
      expect(result.suppressions).toHaveLength(0)
      expect(result.carveOutKeeps).toHaveLength(1)
      expect(result.carveOutKeeps[0]).toMatchObject({ index: 0, learningId: "gen", reason: "p0p1-floor" })
    }
  })

  it("NEVER suppresses a SECURITY/LOGIC finding keyed on PROVENANCE, even when miscategorized", () => {
    for (const role of ["security", "logic"] as const) {
      const result = decideLearningSuppressions(
        // Synth category is the innocuous matched one (tests/style) — but the
        // SOURCE specialist is security/logic. The carve-out must key on the
        // provenance, not the (mis)category. (spec §12.4 #139)
        [
          finding({
            score: 2,
            category: "style",
            path: "src/generated/sdk.ts",
            sourceSpecialists: [role],
          }),
        ],
        [learning({ id: "gen", pathGlob: "src/generated/**", category: "style" })],
      )
      expect(result.suppressions).toHaveLength(0)
      expect(result.carveOutKeeps[0]).toMatchObject({ reason: "security-logic-provenance" })
    }
  })

  it("NEVER suppresses when the SOURCE-ID prefix is security/logic even if sourceSpecialists is malformed", () => {
    // `sourceSpecialists` is synth-reported and can lie/be empty; the `<role>-<n>`
    // source ids are the authoritative fallback (validation-internals.ts). A finding
    // tagged tests-by-role but security-by-source-id must NOT be suppressed.
    for (const sid of ["security-0", "logic-3"]) {
      const result = decideLearningSuppressions(
        [
          finding({
            score: 2,
            category: "style",
            path: "src/generated/sdk.ts",
            sourceSpecialists: ["tests"],
            sourceFindingIds: [sid],
          }),
        ],
        [learning({ id: "gen", pathGlob: "src/generated/**", category: "style" })],
      )
      expect(result.suppressions, sid).toHaveLength(0)
      expect(result.carveOutKeeps[0]).toMatchObject({ reason: "security-logic-provenance" })
    }
  })

  it("NEVER suppresses a finding grounded by a deterministic evidenceRef (coverage/test fact)", () => {
    for (const ref of [
      "coverageGap:X",
      "inspectedTestFile:tests/a.test.ts",
      "siblingMapping:a->b",
      "testFileChanged:t",
    ]) {
      const result = decideLearningSuppressions(
        [
          finding({
            score: 2,
            category: "style",
            path: "src/generated/sdk.ts",
            sourceSpecialists: ["tests"],
            evidenceRefs: [ref],
          }),
        ],
        [learning({ id: "gen", pathGlob: "src/generated/**" })],
      )
      expect(result.suppressions, ref).toHaveLength(0)
      expect(result.carveOutKeeps[0]).toMatchObject({ reason: "deterministic-evidence" })
    }
  })

  it("NEVER suppresses a finding grounded in deterministic security evidence", () => {
    const groundedVariants: Array<Partial<SuppressibleFinding>> = [
      { astEvidence: "redacted code slice" },
      { cweId: "CWE-89" },
      { evidenceId: "secret:rule:hash:42" },
      { evidenceId: "depvuln:CVE-2025-1" },
      { evidenceId: "sarif:trivy:1" },
      { evidenceId: "ast/no-eval-call/abc/9" },
    ]
    for (const grounded of groundedVariants) {
      const result = decideLearningSuppressions(
        // Provenance is a non-security role so ONLY the evidence carve-out can spare it.
        [
          finding({
            score: 2,
            category: "style",
            path: "src/generated/sdk.ts",
            sourceSpecialists: ["tests"],
            ...grounded,
          }),
        ],
        [learning({ id: "gen", pathGlob: "src/generated/**" })],
      )
      expect(result.suppressions, JSON.stringify(grounded)).toHaveLength(0)
      expect(result.carveOutKeeps[0]).toMatchObject({ reason: "deterministic-evidence" })
    }
  })

  it("a NONE / empty evidenceId is NOT grounding (still suppressible)", () => {
    for (const evidenceId of ["NONE", "none", "  ", ""]) {
      const result = decideLearningSuppressions(
        [
          finding({
            score: 2,
            category: "style",
            path: "src/generated/sdk.ts",
            sourceSpecialists: ["tests"],
            evidenceId,
          }),
        ],
        [learning({ id: "gen", pathGlob: "src/generated/**" })],
      )
      expect(result.suppressions, evidenceId).toHaveLength(1)
    }
  })

  it("FAILS CLOSED: unknown provenance (empty sourceSpecialists) is never suppressed", () => {
    const result = decideLearningSuppressions(
      [finding({ score: 2, category: "style", path: "src/generated/sdk.ts", sourceSpecialists: [] })],
      [learning({ id: "gen", pathGlob: "src/generated/**" })],
    )
    expect(result.suppressions).toHaveLength(0)
    expect(result.carveOutKeeps[0]).toMatchObject({ reason: "security-logic-provenance" })
  })
})

describe("decideLearningSuppressions — narrow-match discipline", () => {
  it("a BLANKET suppress learning (no path AND no category) never suppresses at the gate", () => {
    const result = decideLearningSuppressions(
      [finding({ score: 2, category: "style", path: "src/anywhere.ts", sourceSpecialists: ["tests"] })],
      [learning({ id: "blanket", pathGlob: null, category: null })],
    )
    expect(result.suppressions).toHaveLength(0)
    expect(result.carveOutKeeps).toHaveLength(0)
  })

  it("does not suppress when the cited path/category does not match the finding", () => {
    const pathMiss = decideLearningSuppressions(
      [finding({ path: "src/app/handler.ts", category: "style", sourceSpecialists: ["tests"] })],
      [learning({ id: "gen", pathGlob: "src/generated/**" })],
    )
    expect(pathMiss.suppressions).toHaveLength(0)
    expect(pathMiss.carveOutKeeps).toHaveLength(0)

    const categoryMiss = decideLearningSuppressions(
      [finding({ path: "src/generated/x.ts", category: "performance", sourceSpecialists: ["tests"] })],
      // both dimensions cited — path matches, category does NOT → no match (AND, not OR).
      [learning({ id: "both", pathGlob: "src/generated/**", category: "style" })],
    )
    expect(categoryMiss.suppressions).toHaveLength(0)
  })

  it("each finding yields at most one decision (first narrowly-matching suppress learning wins)", () => {
    const result = decideLearningSuppressions(
      [finding({ path: "src/generated/sdk.ts", category: "style", sourceSpecialists: ["tests"] })],
      [learning({ id: "first", pathGlob: "src/generated/**" }), learning({ id: "second", category: "style" })],
    )
    expect(result.suppressions).toHaveLength(1)
    expect(result.suppressions[0]).toMatchObject({ learningId: "first" })
  })
})
