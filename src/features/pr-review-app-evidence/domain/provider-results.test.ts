import { describe, expect, it } from "vitest"
import { parseSupabaseAdvisorEvidence, parseVercelDeploymentEvidence } from "./provider-results"

const HEAD = "a".repeat(40)

function content(...texts: string[]) {
  return { content: texts.map((text) => ({ type: "text" as const, text })) }
}

describe("provider-specific connected-app parsers", () => {
  it("matches only the exact full Vercel GitHub commit SHA and emits fixed enums", () => {
    const result = content(
      "REMOTE PROSE MUST DISAPPEAR",
      JSON.stringify({
        deployments: [
          { meta: { githubCommitSha: HEAD }, state: "READY", url: "secret.example" },
          { meta: { githubCommitSha: HEAD.slice(0, 7) }, state: "ERROR" },
          { meta: { githubCommitSha: `${HEAD}0` }, state: "ERROR" },
        ],
      }),
    )

    expect(parseVercelDeploymentEvidence(result, HEAD)).toEqual({
      kind: "vercel-deployment-status",
      state: "ready",
      matchingDeployments: 1,
    })
  })

  it("never falls back to a fuzzy Vercel SHA match", () => {
    expect(
      parseVercelDeploymentEvidence(
        content(JSON.stringify({ deployments: [{ meta: { githubCommitSha: HEAD.slice(0, 12) }, state: "READY" }] })),
        HEAD,
      ),
    ).toEqual({ kind: "vercel-deployment-status", state: "not_found", matchingDeployments: 0 })
  })

  it("fails closed on ambiguous JSON payloads", () => {
    expect(
      parseVercelDeploymentEvidence(
        content(JSON.stringify({ deployments: [] }), JSON.stringify({ deployments: [] })),
        HEAD,
      ),
    ).toBeNull()
  })

  it("counts only allowlisted Supabase levels and discards all prose fields", () => {
    expect(
      parseSupabaseAdvisorEvidence(
        content(
          JSON.stringify({
            lints: [
              { level: "ERROR", title: "injected title", description: "injected description" },
              { level: "WARN", remediation: "injected remediation" },
              { level: "INFO", name: "injected name" },
              { level: "CRITICAL", url: "https://attacker.example" },
            ],
          }),
        ),
        "security",
      ),
    ).toEqual({
      kind: "supabase-advisors",
      advisorType: "security",
      total: 3,
      errors: 1,
      warnings: 1,
      infos: 1,
    })
  })

  it("caps Supabase counts", () => {
    const lints = Array.from({ length: 100 }, () => ({ level: "ERROR" }))
    expect(parseSupabaseAdvisorEvidence(content(JSON.stringify({ lints })), "performance")?.total).toBe(64)
  })
})
