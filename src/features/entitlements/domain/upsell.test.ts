// sig-free-tier-entitlements — upsell copy: one voice, cli_byok has a display line.
import { describe, expect, it } from "vitest"
import { upsellFor } from "@/src/features/entitlements/domain/upsell"

const UPGRADE_URL = "app.sigilix.ai"

describe("upsellFor — worker surfaces", () => {
  it("slack + linear return a one-sentence upsell pointing at the upgrade URL", () => {
    for (const feature of ["slack", "linear"] as const) {
      const copy = upsellFor(feature)
      expect(copy).not.toBeNull()
      expect(copy).toContain(UPGRADE_URL)
      expect(copy).toContain("Pro feature")
    }
  })

  it("ci_triage clean-skips with no copy (a failed-CI upsell comment would be spammy)", () => {
    expect(upsellFor("ci_triage")).toBeNull()
  })
})

describe("upsellFor — cli_byok display gate", () => {
  // cli_byok has no server touchpoint (the CLI talks to the user's own provider
  // directly), so its enforcement is the display/config gate in the CLI/portal +
  // the Terms. That gate needs copy — unlike ci_triage, cli_byok is NOT null.
  it("returns a BYOK-specific upsell for an un-entitled plan to show next to the disabled control", () => {
    const copy = upsellFor("cli_byok")
    expect(copy).not.toBeNull()
    expect(copy).toContain(UPGRADE_URL)
    expect(copy).toContain("Pro feature")
    expect(copy?.toLowerCase()).toContain("model key")
  })
})
