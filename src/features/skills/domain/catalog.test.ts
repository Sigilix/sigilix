import { describe, expect, it } from "vitest"
import { GOVERNED_SKILL_CATALOG } from "./catalog"

describe("governed skill catalog", () => {
  it("contains only pinned, permissively licensed, guidance-only sources", () => {
    expect(GOVERNED_SKILL_CATALOG).toHaveLength(5)
    expect(new Set(GOVERNED_SKILL_CATALOG.map((skill) => skill.id)).size).toBe(5)
    for (const skill of GOVERNED_SKILL_CATALOG) {
      expect(skill.schemaVersion).toBe(1)
      expect(skill.source.commit).toMatch(/^[a-f0-9]{40}$/)
      expect(skill.source.skillFileSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(["Apache-2.0", "MIT"]).toContain(skill.source.license)
      expect(skill.source.licenseUrl).toMatch(/^https:\/\/github\.com\//)
      expect(skill.review).toEqual({
        status: "approved-guidance-only",
        reviewedBy: "sigilix-engineering",
        reviewedAt: "2026-07-11",
      })
      expect(skill.requiredCapabilities).toEqual([])
      expect(skill.eligibleSurfaces).toEqual(["chat", "deep-research"])
      expect(skill.instructions).not.toMatch(/(?:^|\n)\s*(?:npm|npx|curl|git|mkdir|python|bash|sh)\s+/i)
    }
  })

  it("pins the exact reviewed instruction bytes with full SHA-256", async () => {
    for (const skill of GOVERNED_SKILL_CATALOG) {
      const bytes = new TextEncoder().encode(skill.instructions.normalize("NFC"))
      const digest = await crypto.subtle.digest("SHA-256", bytes)
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      expect(hex, skill.id).toBe(skill.instructionSha256)
    }
  })

  it("pins the audited upstream instruction-file hashes", () => {
    expect(Object.fromEntries(GOVERNED_SKILL_CATALOG.map((skill) => [skill.id, skill.source.skillFileSha256]))).toEqual(
      {
        "supabase-postgres-best-practices": "ccd6e4596bd51cf344fe76c464867c541ccc16b6d90ae7a9db449fb17588613b",
        "cloudflare-durable-objects": "cd6797cb18f3ae8f721dfd2e5cb27b73a0aa8636683f1a38163dab2fd51a8dfb",
        "cloudflare-workers-best-practices": "099432ff265ff6080327ef0b392c118b835d2a5bda98a7de07e1afd115ed6458",
        "openai-security-threat-model": "1283c0dd62a8104d9edda4583569b5d8510b4ddaa45120687c999250fd96bad2",
        "openai-security-best-practices": "7b3dae1ffc5434d890f3c65c8f552af52d0307fab3b35dec13013c9ca3844c4f",
      },
    )
  })
})
