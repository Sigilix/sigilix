import { afterEach, describe, expect, it, vi } from "vitest"
import { renderSurfaceMemoryForPrompt } from "@/src/features/learnings/adapters/surface-apply"
import { appendLearning } from "@/src/features/learnings/adapters/store"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"
import type { LearningEntry } from "@/src/features/learnings/domain/types"
import type { Env } from "@/src/shared/types/env"

const REPO_ID = 555000
const INSTALL_ID = 42
const TS = Date.parse("2026-06-15T12:00:00.000Z")
const REPO_KEY = learningsKey("repo", String(REPO_ID))
const ORG_KEY = learningsKey("org", String(INSTALL_ID))

function makeEntry(id: string, over: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id,
    rule: `rule-${id}`,
    polarity: "context",
    category: "style",
    pathGlob: null,
    scope: "repo",
    subjectId: String(REPO_ID),
    source: { kind: "command", prNumber: 1, commentId: 1 },
    createdTs: new Date(TS).toISOString(),
    appliedCount: 0,
    ...over,
  }
}

// An ORG durable_preference guardrail (a team policy an admin taught) and a
// REPO architectural fact — the two scopes surface memory must union.
const ORG_POLICY = makeEntry("org111", {
  rule: "Always require a rollback plan in the PR description.",
  scope: "org",
  subjectId: String(INSTALL_ID),
  type: "durable_preference",
  polarity: "require",
})
const REPO_FACT = makeEntry("repo222", {
  rule: "Auth lives in src/auth/session.ts.",
  scope: "repo",
  subjectId: String(REPO_ID),
  type: "architectural_fact",
  polarity: "context",
})

function makeEnv(over: Partial<Env> = {}): { env: Env; getCalls: string[] } {
  const store = new Map<string, string>()
  const getCalls: string[] = []
  const kv = {
    async get(key: string): Promise<string | null> {
      getCalls.push(key)
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  }
  const env = { OPENCLAW_STATE: kv, ...over } as unknown as Env
  return { env, getCalls }
}

afterEach(() => vi.restoreAllMocks())

describe("renderSurfaceMemoryForPrompt (surface memory apply — Slack/Linear)", () => {
  it("flag OFF (default/unset) — returns '' and NEVER reads any learnings key", async () => {
    const { env, getCalls } = makeEnv()
    // Populate both stores so an off-mode leak would be observable.
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS)

    getCalls.length = 0
    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: REPO_ID })

    expect(out).toBe("")
    // No learnings read at all — a true no-op.
    expect(getCalls).not.toContain(ORG_KEY)
    expect(getCalls).not.toContain(REPO_KEY)
  })

  it("flag ON — an ORG guardrail and a REPO fact BOTH appear in the block", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS)

    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: REPO_ID })

    expect(out).toContain(ORG_POLICY.rule)
    expect(out).toContain(REPO_FACT.rule)
  })

  it("flag ON — the ORG guardrail is labeled and ordered ABOVE the repo fact", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    // Append the repo fact FIRST so ordering can only come from the renderer.
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS)
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)

    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: REPO_ID })

    // The org guardrail carries the must-follow precedence label.
    expect(out).toContain("[org policy — must follow]")
    // …and it is rendered before the repo fact.
    expect(out.indexOf(ORG_POLICY.rule)).toBeLessThan(out.indexOf(REPO_FACT.rule))
    // The repo fact keeps a non-org tag (not the org policy label).
    const repoLine = out.split("\n").find((l) => l.includes(REPO_FACT.rule)) ?? ""
    expect(repoLine).not.toContain("[org policy — must follow]")
  })

  it("flag ON — a learning mirrored repo→org (same id) applies exactly once (repo wins)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    const shared = makeEntry("shared999", { rule: "shared rule", scope: "repo", subjectId: String(REPO_ID) })
    const orgCopy = { ...shared, scope: "org" as const, subjectId: String(INSTALL_ID), rule: "ORG COPY TEXT" }
    await appendLearning(env, "repo", String(REPO_ID), shared, TS)
    await appendLearning(env, "org", String(INSTALL_ID), orgCopy, TS)

    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: REPO_ID })

    // The repo copy wins the id collision — its text appears, the org copy's does not.
    expect(out).toContain("shared rule")
    expect(out).not.toContain("ORG COPY TEXT")
    expect(out.match(/shared999|shared rule/g)?.length).toBe(1)
  })

  it("flag ON with repoId null — returns the org-scope block alone (no repo read)", async () => {
    const { env, getCalls } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)

    getCalls.length = 0
    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: null })

    expect(out).toContain(ORG_POLICY.rule)
    expect(getCalls).toContain(ORG_KEY)
    expect(getCalls).not.toContain(REPO_KEY)
  })

  it("fail-soft — a KV read fault degrades to '' and never throws", async () => {
    const env = {
      OPENCLAW_SURFACE_MEMORY_APPLY: "on",
      OPENCLAW_STATE: {
        get: vi.fn(async () => {
          throw new Error("kv exploded")
        }),
        put: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      },
    } as unknown as Env
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const out = await renderSurfaceMemoryForPrompt({ env, installationId: INSTALL_ID, repoId: REPO_ID })
    expect(out).toBe("")
  })
})
