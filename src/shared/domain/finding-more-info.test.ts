import { describe, expect, it } from "vitest"
import {
  FINDING_MORE_INFO_DETAIL_LIMIT,
  normalizeFindingMoreInfo,
  normalizeMoreInfoSection,
} from "@/src/shared/domain/finding-more-info"

describe("finding moreInfo normalization", () => {
  it("normalizes known sections and ignores unknown fields", () => {
    const out = normalizeFindingMoreInfo({
      threatModel: "  customer data can leak  ",
      codeCitations: "```text\nsrc/auth.ts:42 calls authorize(user)\n```",
      existingProtections: "",
      mitigation: "Require the tenant check before returning.",
      extra: "ignored",
    })

    expect(out).toEqual({
      threatModel: "customer data can leak",
      codeCitations: "src/auth.ts:42 calls authorize(user)",
      mitigation: "Require the tenant check before returning.",
    })
  })

  it("returns undefined when no substantive section exists", () => {
    expect(normalizeFindingMoreInfo({ threatModel: "   ", codeCitations: 42 })).toBeUndefined()
    expect(normalizeFindingMoreInfo(null)).toBeUndefined()
    expect(normalizeFindingMoreInfo([])).toBeUndefined()
  })

  it("caps long section text without leaving a partial fence wrapper", () => {
    const out = normalizeMoreInfoSection("```md\n" + "x".repeat(FINDING_MORE_INFO_DETAIL_LIMIT + 200) + "\n```")

    expect(out).toHaveLength(FINDING_MORE_INFO_DETAIL_LIMIT)
    expect(out).not.toContain("```")
  })

  it("strips a leading fence while preserving trailing prose", () => {
    const out = normalizeMoreInfoSection("```text\nsrc/auth.ts:42 checks only login\n```\nThe tenant guard is absent.")

    expect(out).toBe("src/auth.ts:42 checks only login\nThe tenant guard is absent.")
    expect(out).not.toContain("```")
  })
})
