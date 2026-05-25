import { describe, expect, it } from "vitest"

import {
  buildDynamicReviewEvidencePack,
  dynamicReviewEvidenceEnabled,
  dynamicReviewEvidenceMode,
  renderDynamicReviewEvidenceBlock,
} from "../src/lib/review-evidence-pack"
import type { ChangedLines } from "../src/lib/ast-rules/diff-filter"
import type { TestingEvidencePack } from "../src/lib/testing-evidence-pack"

describe("dynamicReviewEvidenceMode", () => {
  it("recognizes shadow and post modes only", () => {
    expect(dynamicReviewEvidenceMode({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "shadow" })).toBe("shadow")
    expect(dynamicReviewEvidenceMode({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "post" })).toBe("post")
    expect(dynamicReviewEvidenceMode({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "on" })).toBe("off")
    expect(dynamicReviewEvidenceMode({})).toBe("off")
  })

  it("is enabled only outside off mode", () => {
    expect(dynamicReviewEvidenceEnabled({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "shadow" })).toBe(true)
    expect(dynamicReviewEvidenceEnabled({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "post" })).toBe(true)
    expect(dynamicReviewEvidenceEnabled({ OPENCLAW_DYNAMIC_REVIEW_EVIDENCE: "off" })).toBe(false)
  })
})

describe("buildDynamicReviewEvidencePack", () => {
  const testingEvidence: TestingEvidencePack = {
    sourceFilesChanged: ["src/parser.ts"],
    testFilesChanged: ["tests/parser.test.ts"],
    testFilesInPromptDiff: ["tests/parser.test.ts"],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/parser.ts", test: "tests/parser.test.ts" }],
    inspectedTestFiles: ["tests/parser.test.ts"],
    helperCoverageBySource: {},
  }

  it("builds changed-symbol cards with local, graph, retrieval, and testing context", () => {
    const filesByPath = new Map([
      [
        "src/parser.ts",
        [
          "export function parseFinalAnswer(response: string): string {",
          "  const match = response.match(/FINAL\\((.*)\\)/)",
          "  return match?.[1] ?? \"\"",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/parser.ts", new Set([2, 3])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/parser.ts"],
      retrievalChunks: [{
        path: "src/repl.ts",
        lineStart: 10,
        lineEnd: 18,
        score: 0.82,
        content: "const answer = parseFinalAnswer(response)\nreturn answer",
      }],
      graphNodes: [{
        path: "src/repl.ts",
        symbolId: null,
        name: null,
        hop: 1,
        edgeKind: "import",
      }],
      blastCallerPaths: ["src/runner.ts"],
      blastDependentPaths: [],
      testingEvidence,
    })

    expect(pack.cards).toHaveLength(1)
    expect(pack.cards[0]?.symbolName).toBe("parseFinalAnswer")
    expect(pack.cards[0]?.changedLines).toEqual([2, 3])
    expect(pack.cards[0]?.localSnippet).toContain("> 2 |   const match")
    expect(pack.cards[0]?.graphRelations).toEqual([
      { path: "src/repl.ts", relation: "hop1/import" },
      { path: "src/runner.ts", relation: "blast/caller" },
    ])
    expect(pack.cards[0]?.retrievalRefs[0]?.reason).toBe("mentions changed symbol + graph-related")
    expect(pack.cards[0]?.testingContext.siblingRefs).toEqual([
      "siblingMapping:src/parser.ts->tests/parser.test.ts",
    ])

    const rendered = renderDynamicReviewEvidenceBlock(pack)
    expect(rendered).toContain("[DYNAMIC REVIEW EVIDENCE")
    expect(rendered).toContain("Card 1: src/parser.ts:1-4")
    expect(rendered).toContain("function `parseFinalAnswer`")
    expect(rendered).toContain("Related retrieved chunks:")
    expect(rendered).toContain("inspectedTestFile:tests/parser.test.ts")
  })

  it("falls back to a changed file-region card when no symbol is available", () => {
    const filesByPath = new Map([
      ["src/constants.ts", ["const one = 1", "const two = 2"].join("\n")],
    ])
    const changedLines: ChangedLines = new Map([["src/constants.ts", new Set([2])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/constants.ts"],
    })

    expect(pack.cards).toHaveLength(1)
    expect(pack.cards[0]?.symbolName).toBeNull()
    expect(pack.cards[0]?.localSnippet).toContain("> 2 | const two = 2")
    expect(renderDynamicReviewEvidenceBlock(pack)).toContain("changed file region")
  })
})
