import { describe, expect, it } from "vitest"
import { STUB_V2_MARKER, buildPrOverviewStubBody } from "@/src/lib/pr-overview-stub"
import { REVIEW_STATUS_BLOCK_END, REVIEW_STATUS_BLOCK_START } from "@/src/lib/pr-review-status-render"
import { renderPrOverviewWaitingArt, selectPrOverviewWaitingArt } from "@/src/lib/pr-overview-waiting-art"

describe("PR overview waiting art integration", () => {
  it("carries the selected poem through the generated overview stub body", () => {
    const headSha = "b".repeat(40)
    const seed = `queued:17:${headSha}`
    const selected = selectPrOverviewWaitingArt(seed)
    const body = buildPrOverviewStubBody({ prNumber: 17, headSha })
    const artBlock = selected.lines.join("\n")
    const poemBlock = selected.poem.join("\n")
    const artIndex = body.indexOf(artBlock)
    const poemIndex = body.indexOf(poemBlock)
    const fenceIndex = body.indexOf("```text")
    const statusIndex = body.indexOf(REVIEW_STATUS_BLOCK_START)

    expect(body).toContain(STUB_V2_MARKER)
    expect(body).toContain(renderPrOverviewWaitingArt(seed))
    expect(body).toContain(poemBlock)
    expect(artIndex).toBeGreaterThan(-1)
    expect(poemIndex).toBeGreaterThan(-1)
    expect(fenceIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBeGreaterThan(-1)
    expect(artIndex + artBlock.length).toBeLessThan(poemIndex)
    expect(fenceIndex).toBeLessThan(statusIndex)
  })

  it("does not classify completed overview headings as legacy or current v2 stubs", async () => {
    const { isStubBody } = await import("@/src/lib/pr-overview-stub")
    const completedOldV2Shape = [
      "<!-- sigilix:pr-overview -->",
      "",
      STUB_V2_MARKER,
      "",
      "## Sigilix Overview",
      "",
      "```text",
      "completed content",
      "```",
    ].join("\n")
    const completedCurrentV2Shape = [
      "<!-- sigilix:pr-overview -->",
      "",
      STUB_V2_MARKER,
      "",
      "## Sigilix Overview",
      "",
      REVIEW_STATUS_BLOCK_START,
      "",
      REVIEW_STATUS_BLOCK_END,
    ].join("\n")

    expect(isStubBody(completedOldV2Shape)).toBe(false)
    expect(isStubBody(completedCurrentV2Shape)).toBe(false)
  })
})
