import { describe, expect, it } from "vitest"
import { GOVERNED_SKILL_CATALOG } from "./catalog"

describe("governed skill catalog", () => {
  it("contains only pinned, permissively licensed, guidance-only sources", () => {
    expect(GOVERNED_SKILL_CATALOG).toHaveLength(20)
    expect(new Set(GOVERNED_SKILL_CATALOG.map((skill) => skill.id)).size).toBe(20)
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
      expect(skill.review.status).toBe("approved-guidance-only")
      expect(skill.review.reviewedBy).toBe("sigilix-engineering")
      expect(["2026-07-11", "2026-07-12"]).toContain(skill.review.reviewedAt)
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
        "slack-search-grounding": "d2ea69e3287cd8c060238ab8a45ede9ef0e7046de6e4ae452ef15bfd4e201ebc",
        "atlassian-jira-triage": "4ce1808138ea8871e5a113e4f7b7ae28dc8e78a36df4cb7c87f9666c20620e0c",
        "pagerduty-incident-investigation": "33ffab6beef0ffdfb9dfd5c67e98e3ee12d5437d2aa3825d1fc541187b4f8844",
        "asana-task-context": "6b3fddd179be3087cf8951ed1f27fe6bc3567ece6c6bc77303ece8a69c04c6fa",
        "openai-define-goal": "708df89ff19cbae82a762efae036735d1914b5c7e44df1832e0b723f6cd9ee30",
        "openai-ci-failure-diagnosis": "7b326b4a2f0f5f85122144628ec02077e48841e0e0e82efce88b3415bcfb7c26",
        "anthropic-activity-digest": "d711d49b898eb303b74488dce75308e8737786d87210f1dca13ec325bc7f5737",
        "anthropic-stakeholder-update": "bcdb8ee95dc34d025dcc3d98e7435c4dca45930581b3b7a8707f8770dd364e79",
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
      "slack-search-grounding": ["slack"],
      "atlassian-jira-triage": ["jira"],
      "pagerduty-incident-investigation": ["pagerduty"],
      "asana-task-context": ["asana"],
      "openai-define-goal": [],
      "openai-ci-failure-diagnosis": ["github"],
      "anthropic-activity-digest": [],
      "anthropic-stakeholder-update": [],
    })
  })
})
