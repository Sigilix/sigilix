import { describe, expect, it } from "vitest"
import { GOVERNED_SKILL_CATALOG } from "./catalog"

describe("governed skill catalog", () => {
  it("contains only pinned, permissively licensed, guidance-only sources", () => {
    expect(GOVERNED_SKILL_CATALOG).toHaveLength(12)
    expect(new Set(GOVERNED_SKILL_CATALOG.map((skill) => skill.id)).size).toBe(12)
    for (const skill of GOVERNED_SKILL_CATALOG) {
      expect(skill.schemaVersion).toBe(1)
      expect(["engineering", "security", "data", "operations", "knowledge"]).toContain(skill.category)
      expect(skill.explanation.purpose.trim().length).toBeGreaterThan(40)
      expect(skill.explanation.useCases.length).toBeGreaterThan(0)
      expect(skill.explanation.useCases.every((useCase) => useCase.trim().length > 10)).toBe(true)
      expect(skill.explanation.guardrails.trim().length).toBeGreaterThan(30)
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
        "supabase-platform-workflows": "4aa35891985d59880b241d3bc500124a0b533e088814ce7eb722839e9a6b3d81",
        "cloudflare-durable-objects": "cd6797cb18f3ae8f721dfd2e5cb27b73a0aa8636683f1a38163dab2fd51a8dfb",
        "cloudflare-workers-best-practices": "099432ff265ff6080327ef0b392c118b835d2a5bda98a7de07e1afd115ed6458",
        "cloudflare-wrangler": "42abe11ba6c0cb0c135deed1d591d844838fe0b61fc8c6d675a832435508a61b",
        "cloudflare-agents-sdk": "a05244d3cfb23330daff956ec28a990241f5dbbe489cd7fd6489c8f76bb60877",
        "openai-sentry-investigation": "508c6f5c100586c81a34397d30f00f4b8771b66d698a7ac1836998df925dd007",
        "openai-notion-research": "e88a46da978cf6f088a788fa92ee736df699a355a72f41f14bdc258bf3ef57e7",
        "openai-security-threat-model": "1283c0dd62a8104d9edda4583569b5d8510b4ddaa45120687c999250fd96bad2",
        "openai-security-best-practices": "7b3dae1ffc5434d890f3c65c8f552af52d0307fab3b35dec13013c9ca3844c4f",
        "openai-browser-qa": "0ffaabcc8e0990627c4725f18bf1c7955534a796c1c199e872909de2013ce6a8",
        "openai-security-ownership-analysis": "f06c1a59247569326702c945f397af163ea96cf2ecfdf2dde280605bf89a3ec8",
      },
    )
  })

  it("associates app skills only through explicit manifest ids", () => {
    expect(Object.fromEntries(GOVERNED_SKILL_CATALOG.map((skill) => [skill.id, [...skill.appIds]]))).toMatchObject({
      "supabase-platform-workflows": ["supabase"],
      "cloudflare-wrangler": ["cloudflare"],
      "cloudflare-agents-sdk": ["cloudflare"],
      "openai-sentry-investigation": ["sentry"],
      "openai-notion-research": ["notion"],
      "openai-browser-qa": [],
      "openai-security-ownership-analysis": [],
    })
  })
})
