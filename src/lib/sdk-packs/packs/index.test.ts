// SIG-298 follow-on — SDK guidance pack registry shape validation. Every
// pack must be well-formed: unique ids across packs and within a pack's
// rules, at least one matcher signal, non-empty vendor/docsUrl, and every
// rule carrying review-actionable, review-length guidance text.

import { describe, expect, it } from "vitest"

import { SDK_PACKS } from "./index"
import type { SdkPack } from "@/src/lib/sdk-packs/types"

const VALID_SEVERITY_HINTS = new Set(["P1", "P2", "P3"])
const HTTPS_URL_RE = /^https:\/\//

describe("SDK_PACKS registry", () => {
  it("is non-empty", () => {
    expect(SDK_PACKS.length).toBeGreaterThan(0)
  })

  it("has unique pack ids", () => {
    const ids = SDK_PACKS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(SDK_PACKS.map((p) => [p.id, p] as const))("pack %s is well-formed", (_id, pack: SdkPack) => {
    expect(pack.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
    expect(pack.vendor.length).toBeGreaterThan(0)
    expect(pack.docsUrl).toMatch(HTTPS_URL_RE)

    // At least one real matcher signal — an unmatchable pack is dead weight.
    const hasPackages = pack.matchers.packages.length > 0
    const hasImportPatterns = pack.matchers.importPatterns.length > 0
    const hasPathGlobs = (pack.matchers.pathGlobs?.length ?? 0) > 0
    expect(hasPackages || hasImportPatterns || hasPathGlobs).toBe(true)
    for (const re of pack.matchers.importPatterns) {
      expect(re).toBeInstanceOf(RegExp)
    }

    // 6-10 rules per the launch spec.
    expect(pack.rules.length).toBeGreaterThanOrEqual(6)
    expect(pack.rules.length).toBeLessThanOrEqual(10)

    const ruleIds = pack.rules.map((r) => r.id)
    expect(new Set(ruleIds).size).toBe(ruleIds.length)

    for (const rule of pack.rules) {
      expect(rule.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(rule.title.length).toBeGreaterThan(0)
      expect(rule.title.length).toBeLessThan(120)
      // Review-actionable, 1-3 sentence guidance — long enough to be
      // specific, short enough to stay skimmable in a prompt section.
      expect(rule.guidance.length).toBeGreaterThan(40)
      expect(rule.guidance.length).toBeLessThan(600)
      expect(VALID_SEVERITY_HINTS.has(rule.severityHint)).toBe(true)
      if (rule.docsUrl !== undefined) expect(rule.docsUrl).toMatch(HTTPS_URL_RE)
    }
  })

  it("never claims a partner/endorsement relationship in any user-visible string", () => {
    // Product requirement: "SDK guidance", self-authored from public docs —
    // NOT a partner integration. No pack field may say "partner" or ship a
    // logo/asset reference.
    for (const pack of SDK_PACKS) {
      const haystack = JSON.stringify(pack).toLowerCase()
      expect(haystack).not.toMatch(/\bpartner/)
      expect(haystack).not.toMatch(/\blogo\b/)
      expect(haystack).not.toMatch(/\bendorse/)
    }
  })
})
