import { describe, expect, it } from "vitest"
import {
  REVIEW_STATUS_BLOCK_END,
  REVIEW_STATUS_BLOCK_START,
  buildReviewStatusBlock,
  upsertReviewStatusBlock,
  extractReviewStatusBlock,
  graftReviewStatusBlock,
  formatManageLine,
} from "@/src/lib/pr-review-status-render"
import { formatOverviewComment } from "@/src/lib/triage-pr-overview-format"
import type { PrOverviewVerdict } from "@/src/lib/triage-pr-overview"
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

// ─── SIG-472: the overview-write clobber regression ───────────────────
//
// The two writers to the SAME overview comment are asymmetric: the status
// writer (`upsertReviewStatusBlock`) preserves the surrounding overview, but the
// overview writer builds its body from scratch (`formatOverviewComment`) and used
// to DROP any existing status block. A re-run / latest-push overview write then
// clobbered the status block — leaving the comment overview-only (and, in the
// reverse interleaving, status-only). The fix makes the writers symmetric via
// `graftReviewStatusBlock`.

describe("SIG-472 overview-write status-block preservation", () => {
  const VERDICT: PrOverviewVerdict = {
    summary: "Refactors the payments refund path.",
    files: [{ path: "src/payments.ts", score: 3, overview: "Refund handler", nextStep: "Add a test" }],
    confidence: 4,
    confidenceReason: "Diff is small and well-scoped.",
    bullets: [],
    reviewEffort: 3,
  }

  function manage(): string {
    return formatManageLine({ reviewNumber: 2, shortSha: "abcdef1" })
  }

  it("overview-then-status-then-overview keeps BOTH the overview and the status block (clobber repro)", () => {
    // (a) first overview write
    const overview1 = formatOverviewComment({ verdict: VERDICT, isFirstRun: true })

    // (b) a status write upserts the terminal block — overview + status survive
    const withStatus = upsertReviewStatusBlock(overview1, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 5,
      final: { status: "posted", findingsCount: 1, reviewUrl: "https://github.com/Sigilix/sigilix/pull/7" },
      proof: { verified: 0, grounded: 1, model: 0 },
      manage: manage(),
    })
    expect(withStatus).toContain("## Sigilix Overview")
    expect(withStatus).toContain(REVIEW_STATUS_BLOCK_START)
    expect(withStatus).toContain("**Proof:**")
    expect(withStatus).toContain("**Manage:**")

    // (c) a SECOND overview write (re-run / latest push). The raw
    // formatOverviewComment output carries NO status block — this is the
    // clobber. The fix grafts the existing block back on.
    const overview2Raw = formatOverviewComment({ verdict: VERDICT, isFirstRun: false })
    expect(overview2Raw).not.toContain(REVIEW_STATUS_BLOCK_START) // proves the clobber source

    const overview2 = graftReviewStatusBlock(overview2Raw, withStatus)

    // Both the rich overview AND the status block (+ Proof/Manage) coexist.
    expect(overview2).toContain("## Sigilix Overview")
    expect(overview2).toContain(REVIEW_STATUS_BLOCK_START)
    expect(overview2).toContain(REVIEW_STATUS_BLOCK_END)
    expect(overview2).toContain("**Proof:** 1 grounded")
    expect(overview2).toContain("**Manage:**")
    // Exactly one status block (no duplication).
    expect(overview2.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    // Overview content stays ABOVE the status block.
    expect(overview2.indexOf("## Sigilix Overview")).toBeLessThan(overview2.indexOf(REVIEW_STATUS_BLOCK_START))
  })

  it("status-first-then-overview (reverse interleaving) also keeps both", () => {
    // (a) status write before any overview content (e.g. queued phase on a
    // stub-less comment) produces a status-only-ish body
    const statusOnly = upsertReviewStatusBlock("", {
      phase: "specialists",
      headSha: HEAD_SHA,
      sequence: 2,
    })
    expect(statusOnly).toContain(REVIEW_STATUS_BLOCK_START)

    // (b) the overview write grafts that block onto the fresh overview
    const overviewRaw = formatOverviewComment({ verdict: VERDICT, isFirstRun: true })
    const grafted = graftReviewStatusBlock(overviewRaw, statusOnly)

    expect(grafted).toContain("## Sigilix Overview")
    expect(grafted).toContain(REVIEW_STATUS_BLOCK_START)
    expect(grafted.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
  })

  it("graft is a no-op when the source body has no status block", () => {
    const overviewRaw = formatOverviewComment({ verdict: VERDICT, isFirstRun: true })
    expect(graftReviewStatusBlock(overviewRaw, overviewRaw)).toBe(overviewRaw)
    expect(graftReviewStatusBlock(overviewRaw, "")).toBe(overviewRaw)
  })

  it("collapses MULTIPLE pre-existing status blocks in the target to exactly one (SIG-472 P3)", () => {
    const blockA = buildReviewStatusBlock({ phase: "queued", headSha: HEAD_SHA, sequence: 1 })
    const blockB = buildReviewStatusBlock({ phase: "posted", headSha: HEAD_SHA, sequence: 2 })
    // A malformed target carrying two blocks (defends the exported helper's
    // "exactly one block" contract even though formatOverviewComment emits none).
    const doubled = `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\n${blockA}\n\n${blockB}`
    const source = buildReviewStatusBlock({ phase: "posted", headSha: HEAD_SHA, sequence: 3 })
    const grafted = graftReviewStatusBlock(doubled, source)
    expect(grafted.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(grafted).toContain("## Sigilix Overview")
  })

  it("extractReviewStatusBlock returns the full block, or null when absent/malformed", () => {
    const block = buildReviewStatusBlock({ phase: "posted", headSha: HEAD_SHA, sequence: 1 })
    const body = `${OVERVIEW_MARKER}\n\n## Sigilix Overview\n\n${block}`
    const extracted = extractReviewStatusBlock(body)
    expect(extracted).not.toBeNull()
    expect(extracted!.startsWith(REVIEW_STATUS_BLOCK_START)).toBe(true)
    expect(extracted!.endsWith(REVIEW_STATUS_BLOCK_END)).toBe(true)
    expect(extractReviewStatusBlock("no block here")).toBeNull()
    // malformed: START present, END missing → null (not a partial graft)
    expect(extractReviewStatusBlock(`x\n${REVIEW_STATUS_BLOCK_START}\nhalf`)).toBeNull()
  })
})
