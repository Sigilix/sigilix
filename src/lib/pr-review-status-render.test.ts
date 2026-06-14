import { describe, expect, it } from "vitest"
import {
  REVIEW_STATUS_BLOCK_END,
  REVIEW_STATUS_BLOCK_START,
  buildReviewStatusBlock,
  upsertReviewStatusBlock,
} from "@/src/lib/pr-review-status-render"
import { REVIEW_STATUS_ASCII_FOOTERS, selectReviewStatusAsciiFooter } from "@/src/lib/pr-review-status-ascii"
import { OVERVIEW_MARKER } from "@/src/lib/triage-pr-overview-scan"

const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12"

describe("review status renderer", () => {
  it("renders a queued waiting block with SHA, phase, progress, and ASCII footer", () => {
    const block = buildReviewStatusBlock({
      phase: "queued",
      headSha: HEAD_SHA,
      sequence: 1,
      specialists: {
        total: 4,
        completed: 0,
        dispatched: ["logic", "security", "performance", "tests"],
      },
      footerSeed: "Sigilix/sigilix#7@abcdef1",
    })

    expect(block).toContain(REVIEW_STATUS_BLOCK_START)
    expect(block).toContain(REVIEW_STATUS_BLOCK_END)
    expect(block).toContain("Queued")
    expect(block).toContain("`abcdef1`")
    expect(block).toContain("0/4")
    expect(block).toContain("logic, security, performance, tests")
    expect(block).toContain("```text")
  })

  it("renders dropped files, graph coverage, degraded roles, and final review link", () => {
    const block = buildReviewStatusBlock({
      phase: "degraded",
      headSha: HEAD_SHA,
      sequence: 9,
      specialists: {
        total: 4,
        completed: 3,
        succeeded: ["logic", "security", "tests"],
        failed: ["performance"],
        missing: ["performance"],
      },
      droppedFiles: ["dist/bundle.js", "pnpm-lock.yaml"],
      graphCoverage: {
        mode: "partial",
        filesWithContext: 5,
        totalFiles: 8,
        nodes: 19,
      },
      final: {
        status: "posted",
        findingsCount: 2,
        surface: "review",
        reviewUrl: "https://github.com/Sigilix/sigilix/pull/7#pullrequestreview-123",
      },
      footerSeed: "Sigilix/sigilix#7@abcdef1",
    })

    expect(block).toContain("Degraded")
    expect(block).toContain("3/4")
    expect(block).toContain("performance")
    expect(block).toContain("dist/bundle.js")
    expect(block).toContain("pnpm-lock.yaml")
    expect(block).toContain("5/8 files")
    expect(block).toContain("19 nodes")
    expect(block).toContain("[View review](https://github.com/Sigilix/sigilix/pull/7#pullrequestreview-123)")
    expect(block).toContain("2 findings")
  })

  it("renders specialists that were not needed", () => {
    const block = buildReviewStatusBlock({
      phase: "skipped",
      headSha: HEAD_SHA,
      sequence: 4,
      specialists: {
        total: 0,
        completed: 0,
        notNeeded: ["logic", "security", "performance", "tests"],
      },
      final: { status: "skipped", findingsCount: 0 },
    })

    expect(block).toContain("Skipped")
    expect(block).toContain("**Not needed:** logic, security, performance, tests")
  })

  it("upserts the status block without disturbing overview body content", () => {
    const body = `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\n### Summary\n\nKeep this summary.`
    const updated = upsertReviewStatusBlock(body, {
      phase: "retrieval",
      headSha: HEAD_SHA,
      sequence: 2,
      footerSeed: "first",
    })
    const replaced = upsertReviewStatusBlock(updated, {
      phase: "synth",
      headSha: HEAD_SHA,
      sequence: 5,
      footerSeed: "second",
    })

    expect(updated).toContain("Keep this summary.")
    expect(replaced).toContain("Keep this summary.")
    expect(replaced.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(replaced).not.toContain("Retrieval")
    expect(replaced).toContain("Synth")
  })

  it("ships many deterministic ASCII footer variants and keeps them ASCII-only", () => {
    expect(REVIEW_STATUS_ASCII_FOOTERS.length).toBeGreaterThanOrEqual(24)
    for (const footer of REVIEW_STATUS_ASCII_FOOTERS) {
      expect(/^[\x00-\x7F]+$/.test(footer.lines.join("\n"))).toBe(true)
      expect(footer.lines.join("\n")).toMatch(/[*.]|SIGILIX|star|orbit|constellation/i)
    }

    const one = selectReviewStatusAsciiFooter("Sigilix/sigilix#7@a")
    const two = selectReviewStatusAsciiFooter("Sigilix/sigilix#7@b")
    expect(one).not.toBe(two)
  })
})
