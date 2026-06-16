import { describe, expect, it } from "vitest"
import { buildSynthesizerInitialMessage } from "@/src/prompts/pr-review-specialists"
import type { PrReviewVerdict } from "@/src/shared/domain/pr-review-finding"
import { applySynthSourceFindingFloor } from "@/src/lib/degraded-finding-floor"
import { isFindingAnchorable } from "@/src/lib/ensemble/render/finding-format"
import {
  buildBatchFactBlockForRole,
  buildEnforcedReviewUnion,
  mergeSecurityManifestWithUnionSecrets,
  namespaceBatchVerdict,
  renderSynthCoverageScopeBlock,
  selectCrossBatchSeamFiles,
  shouldHaltForSynthInputCap,
} from "./multibatch-enforce"

const diffBlock = (path: string, line: number): { path: string; body: string; charCount: number } => {
  const body = `diff --git a/${path} b/${path}
index 0000000..1111111 100644
--- a/${path}
+++ b/${path}
@@ -${line},0 +${line},1 @@
+const value${line} = ${line}
`
  return { path, body, charCount: body.length }
}

const verdictWithFinding = (path: string, line: number, headline: string): PrReviewVerdict => ({
  summary: "found issue",
  confidence: 4,
  confidenceReason: "test fixture",
  findings: [
    {
      path,
      line,
      score: 4,
      category: "logic",
      headline,
      body: "Concrete issue body.",
    },
  ],
})

describe("buildEnforcedReviewUnion", () => {
  it("rebuilds diff, file paths, reviewable positions, and skipped files over launched batches only", () => {
    const batch0 = [diffBlock("src/a.ts", 10)]
    const launchedBatch1 = [diffBlock("src/b.ts", 20)]
    const unlaunchedBatch2 = [diffBlock("src/c.ts", 30)]

    const union = buildEnforcedReviewUnion({
      reviewedFiles: batch0,
      launchedBatches: [launchedBatch1],
      unlaunchedBatches: [unlaunchedBatch2],
      droppedTooLarge: ["src/huge.ts"],
    })

    expect(union.reviewedFiles.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(union.filesNotReviewed).toEqual(["src/c.ts"])
    expect(union.diff).toContain("diff --git a/src/a.ts b/src/a.ts")
    expect(union.diff).toContain("diff --git a/src/b.ts b/src/b.ts")
    expect(union.diff).not.toContain("diff --git a/src/c.ts b/src/c.ts")
    expect(union.filePaths).toEqual(["src/a.ts", "src/b.ts"])
    expect(union.reviewable.has("src/a.ts")).toBe(true)
    expect(union.reviewable.has("src/b.ts")).toBe(true)
    expect(union.reviewable.has("src/c.ts")).toBe(false)
    expect(union.disclosureSkipped).toEqual(["src/c.ts", "src/huge.ts"])
  })
})

describe("namespaceBatchVerdict", () => {
  it("namespaces spillover findings role-first so validation provenance can infer the source role", () => {
    const namespaced = namespaceBatchVerdict("logic", 1, verdictWithFinding("src/b.ts", 20, "batch one bug"))

    expect(namespaced.findings).toHaveLength(1)
    expect(namespaced.findings[0]?.id).toBe("logic-b1-0")
    expect(namespaced.findings[0]?.id.startsWith("logic-")).toBe(true)
  })
})

describe("spillover batch facts", () => {
  it("renders deterministic logic facts from the batch diff before the spillover model call", async () => {
    const block = await buildBatchFactBlockForRole({
      role: "logic",
      batchDiff: `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,0 +1,1 @@
+console.log("debug")
`,
      sigilixConfig: {
        deterministicChecks: [
          {
            id: "no-console",
            pattern: "console[.]log",
            severity: "error",
            message: "Do not commit debug logging.",
          },
        ],
      },
    })

    expect(block).toContain("[DETERMINISTIC CHECKS")
    expect(block).toContain("src/b.ts:1")
    expect(block).toContain("no-console")
  })

  it("merges union secret facts into the validation manifest for batch-1 security findings", async () => {
    const merged = await mergeSecurityManifestWithUnionSecrets(
      {
        manifest: new Map(),
        render: () => "",
      },
      `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,0 +1,1 @@
+const key = "AKIAIOSFODNN7EXAMPLE"
`,
    )

    expect([...merged.manifest.values()].map((fact) => fact.path)).toEqual(["src/b.ts"])
    expect([...merged.manifest.keys()][0]).toMatch(/^secret:aws-access-key:/)
  })
})

describe("selectCrossBatchSeamFiles", () => {
  it("selects high-risk graph-connected reviewed files that cross launched batch boundaries", () => {
    const batch0 = [diffBlock("src/auth-session.ts", 10), diffBlock("src/ui.ts", 12)]
    const batch1 = [diffBlock("src/payment-callback.ts", 20)]
    const batch2Unlaunched = [diffBlock("src/secret-admin.ts", 30)]

    const seam = selectCrossBatchSeamFiles({
      reviewedBatches: [batch0, batch1],
      unlaunchedBatches: [batch2Unlaunched],
      graphBlastCallerPaths: ["src/auth-session.ts", "src/payment-callback.ts", "src/secret-admin.ts"],
      graphBlastDependentPaths: [],
    })

    expect(seam.map((file) => file.path)).toEqual(["src/auth-session.ts", "src/payment-callback.ts"])
  })

  it("returns no seam batch when the only connected counterpart was not launched", () => {
    const batch0 = [diffBlock("src/auth-session.ts", 10)]
    const unlaunched = [diffBlock("src/payment-callback.ts", 20)]

    const seam = selectCrossBatchSeamFiles({
      reviewedBatches: [batch0],
      unlaunchedBatches: [unlaunched],
      graphBlastCallerPaths: ["src/auth-session.ts", "src/payment-callback.ts"],
      graphBlastDependentPaths: [],
    })

    expect(seam).toEqual([])
  })
})

describe("renderSynthCoverageScopeBlock", () => {
  it("renders an honest SIG-443 synth-input coverage block for deadline-halted partial coverage", () => {
    const block = renderSynthCoverageScopeBlock({
      reviewedFiles: ["src/a.ts", "src/b.ts"],
      skippedFiles: ["src/c.ts"],
      haltReason: "deadline",
    })

    expect(block).toContain("[REVIEW COVERAGE SCOPE]")
    expect(block).toContain("Reviewed files (2/3): src/a.ts, src/b.ts")
    expect(block).toContain("Skipped or not launched files (1/3): src/c.ts")
    expect(block).toContain("Do NOT describe the whole PR as fully reviewed")
    expect(block).toContain("Do NOT claim zero risk, no production logic changed, or no issues for the whole PR")
    expect(block).toContain("Deadline/budget halted")
  })

  it("returns an empty block for full launched coverage so off/shadow synth prompts stay byte-identical", () => {
    expect(
      renderSynthCoverageScopeBlock({
        reviewedFiles: ["src/a.ts", "src/b.ts"],
        skippedFiles: [],
        haltReason: null,
      }),
    ).toBe("")
  })

  it("is included in the synth prompt before the diff when supplied", () => {
    const coverageScopeBlock = renderSynthCoverageScopeBlock({
      reviewedFiles: ["src/a.ts"],
      skippedFiles: ["src/b.ts"],
      haltReason: "synth-input-cap",
    })
    const message = buildSynthesizerInitialMessage({
      prNumber: 418,
      diff: "diff --git a/src/a.ts b/src/a.ts",
      specialistVerdictsBlock: "=== LOGIC ===\n{}",
      coverageScopeBlock,
    })

    expect(message.indexOf("[REVIEW COVERAGE SCOPE]")).toBeGreaterThanOrEqual(0)
    expect(message.indexOf("[REVIEW COVERAGE SCOPE]")).toBeLessThan(message.indexOf("[DIFF]"))
  })
})

describe("shouldHaltForSynthInputCap", () => {
  it("halts before launching another batch when the current source union plus candidate diff would exceed the synth-input cap", () => {
    const decision = shouldHaltForSynthInputCap({
      currentUnionInputChars: 1_000,
      candidateBatchDiffChars: 800,
      maxSynthInputChars: 1_500,
    })

    expect(decision).toEqual({ halt: true, reason: "synth-input-cap" })
  })

  it("continues when the next batch can fit without requiring source-finding truncation", () => {
    const decision = shouldHaltForSynthInputCap({
      currentUnionInputChars: 1_000,
      candidateBatchDiffChars: 400,
      maxSynthInputChars: 1_500,
    })

    expect(decision).toEqual({ halt: false, reason: null })
  })
})

describe("batch-1 source floor and anchorability", () => {
  it("restores a synth-dropped batch-1 P1 and the enforced reviewable union lets it anchor inline", () => {
    const batch0 = [diffBlock("src/a.ts", 10)]
    const launchedBatch1 = [diffBlock("src/b.ts", 20)]
    const sourceFinding = namespaceBatchVerdict("logic", 1, verdictWithFinding("src/b.ts", 20, "batch one bug"))
      .findings[0]!

    const floored = applySynthSourceFindingFloor({
      findings: [],
      provenanceFindings: [],
      provenanceDropped: [],
      specialists: [{ role: "logic", findings: [sourceFinding] }],
    })
    const union = buildEnforcedReviewUnion({
      reviewedFiles: batch0,
      launchedBatches: [launchedBatch1],
      unlaunchedBatches: [],
      droppedTooLarge: [],
    })
    const batch0Only = buildEnforcedReviewUnion({
      reviewedFiles: batch0,
      launchedBatches: [],
      unlaunchedBatches: [launchedBatch1],
      droppedTooLarge: [],
    })

    expect(floored.restored).toEqual([{ role: "logic", id: "logic-b1-0", score: 4, headline: "batch one bug" }])
    expect(floored.provenanceFindings[0]?.sourceFindingIds).toEqual(["logic-b1-0"])
    expect(isFindingAnchorable(floored.findings[0]!, union.reviewable)).toBe(true)
    expect(isFindingAnchorable(floored.findings[0]!, batch0Only.reviewable)).toBe(false)
  })
})
