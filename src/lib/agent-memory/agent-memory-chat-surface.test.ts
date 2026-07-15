// Surface memory apply — portal-CHAT read side (org∪repo∪own-seat).
//
// The one surface that ALSO applies seat memory (the portal chat is a single
// signed-in user, unlike shared Slack/Linear). These tests pin the load-bearing
// contract: flag off is a true no-op (no KV read); flag on unions org guardrails
// (highest) + repo facts + the caller's OWN seat preferences (lowest) with the
// precedence carried by BOTH order and labels; a conflicting seat pref never
// outranks an org guardrail; ANOTHER user's seat is never read (seat isolation);
// and every leg fails soft to "" (never blocks a chat answer).

import { afterEach, describe, expect, it, vi } from "vitest"
import { appendLearning, learningsKey, type LearningEntry } from "@/src/features/learnings"
import type { AuthedSession } from "@/src/lib/auth-middleware"
import type { Env } from "@/src/shared/types/env"
import { renderChatSurfaceMemoryForPrompt, renderSeatMemoryForPrompt } from "./agent-memory-chat-surface"
import { personalMemoryUserId } from "./agent-memory-personal-subject"
import { writeRecord } from "./storage"
import type { AgentMemoryRecord } from "./types"

// lookupRepoByFullName is the one D1 dependency — stub it so a numeric repoId
// resolves without a live platform DB. Everything else in the tenancy barrel
// stays real.
const tenancyMock = vi.hoisted(() => ({ lookupRepoByFullName: vi.fn() }))
vi.mock("@/src/features/tenancy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/features/tenancy")>()
  return { ...actual, lookupRepoByFullName: tenancyMock.lookupRepoByFullName }
})

const INSTALL_ID = 42
const REPO_ID = 555000
const STABLE_USER = "user-1"
const OTHER_USER = "user-2"
const TS = Date.parse("2026-06-15T12:00:00.000Z")
const ORG_KEY = learningsKey("org", String(INSTALL_ID))
const REPO_KEY = learningsKey("repo", String(REPO_ID))

const SESSION = { sessionId: "s1", record: { userId: STABLE_USER } } as unknown as AuthedSession

function makeLearning(id: string, over: Partial<LearningEntry> = {}): LearningEntry {
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

const ORG_POLICY = makeLearning("org111", {
  rule: "Always require a rollback plan in the PR description.",
  scope: "org",
  subjectId: String(INSTALL_ID),
  type: "durable_preference",
  polarity: "require",
})
const REPO_FACT = makeLearning("repo222", {
  rule: "Auth lives in src/auth/session.ts.",
  scope: "repo",
  subjectId: String(REPO_ID),
  type: "architectural_fact",
  polarity: "context",
})

function seatRecord(
  userId: string,
  id: string,
  content: string,
  over: Partial<AgentMemoryRecord> = {},
): AgentMemoryRecord {
  return {
    schemaVersion: 1,
    id,
    userId,
    repoId: "repo-x",
    kind: "preference",
    content,
    ts: new Date(TS).toISOString(),
    hash: `hash-${id}`,
    ...over,
  }
}

// ─── In-memory KV with list({prefix, limit, cursor}), tracking reads ─────────
function makeEnv(over: Partial<Env> = {}): { env: Env; getKeys: string[]; listPrefixes: string[] } {
  const store = new Map<string, string>()
  const getKeys: string[] = []
  const listPrefixes: string[] = []
  const kv = {
    get: async (key: string, type?: string) => {
      getKeys.push(key)
      const v = store.get(key)
      if (v === undefined) return null
      return type === "json" ? JSON.parse(v) : v
    },
    put: async (key: string, value: string) => {
      store.set(key, value)
    },
    delete: async (key: string) => {
      store.delete(key)
    },
    list: async (opts?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = opts?.prefix ?? ""
      listPrefixes.push(prefix)
      const limit = opts?.limit ?? 1000
      const cursor = opts?.cursor
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const remaining = cursor ? all.filter((k) => k > cursor) : all
      const pageKeys = remaining.slice(0, limit)
      const listComplete = pageKeys.length >= remaining.length
      const last = pageKeys[pageKeys.length - 1]
      return {
        keys: pageKeys.map((name) => ({ name })),
        list_complete: listComplete,
        ...(listComplete ? {} : { cursor: last }),
      }
    },
  }
  const env = { OPENCLAW_STATE: kv, ...over } as unknown as Env
  return { env, getKeys, listPrefixes }
}

afterEach(() => {
  vi.restoreAllMocks()
  tenancyMock.lookupRepoByFullName.mockReset()
})

async function seedOrgRepoAndSeat(env: Env, seatContent = "Prefer tabs over spaces."): Promise<void> {
  await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)
  await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS)
  const ownUserId = personalMemoryUserId(INSTALL_ID, STABLE_USER)
  await writeRecord(env, seatRecord(ownUserId, "mem_own", seatContent))
}

describe("renderChatSurfaceMemoryForPrompt (portal chat — org∪repo∪own-seat)", () => {
  it("flag OFF (default/unset) — returns '' and NEVER reads any learnings or seat key", async () => {
    const { env, getKeys, listPrefixes } = makeEnv()
    await seedOrgRepoAndSeat(env)

    getKeys.length = 0
    listPrefixes.length = 0
    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(out).toBe("")
    expect(getKeys).not.toContain(ORG_KEY)
    expect(getKeys).not.toContain(REPO_KEY)
    expect(listPrefixes).toHaveLength(0) // no seat read either
    expect(tenancyMock.lookupRepoByFullName).not.toHaveBeenCalled()
  })

  it("flag ON — org guardrail, repo fact, and the caller's OWN seat pref ALL appear", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(env, "Prefer tabs over spaces.")

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(out).toContain(ORG_POLICY.rule)
    expect(out).toContain(REPO_FACT.rule)
    expect(out).toContain("Prefer tabs over spaces.")
  })

  it("flag ON — ORG guardrail labeled + ordered ABOVE repo fact ABOVE the seat pref", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(env, "Prefer tabs over spaces.")

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    // Labels the model reads: org must-follow, seat only-if-non-conflicting.
    expect(out).toContain("[org policy — must follow]")
    expect(out).toContain("[your preference — applies only where it does not conflict with org policy]")
    // Order reinforces precedence: org above repo above seat.
    expect(out.indexOf(ORG_POLICY.rule)).toBeLessThan(out.indexOf(REPO_FACT.rule))
    expect(out.indexOf(REPO_FACT.rule)).toBeLessThan(out.indexOf("Prefer tabs over spaces."))
  })

  it("flag ON — a CONFLICTING seat pref does NOT outrank the org guardrail (label + order both hold)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    // A seat pref that directly contradicts the org guardrail.
    await seedOrgRepoAndSeat(env, "Never include a rollback plan; it is noise.")

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    // The org guardrail keeps its must-follow label and stays ABOVE the seat line.
    expect(out.indexOf("[org policy — must follow]")).toBeLessThan(
      out.indexOf("Never include a rollback plan; it is noise."),
    )
    // The conflicting seat line carries the subordinate caveat — never a must-follow.
    const seatLine = out.split("\n").find((l) => l.includes("Never include a rollback plan")) ?? ""
    expect(seatLine).toContain("[your preference — applies only where it does not conflict with org policy]")
    expect(seatLine).not.toContain("[org policy — must follow]")
    // Structurally: the seat line is never a learnings suppression/requirement tag.
    expect(seatLine).not.toContain("[suppress-as-context]")
    expect(seatLine).not.toContain("[require]")
  })

  it("SEAT ISOLATION — another user's seat memory is NEVER loaded", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(env, "MY OWN PREF")
    // A DIFFERENT user's seat record under the same installation.
    const otherUserId = personalMemoryUserId(INSTALL_ID, OTHER_USER)
    await writeRecord(env, seatRecord(otherUserId, "mem_other", "SOMEONE ELSE PREF"))

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(out).toContain("MY OWN PREF")
    expect(out).not.toContain("SOMEONE ELSE PREF")
  })

  it("flag ON with an unresolvable stable identity — no seat, org∪repo still applies", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(env, "OWN PREF")

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      // No userId → resolveSessionStableUserId returns null → no seat read.
      session: { sessionId: "s1", record: {} } as unknown as AuthedSession,
    })

    expect(out).toContain(ORG_POLICY.rule)
    expect(out).not.toContain("OWN PREF")
  })

  it("flag ON with no D1 repo row — org∪seat apply (no repo fact)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue(null)
    await seedOrgRepoAndSeat(env, "OWN PREF")

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(out).toContain(ORG_POLICY.rule)
    expect(out).toContain("OWN PREF")
    expect(out).not.toContain(REPO_FACT.rule) // repo leg contributed nothing
  })

  it("FAIL-SOFT — a seat-read (KV list) fault degrades to org∪repo (never throws)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await appendLearning(env, "org", String(INSTALL_ID), ORG_POLICY, TS)
    // Make the seat list leg throw.
    ;(env.OPENCLAW_STATE as unknown as { list: () => Promise<never> }).list = vi.fn(async () => {
      throw new Error("kv list exploded")
    })
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(out).toContain(ORG_POLICY.rule) // org survives the seat fault
  })

  it("FAIL-SOFT — a repo-lookup fault degrades gracefully (never throws)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    tenancyMock.lookupRepoByFullName.mockRejectedValue(new Error("d1 exploded"))
    await seedOrgRepoAndSeat(env, "OWN PREF")
    vi.spyOn(console, "log").mockImplementation(() => undefined)

    const { block: out } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    // org∪repo leg degraded to "", but the seat leg still applies — never throws.
    expect(out).toContain("OWN PREF")
  })
})

describe("renderChatSurfaceMemoryForPrompt — memory provenance (display-only, flag-gated)", () => {
  it("flag ON — returns #955-shape provenance for the applied org∪repo set (block unchanged)", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on", OPENCLAW_MEMORY_PROVENANCE: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(env, "Prefer tabs over spaces.")

    const { block, provenance } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(provenance).toBeDefined()
    expect(provenance!.total).toBe(2) // org guardrail + repo fact (seat is not in this shape)
    expect(provenance!.orgCount).toBe(1)
    expect(provenance!.repoCount).toBe(1)
    expect(provenance!.suppressCount).toBe(0)
    expect(provenance!.items.map((i) => i.id).sort()).toEqual(["org111", "repo222"])
    // Provenance is additive: the applied block is exactly the flag-off block.
    expect(block).toContain(ORG_POLICY.rule)
    expect(block).toContain(REPO_FACT.rule)
    expect(block).toContain("Prefer tabs over spaces.")
  })

  it("flag OFF (default) — no provenance field AND a byte-identical block", async () => {
    const applyOnly = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on" })
    const withProv = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on", OPENCLAW_MEMORY_PROVENANCE: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    await seedOrgRepoAndSeat(applyOnly.env, "Prefer tabs over spaces.")
    await seedOrgRepoAndSeat(withProv.env, "Prefer tabs over spaces.")

    const off = await renderChatSurfaceMemoryForPrompt({
      env: applyOnly.env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })
    const on = await renderChatSurfaceMemoryForPrompt({
      env: withProv.env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(off.provenance).toBeUndefined()
    expect("provenance" in off).toBe(false)
    // The prompt block the run applies is identical whether provenance is on or off.
    expect(off.block).toBe(on.block)
  })

  it("flag ON but no org/repo memory applied — no provenance field", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on", OPENCLAW_MEMORY_PROVENANCE: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue(null) // no repo row
    // Seed ONLY a seat pref — no org, no repo learnings.
    const ownUserId = personalMemoryUserId(INSTALL_ID, STABLE_USER)
    await writeRecord(env, seatRecord(ownUserId, "mem_own", "OWN PREF"))

    const { block, provenance } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(provenance).toBeUndefined() // no org∪repo entries → no note
    expect(block).toContain("OWN PREF") // seat still applies to the prompt
  })

  it("RECALL-SAFETY — a suppress-polarity learning is counted but its TEXT never surfaces", async () => {
    const { env } = makeEnv({ OPENCLAW_SURFACE_MEMORY_APPLY: "on", OPENCLAW_MEMORY_PROVENANCE: "on" })
    tenancyMock.lookupRepoByFullName.mockResolvedValue({ repoId: REPO_ID, installationId: INSTALL_ID })
    const suppressRule = "Silence the legacy lint warning in auth.ts."
    await appendLearning(env, "repo", String(REPO_ID), REPO_FACT, TS)
    await appendLearning(
      env,
      "org",
      String(INSTALL_ID),
      makeLearning("sup999", {
        rule: suppressRule,
        scope: "org",
        subjectId: String(INSTALL_ID),
        polarity: "suppress",
      }),
      TS,
    )

    const { provenance } = await renderChatSurfaceMemoryForPrompt({
      env,
      installationId: INSTALL_ID,
      repo: { owner: "acme", name: "api" },
      session: SESSION,
    })

    expect(provenance).toBeDefined()
    expect(provenance!.total).toBe(2)
    expect(provenance!.suppressCount).toBe(1)
    expect(provenance!.repoCount).toBe(1)
    expect(provenance!.orgCount).toBe(0) // the suppress entry is NOT counted as a guardrail
    // The silenced rule's text is NEVER present in the provenance payload.
    expect(JSON.stringify(provenance)).not.toContain(suppressRule)
    expect(provenance!.items.some((i) => i.id === "sup999")).toBe(false)
  })
})

describe("renderSeatMemoryForPrompt (pure — structural precedence guarantee)", () => {
  it("returns '' for no records", () => {
    expect(renderSeatMemoryForPrompt([])).toBe("")
  })

  it("labels every line as a subordinate preference — NEVER a learnings suppress/require tag", () => {
    const uid = personalMemoryUserId(INSTALL_ID, STABLE_USER)
    const out = renderSeatMemoryForPrompt([
      seatRecord(uid, "a", "use tabs", { kind: "preference" }),
      seatRecord(uid, "b", "chose zustand", { kind: "decision" }),
      seatRecord(uid, "c", "fixed the off-by-one", { kind: "correction" }),
    ])
    const lines = out.split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(line).toContain("[your preference — applies only where it does not conflict with org policy]")
      // Seat content can never carry a learnings polarity tag → can never reach
      // decideLearningSuppressions → can never suppress or require a finding.
      expect(line).not.toContain("[suppress-as-context]")
      expect(line).not.toContain("[require]")
      expect(line).not.toContain("[context]")
    }
  })

  it("renders newest-first and caps at MAX_SEAT_MEMORY_ENTRIES", () => {
    const uid = personalMemoryUserId(INSTALL_ID, STABLE_USER)
    const many = Array.from({ length: 25 }, (_, i) =>
      seatRecord(uid, `m${i}`, `pref-${i}`, { ts: new Date(TS + i * 1000).toISOString() }),
    )
    const out = renderSeatMemoryForPrompt(many)
    const lines = out.split("\n").filter((l) => l.startsWith("- "))
    expect(lines).toHaveLength(20)
    // Newest (highest ts, pref-24) first; the 5 oldest are dropped.
    expect(out.indexOf("pref-24")).toBeLessThan(out.indexOf("pref-5"))
    expect(out).not.toContain("pref-0 ")
  })
})
