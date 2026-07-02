// #155 onboarding-backend slice 3 FOUNDER ADDENDUM — captureOnboardingMemory
// tests. Repo-scope + org-scope writes go through the EXISTING learnings
// store (KV); the security-critical scoping check reads the platform D1's
// `repo` + `account_tenant` tables (migrations 0001 + 0003).

import { beforeEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { makeD1 } from "@/src/test-shims/d1-sqlite-shim"
import { captureOnboardingMemory } from "@/src/lib/onboarding-memory-capture"
import { linkAccountTenant } from "@/src/lib/api-key-store"
import { upsertTenantAndRepo } from "@/src/features/tenancy"
import { loadLearnings } from "@/src/features/learnings"
import type { Env } from "@/src/shared/types/env"
import type { OnboardingPayload } from "@/src/lib/onboarding-submit-route"

const MIGRATION_0001 = readFileSync(
  new URL("../../migrations/0001_create_tenant_repo_usage.sql", import.meta.url),
  "utf8",
)
const MIGRATION_0003 = readFileSync(
  new URL("../../migrations/0003_create_account_tenant_and_api_key.sql", import.meta.url),
  "utf8",
)

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: async (key: string, type?: "json") => {
      const raw = store.get(key)
      if (raw === undefined) return null
      return type === "json" ? JSON.parse(raw) : raw
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
  } as unknown as KVNamespace
}

describe("captureOnboardingMemory", () => {
  let db: D1Database
  let kv: KVNamespace
  let env: Env
  const GITHUB_USER_ID = 111
  const INSTALLATION_ID = 42

  beforeEach(async () => {
    db = makeD1()
    await db.exec(MIGRATION_0001)
    await db.exec(MIGRATION_0003)
    kv = makeKV()
    env = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: db } as unknown as Env

    // The repo is registered (PR webhook already upserted it) and the
    // caller's session is linked to its installation via /setup.
    await upsertTenantAndRepo(env, {
      installationId: INSTALLATION_ID,
      repoId: 900,
      fullName: "acme/api",
      nowIso: "2026-01-01T00:00:00Z",
    })
    await linkAccountTenant(db, {
      githubUserId: String(GITHUB_USER_ID),
      installationId: INSTALLATION_ID,
      role: "owner",
      nowIso: "2026-01-01T00:00:00Z",
    })
  })

  it("writes a REPO-scope learning for a non-empty repoDescriptions entry", async () => {
    const payload: OnboardingPayload = { repoDescriptions: { "acme/api": "The main REST API service." } }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)

    const store = await loadLearnings(env, "repo", "900")
    expect(store?.entries).toHaveLength(1)
    expect(store!.entries[0]!.rule).toBe("Repo context (from onboarding): The main REST API service.")
    expect(store!.entries[0]!.scope).toBe("repo")
    expect(store!.entries[0]!.subjectId).toBe("900")
  })

  it("writes ORG-scope learnings for links[] and conventions", async () => {
    const payload: OnboardingPayload = {
      repoDescriptions: { "acme/api": "The API." },
      links: [{ from: "acme/api", label: "calls", to: "acme/worker" }],
      conventions: "We use conventional commits.",
    }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)

    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(org?.entries).toHaveLength(2)
    const rules = org!.entries.map((e) => e.rule).sort()
    expect(rules).toEqual(
      [
        "Cross-repo: acme/api calls acme/worker (from onboarding)",
        "Team conventions (from onboarding): We use conventional commits.",
      ].sort(),
    )
    expect(org!.entries.every((e) => e.scope === "org")).toBe(true)
  })

  it("does NOT write org-scope memory when no repoDescriptions resolved an authorized installation", async () => {
    const payload: OnboardingPayload = {
      links: [{ from: "acme/api", label: "calls", to: "acme/worker" }],
      conventions: "Some conventions.",
    }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(org).toBeNull()
  })

  it("never writes marketing-only fields (fullName/challenges/companySize/hearAbout/model) to memory", async () => {
    const payload: OnboardingPayload = {
      fullName: "Ada Lovelace",
      challenges: ["scale"],
      companySize: "11-50",
      hearAbout: "twitter",
      model: "boreas",
    }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)

    const repo = await loadLearnings(env, "repo", "900")
    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(repo).toBeNull()
    expect(org).toBeNull()
  })

  it("IDEMPOTENT: re-submitting identical answers upserts by content id instead of duplicating", async () => {
    const payload: OnboardingPayload = { repoDescriptions: { "acme/api": "The main REST API service." } }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)

    const store = await loadLearnings(env, "repo", "900")
    expect(store?.entries).toHaveLength(1)
    expect(store!.entries[0]!.appliedCount).toBe(2) // 1 create + 2 upserts = appliedCount incremented twice
  })

  it("SECURITY: skips a repo the caller's session is NOT linked to (never writes cross-tenant)", async () => {
    // Register a second installation's repo the caller has no account_tenant link to.
    await upsertTenantAndRepo(env, {
      installationId: 999,
      repoId: 901,
      fullName: "victim-org/secret-repo",
      nowIso: "2026-01-01T00:00:00Z",
    })
    const payload: OnboardingPayload = {
      repoDescriptions: { "victim-org/secret-repo": "Attacker-supplied description." },
    }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)

    const repo = await loadLearnings(env, "repo", "901")
    const org = await loadLearnings(env, "org", "999")
    expect(repo).toBeNull()
    expect(org).toBeNull()
  })

  it("SECURITY: skips a repo with no registered `repo` row (not yet indexed — benign race)", async () => {
    const payload: OnboardingPayload = { repoDescriptions: { "acme/brand-new-repo": "Fresh install, no PR yet." } }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    // Nothing to assert an id against (no repoId was ever resolved) — the
    // meaningful assertion is that this never throws and no org-scope
    // write happens either (no installation was resolved).
    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(org).toBeNull()
  })

  it("BEST-EFFORT: a D1 failure is swallowed — never throws, never blocks the caller", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("simulated D1 error")
      },
    } as unknown as D1Database
    const brokenEnv = { OPENCLAW_STATE: kv, SIGILIX_PLATFORM_DB: brokenDb } as unknown as Env
    await expect(
      captureOnboardingMemory(brokenEnv, GITHUB_USER_ID, { repoDescriptions: { "acme/api": "desc" } }),
    ).resolves.toBeUndefined()
  })

  it("BEST-EFFORT: SIGILIX_PLATFORM_DB unset is a total no-op, never throws", async () => {
    const noDbEnv = { OPENCLAW_STATE: kv } as unknown as Env
    await expect(
      captureOnboardingMemory(noDbEnv, GITHUB_USER_ID, { repoDescriptions: { "acme/api": "desc" } }),
    ).resolves.toBeUndefined()
  })

  it("ignores a whitespace-only repoDescription entry (no repo-scope write, no installation resolved)", async () => {
    const payload: OnboardingPayload = { repoDescriptions: { "acme/api": "   " } }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    const repo = await loadLearnings(env, "repo", "900")
    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(repo).toBeNull()
    expect(org).toBeNull()
  })

  it("an authorized installation with an empty links[] and blank conventions writes ONLY the repo-scope entry", async () => {
    const payload: OnboardingPayload = {
      repoDescriptions: { "acme/api": "The API." },
      links: [],
      conventions: "   ",
    }
    await captureOnboardingMemory(env, GITHUB_USER_ID, payload)
    const repo = await loadLearnings(env, "repo", "900")
    const org = await loadLearnings(env, "org", String(INSTALLATION_ID))
    expect(repo?.entries).toHaveLength(1)
    expect(org).toBeNull()
  })
})
