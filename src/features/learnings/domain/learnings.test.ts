import { describe, expect, it, vi } from "vitest"

import { resolveLearningsMode } from "@/src/features/learnings/domain/mode"
import {
  MAX_LEARNINGS,
  computeLearningId,
  learningsKey,
  normalizeRule,
  removeEntry,
  selectRelevantForPaths,
  upsertEntry,
} from "@/src/features/learnings/domain/store-ops"
import { parseLearningsCommand } from "@/src/features/learnings/domain/command"
import {
  renderBoostedCategoriesForPrompt,
  renderConfirmReply,
  renderForgetConfirm,
  renderLearningsForPrompt,
  renderOverviewFooter,
} from "@/src/features/learnings/domain/render"
import {
  appendLearning,
  forgetLearning,
  hardDeleteLearnings,
  loadLearnings,
} from "@/src/features/learnings/adapters/store"
import {
  CONFIRMATION_MAP_TTL_SECONDS,
  recordConfirmationMap,
  resolveConfirmationMap,
} from "@/src/features/learnings/adapters/confirmation-map"
import { hasRepoWriteAccess } from "@/src/features/learnings/adapters/authz"
import { emitLearningAudit } from "@/src/features/learnings/adapters/audit"
import type { LearningEntry, LearningStore } from "@/src/features/learnings/domain/types"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { Env } from "@/src/shared/types/env"

const TS = "2026-06-15T12:00:00.000Z"

function entry(overrides: Partial<LearningEntry> = {}): LearningEntry {
  return {
    id: overrides.id ?? "l1",
    rule: overrides.rule ?? "Prefer service-layer database access.",
    polarity: overrides.polarity ?? "context",
    category: overrides.category ?? null,
    pathGlob: overrides.pathGlob ?? null,
    scope: overrides.scope ?? "repo",
    subjectId: overrides.subjectId ?? "123",
    source: overrides.source ?? { kind: "command", prNumber: 7, commentId: 99 },
    createdTs: overrides.createdTs ?? TS,
    ...(overrides.lastAppliedTs !== undefined ? { lastAppliedTs: overrides.lastAppliedTs } : {}),
    appliedCount: overrides.appliedCount ?? 0,
    ...(overrides.authorLogin !== undefined ? { authorLogin: overrides.authorLogin } : {}),
  }
}

function store(entries: LearningEntry[] = []): LearningStore {
  return {
    schemaVersion: 1,
    scope: "repo",
    subjectId: "123",
    entries,
  }
}

function makeEnv() {
  const values = new Map<string, string>()
  const expirations = new Map<string, number>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      values.set(key, value)
      if (options?.expirationTtl !== undefined) expirations.set(key, options.expirationTtl)
    },
    async delete(key: string): Promise<void> {
      values.delete(key)
    },
  }
  return {
    env: { OPENCLAW_STATE: kv } as unknown as Env,
    values,
    expirations,
  }
}

describe("resolveLearningsMode", () => {
  it("defaults to off and accepts shadow/on only", () => {
    expect(resolveLearningsMode(undefined)).toBe("off")
    expect(resolveLearningsMode("")).toBe("off")
    expect(resolveLearningsMode("off")).toBe("off")
    expect(resolveLearningsMode("shadow")).toBe("shadow")
    expect(resolveLearningsMode("on")).toBe("on")
    expect(resolveLearningsMode("enforce")).toBe("off")
  })
})

describe("store-ops", () => {
  it("builds the scope-parameterized key", () => {
    expect(learningsKey("repo", "987654")).toBe("learnings:repo:987654")
    expect(learningsKey("org", "sigilix")).toBe("learnings:org:sigilix")
    expect(learningsKey("project", "SIG")).toBe("learnings:project:SIG")
  })

  it("normalizes commands and redacts secrets, emails, and tokens before storage", () => {
    expect(
      normalizeRule(
        "  remember   Please email alice@example.com and use github_pat_1234567890abcdef1234567890abcdef1234 in auth.  ",
      ),
    ).toBe("Please email [redacted-email] and use [redacted-token] in auth.")
    expect(normalizeRule("NOTE:   always keep DB calls in service classes")).toBe(
      "always keep DB calls in service classes",
    )
    expect(normalizeRule('remember that password = "super-secret-value" for tests')).toBe(
      "that password = [redacted-secret] for tests",
    )
  })

  it("computes a stable sha16 id over the normalized rule", async () => {
    await expect(computeLearningId("Prefer service-layer database access.")).resolves.toMatch(/^[0-9a-f]{16}$/)
    await expect(computeLearningId("Prefer service-layer database access.")).resolves.toBe(
      await computeLearningId("Prefer service-layer database access."),
    )
  })

  it("dedupes by id and bumps usage instead of appending", () => {
    const existing = entry({ id: "same", appliedCount: 2, lastAppliedTs: "2026-06-14T00:00:00.000Z" })
    const next = upsertEntry(store([existing]), entry({ id: "same", rule: "Newer text" }), TS)
    expect(next.entries).toHaveLength(1)
    expect(next.entries[0]).toMatchObject({
      id: "same",
      rule: "Prefer service-layer database access.",
      appliedCount: 3,
      lastAppliedTs: TS,
    })
  })

  it("evicts the least-recently-applied entry at the cap", () => {
    const entries = Array.from({ length: MAX_LEARNINGS }, (_, i) =>
      entry({
        id: `id-${i}`,
        rule: `Rule ${i}`,
        createdTs: new Date(Date.parse(TS) + i).toISOString(),
        ...(i === 0 ? {} : { lastAppliedTs: new Date(Date.parse(TS) + i * 1000).toISOString() }),
        appliedCount: i,
      }),
    )
    const next = upsertEntry(store(entries), entry({ id: "fresh", rule: "Fresh rule" }), TS)
    expect(next.entries).toHaveLength(MAX_LEARNINGS)
    expect(next.entries.some((e) => e.id === "id-0")).toBe(false)
    expect(next.entries.some((e) => e.id === "fresh")).toBe(true)
  })

  it("removes a matching entry by id", () => {
    expect(removeEntry(store([entry({ id: "a" }), entry({ id: "b" })]), "a").entries.map((e) => e.id)).toEqual(["b"])
  })

  it("selects repo-wide and matching path-glob rules within the character budget", () => {
    const selected = selectRelevantForPaths(
      [
        entry({ id: "global", rule: "Repo-wide guidance", pathGlob: null }),
        entry({ id: "api", rule: "API guidance", pathGlob: "src/api/**" }),
        entry({ id: "docs", rule: "Docs guidance", pathGlob: "docs/**" }),
        entry({ id: "long", rule: "x".repeat(300), pathGlob: null }),
      ],
      ["src/api/users.ts"],
      80,
    )
    expect(selected.map((e) => e.id)).toEqual(["global", "api"])
  })
})

describe("parseLearningsCommand", () => {
  it("parses remember, forget, and list commands", () => {
    // Parser receives the MENTION-STRIPPED command text (caller strips the
    // @-handle, like parseDismissCommand) — so it's trigger-agnostic (P1 fix).
    expect(parseLearningsCommand("remember always wrap DB calls")).toEqual({
      kind: "remember",
      rule: "always wrap DB calls",
    })
    expect(parseLearningsCommand("  forget ")).toEqual({ kind: "forget" })
    expect(parseLearningsCommand("list")).toEqual({ kind: "list" })
    expect(parseLearningsCommand("remember")).toBeNull()
    expect(parseLearningsCommand("thanks for the review")).toBeNull()
    // An un-stripped mention is NOT a command here — documents the contract
    // (the caller must strip the handle before calling).
    expect(parseLearningsCommand("@sigilix remember x")).toBeNull()
  })
})

describe("rendering", () => {
  it("renders the confirmation reply copy", () => {
    expect(renderConfirmReply("Prefer service-layer database access.")).toMatchInlineSnapshot(`
      "<sub>Learned something new</sub>
      > "Prefer service-layer database access."
      > Undo: reply \`@sigilix forget\` to this comment."
    `)
  })

  it("renders the forget confirmation copy", () => {
    expect(renderForgetConfirm()).toMatchInlineSnapshot(`
      "Forgot that rule.

      <sub>Sigilix will no longer apply it in future reviews.</sub>"
    `)
  })

  it("renders learnings for prompts with recall-safe suppress wording", () => {
    expect(
      renderLearningsForPrompt([
        entry({ rule: "Prefer service-layer database access.", polarity: "require" }),
        entry({ rule: "Treat generated SDK files as context only.", polarity: "suppress" }),
        entry({ rule: "Billing invariants live in docs/billing.md.", polarity: "context" }),
      ]),
    ).toMatchInlineSnapshot(`
      "## Repository-specific guidance (learned from past reviews)
      - [require] Prefer service-layer database access.
      - [suppress-as-context] Treat generated SDK files as context only. Use this only as context for noise reduction; do not silently drop security, logic, P0, or P1 findings.
      - [context] Billing invariants live in docs/billing.md."
    `)
  })

  it("renders the overview footer with rule text only", () => {
    expect(renderOverviewFooter([entry({ id: "secret-id", rule: "Prefer service-layer database access." })]))
      .toMatchInlineSnapshot(`
        "<sub>·</sub> <details><summary><b>Memory</b> · 1 rules applied</summary>

        - Prefer service-layer database access.
        </details>"
      `)
  })

  it("renders the precision-profile boost line and dedupes, empty when no category is boosted", () => {
    // SIG-104 PR-3: the computed-but-unused boost finally applied at the prompt gate.
    expect(renderBoostedCategoriesForPrompt([])).toBe("")
    expect(renderBoostedCategoriesForPrompt(["security", "logic", "security"])).toBe(
      "Prioritize findings in these repeatedly-valued categories (do not lower the bar elsewhere): security, logic.",
    )
  })
})

describe("adapters/store", () => {
  it("round-trips learnings through KV and never sets a TTL", async () => {
    const { env, values, expirations } = makeEnv()
    await appendLearning(env, "repo", "123", entry({ id: "one" }), Date.parse(TS))
    await appendLearning(env, "repo", "123", entry({ id: "one" }), Date.parse(TS) + 1)
    const loaded = await loadLearnings(env, "repo", "123")
    expect(loaded?.entries).toHaveLength(1)
    expect(loaded?.entries[0]?.appliedCount).toBe(1)
    expect(values.has("learnings:repo:123")).toBe(true)
    // Learnings are durable — the write must NOT carry a TTL (CR).
    expect(expirations.has("learnings:repo:123")).toBe(false)
  })

  it("forgets one learning and hard-deletes the whole scoped store", async () => {
    const { env, values } = makeEnv()
    await appendLearning(env, "repo", "123", entry({ id: "one" }), Date.parse(TS))
    await appendLearning(env, "repo", "123", entry({ id: "two" }), Date.parse(TS))
    await forgetLearning(env, "repo", "123", "one")
    expect((await loadLearnings(env, "repo", "123"))?.entries.map((e) => e.id)).toEqual(["two"])
    await hardDeleteLearnings(env, "repo", "123")
    expect(values.has("learnings:repo:123")).toBe(false)
  })

  it("returns safe defaults on KV failures", async () => {
    const env = {
      OPENCLAW_STATE: {
        async get(): Promise<string | null> {
          throw new Error("kv down")
        },
        async put(): Promise<void> {
          throw new Error("kv down")
        },
        async delete(): Promise<void> {
          throw new Error("kv down")
        },
      },
    } as unknown as Env
    await expect(loadLearnings(env, "repo", "123")).resolves.toBeNull()
    await expect(appendLearning(env, "repo", "123", entry(), Date.parse(TS))).resolves.toBe(false)
    await expect(forgetLearning(env, "repo", "123", "one")).resolves.toBe(false)
    await expect(hardDeleteLearnings(env, "repo", "123")).resolves.toBe(false)
  })
})

describe("adapters/confirmation-map", () => {
  it("records a durable confirmation comment mapping with a 90d TTL", async () => {
    const { env, expirations } = makeEnv()
    const value = { scope: "repo" as const, subjectId: "123", learningId: "abc" }
    await expect(recordConfirmationMap(env, 456, value)).resolves.toBe(true)
    await expect(resolveConfirmationMap(env, 456)).resolves.toEqual(value)
    expect(expirations.get("learning-confirmation:456")).toBe(CONFIRMATION_MAP_TTL_SECONDS)
  })

  it("fails closed on invalid mappings and KV errors", async () => {
    const { env, values } = makeEnv()
    values.set("learning-confirmation:bad", JSON.stringify({ subjectId: "123" }))
    await expect(resolveConfirmationMap(env, "bad")).resolves.toBeNull()
    // KV get throws → fail closed (null), never propagate (CR).
    const throwingEnv = {
      OPENCLAW_STATE: {
        async get(): Promise<string | null> {
          throw new Error("kv down")
        },
      },
    } as unknown as Env
    await expect(resolveConfirmationMap(throwingEnv, 456)).resolves.toBeNull()
  })
})

describe("adapters/authz", () => {
  it("accepts write/admin/maintain and rejects read or missing login", async () => {
    let permission = "write"
    const client: Pick<GitHubClient, "restGet"> = {
      async restGet<T>(): Promise<T> {
        return { permission } as T
      },
    }
    await expect(hasRepoWriteAccess(client, "o", "r", "alice")).resolves.toBe(true)
    permission = "admin"
    await expect(hasRepoWriteAccess(client, "o", "r", "alice")).resolves.toBe(true)
    permission = "maintain"
    await expect(hasRepoWriteAccess(client, "o", "r", "alice")).resolves.toBe(true)
    permission = "read"
    await expect(hasRepoWriteAccess(client, "o", "r", "alice")).resolves.toBe(false)
    await expect(hasRepoWriteAccess(client, "o", "r", "")).resolves.toBe(false)
  })

  it("fails closed on API errors", async () => {
    const client: Pick<GitHubClient, "restGet"> = {
      async restGet() {
        throw new Error("forbidden")
      },
    }
    await expect(hasRepoWriteAccess(client, "o", "r", "alice")).resolves.toBe(false)
  })
})

describe("adapters/audit", () => {
  it("emits the structured learning mutation audit event", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    emitLearningAudit({
      actor: "alice",
      scope: "repo",
      subjectId: "123",
      action: "remember",
      learningId: "abc",
      ts: TS,
    })
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
      event: "learning-mutation-audit",
      actor: "alice",
      scope: "repo",
      subject_id: "123",
      action: "remember",
      learning_id: "abc",
      ts: TS,
    })
    spy.mockRestore()
  })
})
