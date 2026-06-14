import { describe, expect, it } from "vitest"
import {
  MAX_OVERVIEW_WAITING_ART_HEIGHT,
  MAX_OVERVIEW_WAITING_ART_WIDTH,
  PR_OVERVIEW_WAITING_ARTS,
  renderPrOverviewWaitingArt,
  selectPrOverviewWaitingArt,
} from "@/src/lib/pr-overview-waiting-art"

describe("PR overview waiting art", () => {
  it("ships a broad catalog of detailed original ASCII compositions", () => {
    expect(PR_OVERVIEW_WAITING_ARTS.length).toBeGreaterThanOrEqual(12)
    expect(new Set(PR_OVERVIEW_WAITING_ARTS.map((art) => art.id)).size).toBe(PR_OVERVIEW_WAITING_ARTS.length)

    for (const art of PR_OVERVIEW_WAITING_ARTS) {
      expect(art.lines.length).toBeGreaterThanOrEqual(14)
      expect(art.lines.length).toBeLessThanOrEqual(MAX_OVERVIEW_WAITING_ART_HEIGHT)
      expect(art.title.length).toBeGreaterThan(0)
      expect(/^[\x20-\x7E]+$/.test(art.title)).toBe(true)
      expect(art.poem.length).toBe(2)

      const usedChars = new Set<string>()
      for (const line of art.lines) {
        expect(line.length).toBeLessThanOrEqual(MAX_OVERVIEW_WAITING_ART_WIDTH)
        expect(/^[\x20-\x7E]*$/.test(line)).toBe(true)
        for (const ch of line) if (ch !== " ") usedChars.add(ch)
      }
      for (const line of art.poem) {
        expect(line.length).toBeLessThanOrEqual(MAX_OVERVIEW_WAITING_ART_WIDTH)
        expect(/^[\x20-\x7E]*$/.test(line)).toBe(true)
      }
      expect(usedChars.size).toBeGreaterThanOrEqual(10)
    }
  })

  it("pairs each artwork with its own unique two-line poem", () => {
    const poemSignatures = new Set(PR_OVERVIEW_WAITING_ARTS.map((art) => art.poem.join("\n")))

    expect(poemSignatures.size).toBe(PR_OVERVIEW_WAITING_ARTS.length)
  })

  it("renders exactly one bounded text fence for GitHub markdown", () => {
    const seed = "Sigilix/sigilix#540@abcdef1"
    const selected = selectPrOverviewWaitingArt(seed)
    const rendered = renderPrOverviewWaitingArt(seed)
    const lines = rendered.split("\n")

    expect(lines[0]).toBe("```text")
    expect(lines.at(-1)).toBe("```")
    expect(rendered.match(/```/g)).toHaveLength(2)
    expect(rendered).toContain(selected.title)
    expect(rendered).toContain(selected.poem.join("\n"))
  })

  it("keeps the Aristotle-inspired compositions grounded in garden imagery", () => {
    const catalog = new Map(PR_OVERVIEW_WAITING_ARTS.map((art) => [art.id, art.lines.join("\n").toLowerCase()]))

    expect(catalog.get("peripatetic-garden")).toContain("walk the mean")
    expect(catalog.get("four-causes-garden")).toContain("cause becomes crop")
    expect(catalog.get("mean-arbor")).toContain("virtue grows by tending")
  })

  it("selects art deterministically while varying across seeds", () => {
    expect(selectPrOverviewWaitingArt("same-seed")).toBe(selectPrOverviewWaitingArt("same-seed"))

    const selected = new Set<string>()
    for (let i = 0; i < PR_OVERVIEW_WAITING_ARTS.length * 3; i++) {
      selected.add(selectPrOverviewWaitingArt(`seed-${i}`).id)
    }
    expect(selected.size).toBeGreaterThan(4)
  })
})
