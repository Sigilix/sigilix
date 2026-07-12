import { describe, expect, it } from "vitest"
import { GOVERNED_SKILL_CATALOG, type GovernedSkillManifest } from "./catalog"
import {
  applySkillGuidance,
  disabledSkillSurfaces,
  resolveGovernedSkill,
  validateRequestedSkillPolicy,
  type StoredSkillPolicy,
} from "./policy"

function policy(skillId: string, overrides: Partial<StoredSkillPolicy> = {}): StoredSkillPolicy {
  return {
    installationId: 42,
    skillId,
    version: 3,
    status: "installed",
    enabled: true,
    surfaces: { ...disabledSkillSurfaces(), chat: true, "deep-research": true },
    updatedBy: "user:1",
    installedAt: 10,
    updatedAt: 20,
    revokedAt: null,
    ...overrides,
  }
}

describe("resolveGovernedSkill", () => {
  it("selects one most-specific applicable enabled skill deterministically", () => {
    const result = resolveGovernedSkill({
      policies: [policy("cloudflare-workers-best-practices"), policy("cloudflare-durable-objects")],
      surface: "chat",
      task: "How should this Cloudflare Durable Object handle its alarm?",
    })
    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.context.provenance.id).toBe("cloudflare-durable-objects")
      expect(result.context.instructionBlock).toContain("Persist authoritative state")
      expect(new TextEncoder().encode(result.context.instructionBlock).byteLength).toBeLessThanOrEqual(8_192)
    }
  })

  it.each([
    ["supabase-platform-workflows", "Audit this Supabase Auth session flow"],
    ["cloudflare-wrangler", "Check this wrangler jsonc configuration"],
    ["cloudflare-agents-sdk", "Design this Cloudflare Agents SDK state flow"],
    ["openai-sentry-investigation", "Investigate this Sentry error"],
    ["openai-notion-research", "Compare these Notion research pages"],
    ["openai-browser-qa", "Run browser QA on this responsive web flow"],
    ["openai-security-ownership-analysis", "Analyze the security ownership bus factor in this repository"],
  ] as const)("resolves the new %s guidance from a matching task", (skillId, task) => {
    const result = resolveGovernedSkill({
      policies: [policy(skillId)],
      surface: "chat",
      task,
    })
    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.context.provenance.id).toBe(skillId)
    }
  })

  it("prefers Wrangler guidance when generic Worker guidance is also installed", () => {
    const result = resolveGovernedSkill({
      policies: [policy("cloudflare-workers-best-practices"), policy("cloudflare-wrangler")],
      surface: "chat",
      task: "Review this wrangler configuration",
    })
    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.context.provenance.id).toBe("cloudflare-wrangler")
    }
  })

  it("prefers Agents SDK guidance when generic Worker guidance is also installed", () => {
    const result = resolveGovernedSkill({
      policies: [policy("cloudflare-workers-best-practices"), policy("cloudflare-agents-sdk")],
      surface: "chat",
      task: "Review this Cloudflare Worker useAgentChat state flow",
    })
    expect(result.status).toBe("resolved")
    if (result.status === "resolved") {
      expect(result.context.provenance.id).toBe("cloudflare-agents-sdk")
    }
  })

  it("does not inject Sentry guidance into a generic production-error task", () => {
    const result = resolveGovernedSkill({
      policies: [policy("openai-sentry-investigation")],
      surface: "chat",
      task: "Investigate this production error",
    })
    expect(result.status).toBe("empty")
    if (result.status === "empty") {
      expect(result.reasons.trigger_miss).toBe(1)
    }
  })

  it.each([
    ["disabled", policy("supabase-postgres-best-practices", { enabled: false })],
    ["revoked", policy("supabase-postgres-best-practices", { status: "revoked", revokedAt: 30 })],
    ["surface_disabled", policy("supabase-postgres-best-practices", { surfaces: disabledSkillSurfaces() })],
  ] as const)("fails closed when policy is %s", (reason, stored) => {
    const result = resolveGovernedSkill({ policies: [stored], surface: "chat", task: "Review this Postgres query" })
    expect(result).toEqual({ status: "empty", reasons: expect.objectContaining({ [reason]: 1 }) })
  })

  it("does not inject on a trigger miss or any PR-review surface", () => {
    expect(
      resolveGovernedSkill({
        policies: [policy("supabase-postgres-best-practices")],
        surface: "chat",
        task: "Write a marketing headline",
      }),
    ).toEqual({ status: "empty", reasons: expect.objectContaining({ trigger_miss: 1 }) })
    expect(
      resolveGovernedSkill({
        policies: [
          policy("supabase-postgres-best-practices", {
            surfaces: { ...disabledSkillSurfaces(), "pr-review": true },
          }),
        ],
        surface: "pr-review",
        task: "Review this Postgres query",
      }),
    ).toEqual({ status: "empty", reasons: expect.objectContaining({ surface_ineligible: 1 }) })
  })

  it("fails soft when a manifest requirement is unavailable without granting it", () => {
    const base = GOVERNED_SKILL_CATALOG.find((skill) => skill.id === "supabase-postgres-best-practices")!
    const capabilitySkill: GovernedSkillManifest = {
      ...base,
      id: "test-capability-skill",
      requiredCapabilities: [{ kind: "mcp-tool", vendor: "supabase", tool: "search_docs" }],
    }
    const result = resolveGovernedSkill({
      policies: [policy(capabilitySkill.id)],
      surface: "chat",
      task: "Review this Postgres query",
      catalog: [capabilitySkill],
      availableCapabilities: new Set(),
    })
    expect(result).toEqual({ status: "empty", reasons: { missing_capability: 1 } })
  })

  it("adds reviewed text only to the system message and exposes no tool field", () => {
    const resolved = resolveGovernedSkill({
      policies: [policy("openai-security-threat-model")],
      surface: "deep-research",
      task: "Threat model this service",
    })
    expect(resolved.status).toBe("resolved")
    if (resolved.status !== "resolved") return
    const input = { system: "base system", user: "user task" }
    const output = applySkillGuidance(input, resolved.context)
    expect(output.user).toBe("user task")
    expect(output.system).toContain("base system")
    expect(output.system).toContain("<sigilix_organization_skill")
    expect(output).not.toHaveProperty("tools")
    expect(input).toEqual({ system: "base system", user: "user task" })
  })
})

describe("validateRequestedSkillPolicy", () => {
  it("requires an exact surface map and rejects ineligible surfaces", () => {
    expect(
      validateRequestedSkillPolicy("supabase-postgres-best-practices", {
        version: 0,
        enabled: true,
        surfaces: { ...disabledSkillSurfaces(), chat: true },
      }),
    ).toEqual({
      ok: true,
      expectedVersion: 0,
      enabled: true,
      surfaces: { ...disabledSkillSurfaces(), chat: true },
    })
    expect(
      validateRequestedSkillPolicy("supabase-postgres-best-practices", {
        version: 0,
        enabled: true,
        surfaces: { ...disabledSkillSurfaces(), cli: true },
      }),
    ).toEqual({ ok: false, error: "unsupported_surface" })
  })
})
