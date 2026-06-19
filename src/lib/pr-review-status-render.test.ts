import { describe, expect, it } from "vitest"
import {
  REVIEW_STATUS_BLOCK_END,
  REVIEW_STATUS_BLOCK_START,
  buildReviewStatusBlock,
  upsertReviewStatusBlock,
  formatManageLine,
} from "@/src/lib/pr-review-status-render"
import { PR_OVERVIEW_WAITING_ARTS, renderPrOverviewWaitingArt } from "@/src/lib/pr-overview-waiting-art"
import { OVERVIEW_MARKER } from "@/src/lib/triage-pr-overview-scan"

const HEAD_SHA = "abcdef1234567890abcdef1234567890abcdef12"

describe("review status renderer", () => {
  it("renders a queued waiting block with SHA, phase, and progress", () => {
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
    expect(block).toContain("**Phase:** Queued")
    expect(block).toContain("`abcdef1`")
    expect(block).toContain("0/4")
    expect(block).toContain("logic, security, performance, tests")
    expect(block).not.toContain("### Sigilix Review Status")
    expect(block).not.toContain("```text")
  })

  it("renders every review phase label without adding a second ASCII block", () => {
    const phases = ["queued", "retrieval", "specialists", "synth", "posted", "degraded", "skipped", "failed"] as const

    for (const phase of phases) {
      const block = buildReviewStatusBlock({
        phase,
        headSha: HEAD_SHA,
        sequence: 1,
        specialists: {
          total: 4,
          completed: phase === "queued" || phase === "retrieval" || phase === "specialists" ? 0 : 4,
          dispatched: ["logic", "security", "performance", "tests"],
        },
      })

      expect(block).toContain(`**Phase:** ${phase[0]!.toUpperCase()}${phase.slice(1)}`)
      expect(block).not.toContain("```text")
    }
  })

  it("renders dropped files, graph coverage, degraded roles, and final review link without post-review ASCII", () => {
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

    expect(block).toContain("**Phase:** Degraded")
    expect(block).toContain("3/4")
    expect(block).toContain("performance")
    expect(block).toContain("dist/bundle.js")
    expect(block).toContain("pnpm-lock.yaml")
    expect(block).toContain("5/8 files")
    expect(block).toContain("19 nodes")
    expect(block).toContain("[View review](https://github.com/Sigilix/sigilix/pull/7#pullrequestreview-123)")
    expect(block).toContain("2 findings")
    expect(block).not.toContain("```text")
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

    expect(block).toContain("**Phase:** Skipped")
    expect(block).toContain("**Not needed:** logic, security, performance, tests")
  })

  it("upserts the status block at the bottom of the completed overview", () => {
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
    expect(replaced.indexOf("Keep this summary.")).toBeLessThan(replaced.indexOf(REVIEW_STATUS_BLOCK_START))
  })

  it("does not leak waiting ASCII into a posted overview status update", () => {
    const body = `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\n### Summary\n\nDone.`
    const updated = upsertReviewStatusBlock(body, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 8,
      final: {
        status: "posted",
        findingsCount: 1,
        reviewUrl: "https://github.com/Sigilix/sigilix/pull/7",
      },
      footerSeed: "posted::7::abcdef1",
    })

    expect(updated).not.toContain("```text")
    expect(updated).not.toContain(renderPrOverviewWaitingArt("posted:7:abcdef1"))
    for (const art of PR_OVERVIEW_WAITING_ARTS) {
      expect(updated).not.toContain(`== ${art.title} ==`)
    }
  })

  it("moves an old top-level status block into the overview on replacement", () => {
    const oldStatus = [
      REVIEW_STATUS_BLOCK_START,
      "",
      "### Sigilix Review Status",
      "",
      "**Phase:** Posted",
      "",
      "```text",
      "  launch window open",
      "```",
      "",
      REVIEW_STATUS_BLOCK_END,
    ].join("\n")
    const body = `${OVERVIEW_MARKER}\n\n${oldStatus}\n\n## Sigilix Overview\n\n### Summary\n\nKeep this summary.`

    const updated = upsertReviewStatusBlock(body, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 8,
      final: {
        status: "posted",
        findingsCount: 6,
        reviewUrl: "https://github.com/Sigilix/sigilix/pull/540",
      },
    })

    expect(updated.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(updated).not.toContain("### Sigilix Review Status")
    expect(updated).not.toContain("```text")
    expect(updated).not.toContain("launch window open")
    expect(updated).toContain("**Phase:** Posted")
    expect(updated).toContain(
      "**Result:** Posted - 6 findings - [View review](https://github.com/Sigilix/sigilix/pull/540)",
    )
    expect(updated.indexOf("Keep this summary.")).toBeLessThan(updated.indexOf(REVIEW_STATUS_BLOCK_START))
  })

  it("removes a malformed old top-level status block without dropping the overview", () => {
    const body = [
      OVERVIEW_MARKER,
      "",
      REVIEW_STATUS_BLOCK_START,
      "",
      "### Sigilix Review Status",
      "",
      "**Phase:** Posted",
      "",
      "## Sigilix Overview",
      "",
      "### Summary",
      "",
      "Keep this summary.",
    ].join("\n")

    const updated = upsertReviewStatusBlock(body, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 8,
      final: { status: "posted", findingsCount: 6 },
    })

    expect(updated.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(updated).toContain("## Sigilix Overview")
    expect(updated).toContain("Keep this summary.")
    expect(updated).not.toContain("### Sigilix Review Status")
    expect(updated.indexOf("Keep this summary.")).toBeLessThan(updated.indexOf(REVIEW_STATUS_BLOCK_START))
  })

  it("preserves unknown content after a malformed status block without an overview heading", () => {
    const body = [
      OVERVIEW_MARKER,
      "",
      REVIEW_STATUS_BLOCK_START,
      "",
      "### Sigilix Review Status",
      "",
      "**Phase:** Posted",
      "",
      "Important review content here.",
      "More content without an overview heading.",
    ].join("\n")

    const updated = upsertReviewStatusBlock(body, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 8,
      final: { status: "posted", findingsCount: 6 },
    })

    expect(updated.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(updated).not.toContain("### Sigilix Review Status")
    expect(updated).toContain("Important review content here.")
    expect(updated).toContain("More content without an overview heading.")
  })

  it("falls back to prepending status when the body has no overview marker", () => {
    const updated = upsertReviewStatusBlock("plain comment", {
      phase: "retrieval",
      headSha: HEAD_SHA,
      sequence: 1,
    })

    expect(updated).toContain(REVIEW_STATUS_BLOCK_START)
    expect(updated).toContain("**Phase:** Retrieval")
    expect(updated).toContain("plain comment")
    expect(updated.indexOf(REVIEW_STATUS_BLOCK_START)).toBeLessThan(updated.indexOf("plain comment"))
  })
})

// ─── SIG-471 PR-3: the relocated Manage footer ────────────────────────

describe("formatManageLine (SIG-471 PR-3)", () => {
  it("builds the markdown-only Manage line with dismiss reasons, re-run, review#, and SHA", () => {
    const line = formatManageLine({ reviewNumber: 3, shortSha: "abcdef1" })
    expect(line).toBe(
      "**Manage:** Dismiss `@sigilix dismiss <reason>` in thread " +
        "(`not-a-bug` | `bad-anchor` | `already-covered` | `too-minor` | `wrong-context`) · " +
        "Re-run `/sigilix review` · Review #3 · `abcdef1`",
    )
    // PATCH-survivable: no <sub>/HTML chrome. (`<reason>` is literal text inside
    // backticks — GitHub renders it verbatim, not as a tag.)
    expect(line).not.toContain("<sub>")
    expect(line).toContain("`@sigilix dismiss <reason>`")
  })

  it("omits Review #N when the review number is absent or zero (APPROVE has no counter)", () => {
    expect(formatManageLine({ shortSha: "abcdef1" })).not.toContain("Review #")
    expect(formatManageLine({ reviewNumber: 0, shortSha: "abcdef1" })).not.toContain("Review #")
  })

  it("omits the SHA segment when no short SHA is supplied", () => {
    const line = formatManageLine({ reviewNumber: 2 })
    expect(line).toContain("Review #2")
    expect(line).not.toContain("`abcdef1`")
  })
})

describe("buildReviewStatusBlock Manage line (SIG-471 PR-3)", () => {
  it("renders the Manage line as the LAST content line, after Proof", () => {
    const manage = formatManageLine({ reviewNumber: 4, shortSha: "abcdef1" })
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 9,
      final: { status: "posted", findingsCount: 2 },
      proof: { verified: 0, grounded: 2, model: 0 },
      manage,
    })
    expect(block).toContain(manage)
    // Manage comes AFTER Proof.
    expect(block.indexOf("**Proof:**")).toBeLessThan(block.indexOf("**Manage:**"))
    // And it is the last content line before the END marker.
    const lines = block.split("\n").filter((l) => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe(REVIEW_STATUS_BLOCK_END)
    expect(lines[lines.length - 2]).toBe(manage)
  })

  it("omits the Manage line entirely when the snapshot carries none", () => {
    const block = buildReviewStatusBlock({
      phase: "synth",
      headSha: HEAD_SHA,
      sequence: 3,
    })
    expect(block).not.toContain("**Manage:**")
  })

  it("survives an upsert round-trip: the Manage line is recognized as status metadata, not stray content", () => {
    const manage = formatManageLine({ reviewNumber: 1, shortSha: "abcdef1" })
    const first = upsertReviewStatusBlock("plain comment", {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 1,
      final: { status: "posted", findingsCount: 1 },
      manage,
    })
    expect(first).toContain("**Manage:**")
    // A second upsert (a later phase with no Manage) must not duplicate or
    // strand the prior Manage line as orphaned body content.
    const second = upsertReviewStatusBlock(first, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 2,
      final: { status: "posted", findingsCount: 1 },
    })
    expect(second.match(/\*\*Manage:\*\*/g) ?? []).toHaveLength(0)
    expect(second).toContain("plain comment")
  })
})
