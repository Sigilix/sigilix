// Unified instructive-learning capture — end-to-end over the REAL scope store
// (only the LLM extractor is mocked, mirroring github-mention-auto-learnings.test.ts).
// Proves: an instructive message → scope learning; the quality gate rejects a
// message the extractor declines; the mode/flag gates; dedupe; and a read-back
// proving another surface (the PR-review apply seam) sees the org learning.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Env } from "@/src/shared/types/env"

const { extractLearningMock } = vi.hoisted(() => ({
  extractLearningMock: vi.fn(),
}))
vi.mock("@/src/features/learnings/adapters/extractor-model", () => ({
  extractLearning: extractLearningMock,
}))

import { captureInstructiveLearning } from "@/src/features/learnings/adapters/instructive-capture"
import { loadEffectiveLearnings } from "@/src/features/learnings/adapters/org-apply"
import { learningsKey } from "@/src/features/learnings/domain/store-ops"

function makeKv(): { kv: Env["OPENCLAW_STATE"]; store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"], over: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_LEARNINGS_MODE: "on",
    OPENCLAW_ORG_MEMORY_CAPTURE: "on",
    ...over,
  } as unknown as Env
}

const INSTRUCTIVE = { rule: "always use named exports", polarity: "require" as const }

const baseArgs = (env: Env) =>
  ({
    env,
    scope: "org" as const,
    subjectId: "111",
    surface: "chat" as const,
    sourceKind: "chat" as const,
    message: "@sigilix from now on always use named exports",
    dedupeId: "slack:C1:T1:U1",
    actor: "slack:U1",
  }) satisfies Parameters<typeof captureInstructiveLearning>[0]

describe("captureInstructiveLearning", () => {
  beforeEach(() => {
    extractLearningMock.mockResolvedValue(INSTRUCTIVE)
  })
  afterEach(() => {
    extractLearningMock.mockReset()
  })

  it("writes an org-scope learning for an instructive message", async () => {
    const { kv, store } = makeKv()
    const res = await captureInstructiveLearning(baseArgs(makeEnv(kv)))

    expect(res.captured).toBe(true)
    const orgKey = learningsKey("org", "111")
    expect(store.has(orgKey)).toBe(true)
    const orgStore = JSON.parse(store.get(orgKey)!)
    expect(orgStore.scope).toBe("org")
    expect(orgStore.subjectId).toBe("111")
    expect(orgStore.entries).toHaveLength(1)
    expect(orgStore.entries[0].rule).toBe("always use named exports")
    expect(orgStore.entries[0].source.kind).toBe("chat")
    expect(orgStore.entries[0].scope).toBe("org")
    // SIG-600 PR2: a human teaching carries no runnable evidence → unverified.
    expect(orgStore.entries[0].verification).toEqual({ status: "unverified", evidence: ["none"] })
  })

  it("QUALITY GATE — ordinary chatter (extractor declines) writes nothing", async () => {
    extractLearningMock.mockResolvedValue(null)
    const { kv, store } = makeKv()
    const res = await captureInstructiveLearning({
      ...baseArgs(makeEnv(kv)),
      message: "@sigilix how does the auth flow work?",
    })

    expect(res.captured).toBe(false)
    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
  })

  it("mode off — inert, no extractor call, no write", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, { OPENCLAW_LEARNINGS_MODE: "off" })
    const res = await captureInstructiveLearning(baseArgs(env))

    expect(res.captured).toBe(false)
    expect(extractLearningMock).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  it("mode shadow — runs the gate but writes nothing", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, { OPENCLAW_LEARNINGS_MODE: "shadow" })
    const res = await captureInstructiveLearning(baseArgs(env))

    expect(res.captured).toBe(false)
    expect(extractLearningMock).toHaveBeenCalledOnce()
    expect(Array.from(store.keys()).filter((k) => k.startsWith("learnings:"))).toHaveLength(0)
  })

  it("org-scope requires OPENCLAW_ORG_MEMORY_CAPTURE=on", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, { OPENCLAW_ORG_MEMORY_CAPTURE: "off" })
    const res = await captureInstructiveLearning(baseArgs(env))

    expect(res.captured).toBe(false)
    expect(extractLearningMock).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  it("dedupes a redelivery by dedupeId (extractor runs once)", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv)
    const first = await captureInstructiveLearning(baseArgs(env))
    const second = await captureInstructiveLearning(baseArgs(env))

    expect(first.captured).toBe(true)
    expect(second.captured).toBe(false)
    expect(extractLearningMock).toHaveBeenCalledOnce()
    const orgStore = JSON.parse(store.get(learningsKey("org", "111"))!)
    expect(orgStore.entries).toHaveLength(1)
  })

  it("read-back — another surface (PR-review apply seam) sees the org learning", async () => {
    const { kv, store } = makeKv()
    const env = makeEnv(kv, {
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "octo/repo": 111 }),
      OPENCLAW_ORG_MEMORY_APPLY: "on",
    })
    await captureInstructiveLearning(baseArgs(env))

    // A PR review for a DIFFERENT repo under the same installation reads it back.
    const applied = await loadEffectiveLearnings({ env, owner: "octo", repo: "repo", repoId: 999 })
    expect(applied.map((e) => e.rule)).toContain("always use named exports")

    // Tenant isolation: an installation the learning was NOT written for sees nothing.
    const otherEnv = makeEnv(kv, {
      OPENCLAW_GITHUB_INSTALLATION_MAP: JSON.stringify({ "evil/repo": 222 }),
      OPENCLAW_ORG_MEMORY_APPLY: "on",
    })
    const otherApplied = await loadEffectiveLearnings({ env: otherEnv, owner: "evil", repo: "repo", repoId: 999 })
    expect(otherApplied).toHaveLength(0)
    expect(store.has(learningsKey("org", "222"))).toBe(false)
  })
})
