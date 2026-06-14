import { describe, expect, it } from "vitest"
import { buildPrOverviewStubBody } from "@/src/lib/pr-overview-stub"
import { REVIEW_STATUS_BLOCK_END, REVIEW_STATUS_BLOCK_START } from "@/src/lib/pr-review-status-render"
import { renderPrOverviewWaitingArt, selectPrOverviewWaitingArt } from "@/src/lib/pr-overview-waiting-art"

const STUB_V2_MARKER = "<!-- sigilix:pr-overview-stub:v2 -->"

describe("PR overview waiting art integration", () => {
  it("carries the selected poem through the generated overview stub body", () => {
    const headSha = "b".repeat(40)
    const seed = `queued:17:${headSha}`
    const selected = selectPrOverviewWaitingArt(seed)
    const body = buildPrOverviewStubBody({ prNumber: 17, headSha })

    expect(body).toContain(STUB_V2_MARKER)
    expect(body).toContain(renderPrOverviewWaitingArt(seed))
    expect(body).toContain(selected.poem.join("\n"))
    expect(body.indexOf(selected.lines.join("\n"))).toBeLessThan(body.indexOf(selected.poem[0]))
    expect(body.indexOf("```text")).toBeLessThan(body.indexOf(REVIEW_STATUS_BLOCK_START))
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
