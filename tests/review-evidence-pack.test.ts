import { describe, expect, it } from "vitest"

import {
  buildDynamicReviewEvidencePack,
  dynamicReviewEvidenceEnabled,
  dynamicReviewEvidenceMode,
  renderDynamicReviewEvidenceBlock,
} from "../src/lib/review-evidence-pack"
import type { ChangedLines } from "@/features/ast-rules/domain/diff-filter"
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

  it("does not mark changed symbol lines as covered until they are emitted", () => {
    const bodyLines = Array.from({ length: 15 }, (_, i) => `  const value${i + 1} = ${i + 1}`)
    const filesByPath = new Map([
      [
        "src/large-symbol.ts",
        [
          "export function largeSymbol(): number {",
          ...bodyLines,
          "  return value15",
          "}",
        ].join("\n"),
      ],
    ])
    const changedRange = Array.from({ length: 15 }, (_, i) => i + 2)
    const changedLines: ChangedLines = new Map([["src/large-symbol.ts", new Set(changedRange)]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/large-symbol.ts"],
    })

    expect(pack.cards).toHaveLength(2)
    expect(pack.cards[0]?.symbolName).toBe("largeSymbol")
    expect(pack.cards[0]?.changedLines).toEqual(changedRange.slice(0, 12))
    expect(pack.cards[1]?.symbolName).toBeNull()
    expect(pack.cards[1]?.changedLines).toEqual(changedRange.slice(12))
    expect(pack.cards.flatMap((card) => card.changedLines)).toEqual(changedRange)
  })

  it("clamps local snippets when a changed symbol is larger than the snippet budget", () => {
    const bodyLines = Array.from({ length: 40 }, (_, i) => `  const value${i + 1} = ${i + 1}`)
    const filesByPath = new Map([
      [
        "src/wide-symbol.ts",
        [
          "export function wideSymbol(): number {",
          ...bodyLines,
          "  return value40",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/wide-symbol.ts", new Set([20, 21])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/wide-symbol.ts"],
    })

    expect(pack.cards).toHaveLength(1)
    expect(pack.cards[0]?.startLine).toBe(12)
    expect(pack.cards[0]?.endLine).toBe(35)
    expect(pack.cards[0]?.localSnippet.split("\n")).toHaveLength(24)
    expect(pack.cards[0]?.localSnippet).toContain("> 20 |   const value19 = 19")
    expect(pack.cards[0]?.localSnippet).toContain("> 21 |   const value20 = 20")
  })

  it("uses longer fences when snippets or excerpts contain backticks", () => {
    const filesByPath = new Map([
      [
        "src/fences.ts",
        [
          "export function renderFence(): string {",
          "  return \"```\"",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/fences.ts", new Set([2])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/fences.ts"],
      retrievalChunks: [{
        path: "src/fence-consumer.ts",
        lineStart: 1,
        lineEnd: 3,
        score: 0.75,
        content: "renderFence()\nconst literal = \"```\"",
      }],
    })

    const rendered = renderDynamicReviewEvidenceBlock(pack)
    expect(rendered).toContain("````ts\n")
    expect(rendered).toContain("  ````\n  renderFence()")
  })

  it("does not attach unrelated inspected tests to a source card", () => {
    const filesByPath = new Map([
      [
        "src/no-map.ts",
        [
          "export function changed(): number {",
          "  return 1",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/no-map.ts", new Set([2])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/no-map.ts"],
      testingEvidence: {
        sourceFilesChanged: ["src/no-map.ts"],
        testFilesChanged: ["tests/unrelated.test.ts"],
        testFilesInPromptDiff: ["tests/unrelated.test.ts"],
        testFilesNotInPromptDiff: [],
        siblingMappings: [],
        inspectedTestFiles: ["tests/unrelated.test.ts"],
        helperCoverageBySource: {},
      },
    })

    expect(pack.cards[0]?.testingContext.inspectedTestFiles).toEqual([])
  })

  it("matches changed symbols whose names contain dollar signs", () => {
    const filesByPath = new Map([
      [
        "src/dollar-symbols.ts",
        [
          "export function $parse(input: string): string {",
          "  return input.trim()",
          "}",
          "",
          "export function render$(input: string): string {",
          "  return input.toUpperCase()",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/dollar-symbols.ts", new Set([2, 6])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/dollar-symbols.ts"],
      graphNodes: [{
        path: "src/dollar-consumer.ts",
        symbolId: null,
        name: null,
        hop: 1,
        edgeKind: "import",
      }],
      retrievalChunks: [{
        path: "src/dollar-consumer.ts",
        lineStart: 20,
        lineEnd: 24,
        score: 0.9,
        content: [
          "const parsed = $parse(source)",
          "const rendered = render$(parsed)",
        ].join("\n"),
      }],
    })

    const bySymbol = new Map(pack.cards.map((card) => [card.symbolName, card]))

    expect(bySymbol.get("$parse")?.retrievalRefs[0]).toMatchObject({
      path: "src/dollar-consumer.ts",
      reason: "mentions changed symbol + graph-related",
    })
    expect(bySymbol.get("$parse")?.retrievalRefs[0]?.excerpt).toContain("$parse(source)")
    expect(bySymbol.get("render$")?.retrievalRefs[0]).toMatchObject({
      path: "src/dollar-consumer.ts",
      reason: "mentions changed symbol + graph-related",
    })
    expect(bySymbol.get("render$")?.retrievalRefs[0]?.excerpt).toContain("render$(parsed)")
  })

  it("does not match ASCII symbols inside larger Unicode identifiers", () => {
    const filesByPath = new Map([
      [
        "src/unicode-boundary.ts",
        [
          "export function parse(input: string): string {",
          "  return input.trim()",
          "}",
        ].join("\n"),
      ],
    ])
    const changedLines: ChangedLines = new Map([["src/unicode-boundary.ts", new Set([2])]])

    const pack = buildDynamicReviewEvidencePack({
      filesByPath,
      changedLines,
      reviewablePaths: ["src/unicode-boundary.ts"],
      graphNodes: [{
        path: "src/unicode-neighbor.ts",
        symbolId: null,
        name: null,
        hop: 1,
        edgeKind: "import",
      }],
      retrievalChunks: [
        {
          path: "src/unicode-neighbor.ts",
          lineStart: 1,
          lineEnd: 1,
          score: 0.9,
          content: "const wrong = parseΩ(source)",
        },
        {
          path: "src/plain-consumer.ts",
          lineStart: 1,
          lineEnd: 1,
          score: 0.2,
          content: "const right = parse(source)",
        },
      ],
    })

    const refsByPath = new Map(pack.cards[0]?.retrievalRefs.map((ref) => [ref.path, ref]) ?? [])
    expect(refsByPath.get("src/unicode-neighbor.ts")?.reason).toBe("graph-related")
    expect(refsByPath.get("src/plain-consumer.ts")?.reason).toBe("mentions changed symbol")
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
