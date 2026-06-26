import { describe, expect, it } from "vitest"
import {
  REVIEW_STATUS_BLOCK_END,
  REVIEW_STATUS_BLOCK_START,
  buildReviewStatusBlock,
  upsertReviewStatusBlock,
  extractReviewStatusBlock,
  graftReviewStatusBlock,
  formatManageLine,
  formatProofLine,
  formatProofLegend,
  computeProofCounts,
  isReproducedTier,
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

  it("renders the compact terminal footer for a final review: headline + View-review link, dropping the in-progress detail", () => {
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

    // Terminal footer: a thin rule + one muted `> <sub>` headline carrying the
    // bold phase label, the short sha, and the finding count joined to the
    // View-review link by ` · `. No `**Phase:**`/`**Commit:**`/`**Result:**`
    // labels, no `surface:` text.
    expect(block).toContain("---")
    expect(block).toContain(
      "> <sub>**Degraded** · `abcdef1` · 2 findings — [View review](https://github.com/Sigilix/sigilix/pull/7#pullrequestreview-123)</sub>",
    )
    expect(block).not.toContain("**Phase:**")
    expect(block).not.toContain("**Commit:**")
    expect(block).not.toContain("**Result:**")
    expect(block).not.toContain("surface:")
    // The terminal footer drops the in-progress detail by design (specialists /
    // dropped files / graph coverage live only in the live status block).
    expect(block).not.toContain("dist/bundle.js")
    expect(block).not.toContain("pnpm-lock.yaml")
    expect(block).not.toContain("5/8 files")
    expect(block).not.toContain("19 nodes")
    expect(block).not.toContain("3/4")
    expect(block).not.toContain("```text")
  })

  it("renders specialists that were not needed (in-progress block, before the terminal footer compacts it away)", () => {
    // The "Not needed" list lives in the detailed IN-PROGRESS block; the
    // terminal footer (final set) intentionally drops it, so cover the listing
    // with a pre-terminal snapshot (no `final`).
    const block = buildReviewStatusBlock({
      phase: "specialists",
      headSha: HEAD_SHA,
      sequence: 4,
      specialists: {
        total: 0,
        completed: 0,
        notNeeded: ["logic", "security", "performance", "tests"],
      },
    })

    expect(block).toContain("**Phase:** Specialists")
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
    // The replacement renders the new compact terminal footer (no `**Phase:**`/
    // `**Result:**` labels) — phase + sha + finding count + View-review in the
    // muted `> <sub>` headline.
    expect(updated).not.toContain("**Phase:**")
    expect(updated).not.toContain("**Result:**")
    expect(updated).toContain(
      "> <sub>**Posted** · `abcdef1` · 6 findings — [View review](https://github.com/Sigilix/sigilix/pull/540)</sub>",
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
  it("builds the compact Manage affordance text with dismiss reasons, re-run, and review#", () => {
    const line = formatManageLine({ reviewNumber: 3, shortSha: "abcdef1" })
    // Compact de-emphasized affordance text: no bold `**Manage:**` prefix and no
    // trailing sha (the sha is shown once in the headline). `shortSha` is still
    // accepted for back-compat but is NOT rendered.
    expect(line).toBe(
      "Dismiss `@sigilix dismiss <reason>` " +
        "(`not-a-bug` | `bad-anchor` | `already-covered` | `too-minor` | `wrong-context`) · " +
        "Re-run `/sigilix review` · Review #3",
    )
    expect(line).not.toContain("**Manage:**")
    expect(line).not.toContain("`abcdef1`") // sha is NOT rendered here
    // formatManageLine's OWN output carries no `<sub>` chrome — the `<sub>`
    // wrapping happens in buildReviewStatusBlock, not here. (`<reason>` is literal
    // text inside backticks — GitHub renders it verbatim, not as a tag.)
    expect(line).not.toContain("<sub>")
    expect(line).toContain("`@sigilix dismiss <reason>`")
  })

  it("omits Review #N when the review number is absent or zero (APPROVE has no counter)", () => {
    expect(formatManageLine({ shortSha: "abcdef1" })).not.toContain("Review #")
    expect(formatManageLine({ reviewNumber: 0, shortSha: "abcdef1" })).not.toContain("Review #")
  })

  it("never renders the SHA segment (shortSha is accepted but unused)", () => {
    const line = formatManageLine({ reviewNumber: 2, shortSha: "abcdef1" })
    expect(line).toContain("Review #2")
    expect(line).not.toContain("`abcdef1`")
    // And without a shortSha at all it's identical (the arg is inert).
    expect(formatManageLine({ reviewNumber: 2 })).toBe(line)
  })
})

describe("buildReviewStatusBlock Manage line (SIG-471 PR-3)", () => {
  it("renders the Manage line as the LAST `<sub>` content line, after Proof", () => {
    const manage = formatManageLine({ reviewNumber: 4, shortSha: "abcdef1" })
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 9,
      final: { status: "posted", findingsCount: 2 },
      proof: { verified: 0, reproduced: 0, grounded: 2, model: 0 },
      manage,
    })
    // The block wraps the affordance text in a muted `> <sub>…</sub>` line — the
    // bare affordance text is still a substring, but there's no `**Manage:**`.
    expect(block).toContain(`> <sub>${manage}</sub>`)
    expect(block).toContain("Re-run `/sigilix review`")
    expect(block).not.toContain("**Manage:**")
    // Manage comes AFTER the Proof `<sub>` line.
    expect(block.indexOf("**Proof:**")).toBeLessThan(block.indexOf(manage))
    // And it is the last content line before the END marker.
    const lines = block.split("\n").filter((l) => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe(REVIEW_STATUS_BLOCK_END)
    expect(lines[lines.length - 2]).toBe(`> <sub>${manage}</sub>`)
  })

  it("omits the Manage line entirely when the snapshot carries none", () => {
    const block = buildReviewStatusBlock({
      phase: "synth",
      headSha: HEAD_SHA,
      sequence: 3,
    })
    expect(block).not.toContain("Re-run `/sigilix review`")
    expect(block).not.toContain("`@sigilix dismiss <reason>`")
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
    expect(first).toContain(`> <sub>${manage}</sub>`)
    // Exactly one manage line in the round-tripped body.
    expect(first.split("\n").filter((l) => l.includes("Re-run `/sigilix review`"))).toHaveLength(1)
    // A second upsert (a later phase with no Manage) must not duplicate or
    // strand the prior Manage line as orphaned body content.
    const second = upsertReviewStatusBlock(first, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 2,
      final: { status: "posted", findingsCount: 1 },
    })
    expect(second).not.toContain("Re-run `/sigilix review`")
    expect(second).toContain("plain comment")
  })
})

// ─── SIG-471: computeProofCounts (moved here from overview-proof-update) ───────

describe("computeProofCounts (SIG-471)", () => {
  const f = (key: string, trustTier?: string): { key: string; trustTier?: string } =>
    trustTier === undefined ? { key } : { key, trustTier }

  it("buckets grounded tiers as grounded and body-only/missing/unknown as model", () => {
    const findings = [
      f("a", "grounded-model"),
      f("b", "deterministic-grounded"),
      f("c", "worker-token-confirmed"),
      f("d", "runner-confirmed"),
      f("e", "body-only-ungrounded"),
      f("f"), // missing tier → model
      f("g", "totally-unknown"), // unknown → model
    ]
    expect(computeProofCounts(findings, new Set())).toEqual({ verified: 0, reproduced: 0, grounded: 4, model: 3 })
  })

  it("counts a confirmed finding ONLY as verified (never also grounded)", () => {
    const findings = [f("a", "grounded-model"), f("b", "deterministic-grounded"), f("c", "body-only-ungrounded")]
    // `a` and `b` are grounded tiers, but `a` is receipt-verified → verified only.
    expect(computeProofCounts(findings, new Set(["a"]))).toEqual({ verified: 1, reproduced: 0, grounded: 1, model: 1 })
  })

  it("the four buckets always sum to the finding count", () => {
    const findings = [f("a", "grounded-model"), f("b"), f("c", "runner-confirmed"), f("d", "body-only-ungrounded")]
    const proof = computeProofCounts(findings, new Set(["c"]))
    expect(proof.verified + proof.reproduced + proof.grounded + proof.model).toBe(findings.length)
  })

  it("SIG-482: buckets reproduced-by-execution as its OWN tier (not model-only)", () => {
    const findings = [
      f("a", "reproduced-by-execution"),
      f("b", "reproduced-by-execution"),
      f("c", "grounded-model"),
      f("d", "body-only-ungrounded"),
    ]
    expect(computeProofCounts(findings, new Set())).toEqual({ verified: 0, reproduced: 2, grounded: 1, model: 1 })
  })

  it("SIG-482: a receipt-verified reproduced finding counts ONLY as verified", () => {
    const findings = [f("a", "reproduced-by-execution"), f("b", "reproduced-by-execution")]
    // `a` got a runner receipt → verified; `b` stays reproduced.
    expect(computeProofCounts(findings, new Set(["a"]))).toEqual({ verified: 1, reproduced: 1, grounded: 0, model: 0 })
  })

  it("an all-model (no grounded) finding set renders only the model-only segment via formatProofLine", () => {
    const proof = computeProofCounts([f("a"), f("b", "body-only-ungrounded")], new Set())
    expect(proof).toEqual({ verified: 0, reproduced: 0, grounded: 0, model: 2 })
    expect(formatProofLine(proof)).toBe("> <sub>**Proof:** 2 model-only</sub>")
  })

  it("an empty finding set buckets to all-zero, and formatProofLine returns null (clean approve shows no Proof line)", () => {
    const proof = computeProofCounts([], new Set())
    expect(proof).toEqual({ verified: 0, reproduced: 0, grounded: 0, model: 0 })
    expect(formatProofLine(proof)).toBeNull()
  })

  it("SIG-482: formatProofLine renders tiers strongest→weakest incl. reproduced", () => {
    expect(formatProofLine({ verified: 2, reproduced: 1, grounded: 3, model: 1 })).toBe(
      "> <sub>**Proof:** 2 runner-verified · 1 reproduced · 3 grounded · 1 model-only</sub>",
    )
    // only non-zero tiers render
    expect(formatProofLine({ verified: 0, reproduced: 1, grounded: 0, model: 0 })).toBe(
      "> <sub>**Proof:** 1 reproduced</sub>",
    )
  })

  it("SIG-482: the trust-tier legend explains all four tiers (Kimi copy)", () => {
    expect(formatProofLegend()).toBe(
      "> <sub>`runner-verified` = CI receipt · `reproduced` = sandbox observed diff · " +
        "`grounded` = deterministic detector/worker-token · `model-only` = model judgment only</sub>",
    )
  })

  it("SIG-482: isReproducedTier matches only reproduced-by-execution", () => {
    expect(isReproducedTier("reproduced-by-execution")).toBe(true)
    expect(isReproducedTier("grounded-model")).toBe(false)
    expect(isReproducedTier("runner-confirmed")).toBe(false)
    expect(isReproducedTier(undefined)).toBe(false)
  })
})

describe("buildReviewStatusBlock Proof line (SIG-471)", () => {
  it("renders the **Proof:** line for a posted snapshot carrying proof", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 9,
      final: { status: "posted", findingsCount: 3 },
      proof: { verified: 0, reproduced: 0, grounded: 2, model: 1 },
    })
    expect(block).toContain("**Proof:** 2 grounded · 1 model-only")
  })

  it("omits the Proof line when the snapshot carries no proof (clean approve)", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 9,
      final: { status: "posted", findingsCount: 0 },
    })
    expect(block).not.toContain("**Proof:**")
  })

  it("omits the Proof line when all proof counts are zero", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 9,
      final: { status: "posted", findingsCount: 0 },
      proof: { verified: 0, reproduced: 0, grounded: 0, model: 0 },
    })
    expect(block).not.toContain("**Proof:**")
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
      proof: { verified: 0, reproduced: 0, grounded: 1, model: 0 },
      manage: manage(),
    })
    expect(withStatus).toContain("## Sigilix Overview")
    expect(withStatus).toContain(REVIEW_STATUS_BLOCK_START)
    expect(withStatus).toContain("**Proof:**")
    expect(withStatus).toContain("Re-run `/sigilix review`") // the Manage affordance

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
    expect(overview2).toContain("Re-run `/sigilix review`") // the Manage affordance
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

// ─── SIG-38 Task 7: per-developer usage footer in review status block ─────────

describe("buildReviewStatusBlock rateLimitFooter (SIG-38)", () => {
  const FOOTER = "_Sigilix · 2 of 3 reviews used in past 1h_"

  it("renders rateLimitFooter as a muted `> <sub>` line in the terminal footer", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 10,
      final: { status: "posted", findingsCount: 1, reviewUrl: "https://github.com/Sigilix/sigilix/pull/7" },
      rateLimitFooter: FOOTER,
    })
    expect(block).toContain(`> <sub>${FOOTER}</sub>`)
  })

  it("omits rateLimitFooter line when the field is absent", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 10,
      final: { status: "posted", findingsCount: 1 },
    })
    expect(block).not.toContain("reviews used in past 1h")
  })

  it("omits rateLimitFooter line when the field is an empty string", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 10,
      final: { status: "posted", findingsCount: 1 },
      rateLimitFooter: "",
    })
    expect(block).not.toContain("reviews used in past 1h")
  })

  it("produces exactly ONE status block even with rateLimitFooter set", () => {
    const block = buildReviewStatusBlock({
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 10,
      final: { status: "posted", findingsCount: 1 },
      rateLimitFooter: FOOTER,
    })
    expect(block.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
    expect(block.match(new RegExp(REVIEW_STATUS_BLOCK_END, "g"))).toHaveLength(1)
  })

  it("rateLimitFooter is stripped as status metadata on block replace (no stranded content)", () => {
    const first = upsertReviewStatusBlock("plain comment", {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 1,
      final: { status: "posted", findingsCount: 1 },
      rateLimitFooter: FOOTER,
    })
    expect(first).toContain(`> <sub>${FOOTER}</sub>`)
    // Replace with a snapshot that carries no footer — the line must vanish.
    const second = upsertReviewStatusBlock(first, {
      phase: "posted",
      headSha: HEAD_SHA,
      sequence: 2,
      final: { status: "posted", findingsCount: 1 },
    })
    expect(second).not.toContain("reviews used in past 1h")
    expect(second).toContain("plain comment")
    expect(second.match(new RegExp(REVIEW_STATUS_BLOCK_START, "g"))).toHaveLength(1)
  })
})
