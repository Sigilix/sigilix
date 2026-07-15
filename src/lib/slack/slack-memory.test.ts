// SIG-196: unit tests for slack-memory adapter — scoped recall + credential-gated
// capture over the SIG-522 agent-memory store (Vectorize+KV).
//
// All memory-store modules are mocked; canonicalTenantId is kept real so the
// canonicalization contract (trim+lowercase) is verified end-to-end without
// executing Workers-specific bindings (AI, Vectorize, KV).

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentMemoryRecord } from "@/src/lib/agent-memory/types"
import { storeMemoryFact } from "@/src/lib/agent-memory/agent-memory-route"
import { queryMemoryIds } from "@/src/lib/agent-memory/retrieval"
import { readRecord } from "@/src/lib/agent-memory/storage"
import type { Env } from "@/src/shared/types/env"
import { captureSlackMemory, recallSlackMemory } from "@/src/lib/slack/slack-memory"
import type { SlackMemoryScope } from "@/src/lib/slack/slack-memory"

const { containsCredentialTokenMock } = vi.hoisted(() => ({
  containsCredentialTokenMock: vi.fn<(text: string) => boolean>(),
}))

// ─── Module mocks ────────────────────────────────────────────

vi.mock("@/src/lib/agent-memory/retrieval", () => ({
  queryMemoryIds: vi.fn(),
}))

vi.mock("@/src/lib/agent-memory/storage", () => ({
  readRecord: vi.fn(),
}))

// Keep canonicalTenantId as a real passthrough (trim+lowercase) so the
// canonicalization path is exercised. Mock only storeMemoryFact.
vi.mock("@/src/lib/agent-memory/agent-memory-route", () => ({
  storeMemoryFact: vi.fn(),
  canonicalTenantId: (value: string) => value.trim().toLowerCase(),
}))

vi.mock("@/src/lib/secret-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/secret-scan")>()
  containsCredentialTokenMock.mockImplementation(actual.containsCredentialToken)
  return { ...actual, containsCredentialToken: containsCredentialTokenMock }
})

// ─── Fixtures ────────────────────────────────────────────────

function makeEnv(mode?: string): Env {
  return { OPENCLAW_SLACK_MEMORY_SCOPE_MODE: mode } as unknown as Env
}

// `repoId` keeps the fixture executable against the pre-change adapter for the
// required red run; the versioned adapter ignores it and derives both ids from
// the trusted scope fields.
const scope = {
  teamId: "T1",
  channelId: "C1",
  installationId: 42,
  repos: [
    { githubRepoId: 10, owner: "renamed", repo: "web" },
    { githubRepoId: 2, owner: "acme", repo: "api" },
  ],
  repoId: "renamed/web",
} as unknown as SlackMemoryScope

const env = makeEnv()
const exactEnv = makeEnv("on")
const shadowEnv = makeEnv("shadow")
const EXACT_USER_ID = "slack:v2:d6982f7844392742c9f853fefd"
const EXACT_REPO_ID = "s-9cd3b628a76b9e8314943e35a7"

function makeRecord(content: string): AgentMemoryRecord {
  return {
    schemaVersion: 1,
    id: "mem_test",
    userId: "slack:t1",
    repoId: "o/r",
    kind: "preference",
    content,
    ts: new Date().toISOString(),
    hash: "abc",
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── recallSlackMemory ────────────────────────────────────────

describe("recallSlackMemory", () => {
  it("(a) maps hit ids → record contents in order, preserving hit order", async () => {
    vi.mocked(queryMemoryIds).mockResolvedValue([
      { id: "mem_1", score: 0.9 },
      { id: "mem_2", score: 0.8 },
    ])
    vi.mocked(readRecord)
      .mockResolvedValueOnce(makeRecord("first fact"))
      .mockResolvedValueOnce(makeRecord("second fact"))

    const result = await recallSlackMemory(env, scope, "what does the user prefer?")
    expect(result).toEqual(["first fact", "second fact"])
    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledWith(env, {
      userId: "slack:t1",
      repoId: "renamed/web",
      query: "what does the user prefer?",
      topK: 5,
    })
  })

  it("(b) returns [] when queryMemoryIds throws (soft-fail)", async () => {
    vi.mocked(queryMemoryIds).mockRejectedValue(new Error("vectorize error"))
    const result = await recallSlackMemory(env, scope, "query")
    expect(result).toEqual([])
  })

  it("(c) skips a hit whose readRecord returns null, keeps the rest", async () => {
    vi.mocked(queryMemoryIds).mockResolvedValue([
      { id: "mem_1", score: 0.9 },
      { id: "mem_2", score: 0.8 },
    ])
    vi.mocked(readRecord)
      .mockResolvedValueOnce(null) // first hit has no record
      .mockResolvedValueOnce(makeRecord("second fact"))

    const result = await recallSlackMemory(env, scope, "query")
    expect(result).toEqual(["second fact"])
  })

  it("uses one pinned versioned namespace for exact recall and capture", async () => {
    vi.mocked(queryMemoryIds).mockResolvedValue([])
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "mem_exact",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    await recallSlackMemory(exactEnv, scope, "exact query", 3)
    await captureSlackMemory(exactEnv, scope, { kind: "preference", content: "exact fact" })

    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledWith(exactEnv, {
      userId: EXACT_USER_ID,
      repoId: EXACT_REPO_ID,
      query: "exact query",
      topK: 3,
    })
    expect(vi.mocked(storeMemoryFact)).toHaveBeenCalledWith(exactEnv, {
      userId: EXACT_USER_ID,
      repoId: EXACT_REPO_ID,
      kind: "preference",
      content: "exact fact",
    })
    const namespace = `${EXACT_USER_ID}/${EXACT_REPO_ID}`
    expect(namespace).toMatch(/^slack:v2:[0-9a-f]{26}\/s-[0-9a-f]{26}$/)
    expect(new TextEncoder().encode(namespace)).toHaveLength(64)
  })

  it("canonicalizes immutable repository ids and separates every authority dimension", async () => {
    vi.mocked(queryMemoryIds).mockResolvedValue([])
    const observedIds = async (candidate: Record<string, unknown>) => {
      await recallSlackMemory(exactEnv, candidate as unknown as SlackMemoryScope, "query")
      const call = vi.mocked(queryMemoryIds).mock.calls.at(-1)?.[1]
      if (!call) throw new Error("missing memory query")
      return { userId: call.userId, repoId: call.repoId }
    }
    const base = await observedIds(scope as unknown as Record<string, unknown>)
    const reorderedAndRenamed = await observedIds({
      teamId: "t1",
      channelId: "c1",
      installationId: 42,
      repos: [
        { githubRepoId: 2, owner: "new", repo: "api-renamed" },
        { githubRepoId: 10, owner: "new", repo: "web-renamed" },
        { githubRepoId: 2, owner: "duplicate", repo: "ignored" },
      ],
    })

    expect(base).toEqual({ userId: EXACT_USER_ID, repoId: EXACT_REPO_ID })
    expect(reorderedAndRenamed).toEqual(base)
    await expect(observedIds({ ...scope, teamId: "T2" })).resolves.not.toEqual(base)
    await expect(observedIds({ ...scope, channelId: "C2" })).resolves.not.toEqual(base)
    await expect(observedIds({ ...scope, installationId: 43 })).resolves.not.toEqual(base)
    await expect(
      observedIds({ ...scope, repos: [{ githubRepoId: 2, owner: "acme", repo: "api" }] }),
    ).resolves.not.toEqual(base)
  })

  it("keeps shadow recall legacy-authoritative while measuring the exact sidecar", async () => {
    vi.mocked(queryMemoryIds).mockImplementation(async (_env, args) => [
      { id: args.userId.startsWith("slack:v2:") ? "mem_exact" : "mem_legacy", score: 1 },
    ])
    vi.mocked(readRecord).mockResolvedValue(makeRecord("same fact"))

    const result = await recallSlackMemory(shadowEnv, scope, "query")

    expect(result).toEqual(["same fact"])
    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledWith(
      shadowEnv,
      expect.objectContaining({ userId: "slack:t1", repoId: "renamed/web" }),
    )
    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledWith(
      shadowEnv,
      expect.objectContaining({ userId: EXACT_USER_ID, repoId: EXACT_REPO_ID }),
    )
  })

  it("isolates exact shadow failures from the legacy recall and capture result", async () => {
    vi.mocked(queryMemoryIds).mockImplementation(async (_env, args) => {
      if (args.userId.startsWith("slack:v2:")) throw new Error("exact query failed")
      return [{ id: "mem_legacy", score: 1 }]
    })
    vi.mocked(readRecord).mockResolvedValue(makeRecord("legacy fact"))
    vi.mocked(storeMemoryFact).mockImplementation(async (_env, args) => {
      if (args.userId.startsWith("slack:v2:")) throw new Error("exact write failed")
      return { id: "mem_legacy", deduped: false, stored: true, vectorStored: true }
    })

    await expect(recallSlackMemory(shadowEnv, scope, "query")).resolves.toEqual(["legacy fact"])
    await expect(captureSlackMemory(shadowEnv, scope, { kind: "preference", content: "clean fact" })).resolves.toEqual({
      stored: true,
      skippedSecret: false,
    })
    expect(vi.mocked(storeMemoryFact)).toHaveBeenCalledTimes(2)
  })

  it("bounds hung exact shadow sidecars without blocking the legacy result", async () => {
    vi.useFakeTimers()
    const digest = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new Uint8Array(32).buffer)
    try {
      vi.mocked(queryMemoryIds).mockImplementation(async (_env, args) => {
        if (args.userId.startsWith("slack:v2:")) return new Promise(() => {})
        return [{ id: "mem_legacy", score: 1 }]
      })
      vi.mocked(readRecord).mockResolvedValue(makeRecord("legacy fact"))

      const recall = recallSlackMemory(shadowEnv, scope, "query")
      await vi.advanceTimersByTimeAsync(501)
      await expect(recall).resolves.toEqual(["legacy fact"])

      vi.mocked(storeMemoryFact).mockImplementation(async (_env, args) => {
        if (args.userId.startsWith("slack:v2:")) return new Promise(() => {})
        return { id: "mem_legacy", deduped: false, stored: true, vectorStored: true }
      })
      const capture = captureSlackMemory(shadowEnv, scope, { kind: "preference", content: "clean fact" })
      await vi.advanceTimersByTimeAsync(501)
      await expect(capture).resolves.toEqual({ stored: true, skippedSecret: false })
    } finally {
      digest.mockRestore()
      vi.useRealTimers()
    }
  })

  it("bounds hung shadow parity hashing without blocking the legacy result", async () => {
    vi.useFakeTimers()
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
      if (new TextDecoder().decode(data) === "legacy fact") return new Promise(() => {})
      return new Uint8Array(32).buffer
    })
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      vi.mocked(queryMemoryIds).mockResolvedValue([{ id: "mem", score: 1 }])
      vi.mocked(readRecord).mockResolvedValue(makeRecord("legacy fact"))

      const recall = recallSlackMemory(shadowEnv, scope, "query")
      await vi.advanceTimersByTimeAsync(501)

      await expect(recall).resolves.toEqual(["legacy fact"])
      const event = log.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((candidate) => candidate.event === "slack-memory-scope-shadow")
      expect(event).toMatchObject({ operation: "recall", digestStatus: "timed-out" })
    } finally {
      log.mockRestore()
      digest.mockRestore()
      vi.useRealTimers()
    }
  })

  it("fails exact mode closed without falling back when the trusted scope is malformed", async () => {
    const invalid = { ...scope, channelId: "not a Slack id" } as unknown as SlackMemoryScope
    vi.mocked(queryMemoryIds).mockResolvedValue([])
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "must_not_write",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    await expect(recallSlackMemory(exactEnv, invalid, "query")).resolves.toEqual([])
    await expect(captureSlackMemory(exactEnv, invalid, { kind: "preference", content: "clean fact" })).resolves.toEqual(
      {
        stored: false,
        skippedSecret: false,
      },
    )
    expect(vi.mocked(queryMemoryIds)).not.toHaveBeenCalled()
    expect(vi.mocked(storeMemoryFact)).not.toHaveBeenCalled()
  })

  it("keeps malformed exact shadow scope from interrupting valid legacy memory", async () => {
    const invalid = { ...scope, channelId: "not a Slack id" } as unknown as SlackMemoryScope
    vi.mocked(queryMemoryIds).mockResolvedValue([{ id: "mem_legacy", score: 1 }])
    vi.mocked(readRecord).mockResolvedValue(makeRecord("legacy fact"))
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "mem_legacy",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    await expect(recallSlackMemory(shadowEnv, invalid, "query")).resolves.toEqual(["legacy fact"])
    await expect(
      captureSlackMemory(shadowEnv, invalid, { kind: "preference", content: "clean fact" }),
    ).resolves.toEqual({ stored: true, skippedSecret: false })
    expect(vi.mocked(queryMemoryIds)).toHaveBeenCalledOnce()
    expect(vi.mocked(storeMemoryFact)).toHaveBeenCalledOnce()
  })
})

// ─── captureSlackMemory ───────────────────────────────────────

describe("captureSlackMemory", () => {
  it("(d) skips capture + does NOT call storeMemoryFact when content contains a credential token", async () => {
    // AWS access key — unambiguous PROVIDER_RULE match for containsCredentialToken.
    // Pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ → AKIA + IOSFODNN7EXAMPLE (16 chars)
    const secretContent = "AKIAIOSFODNN7EXAMPLE is the key"
    const result = await captureSlackMemory(env, scope, { kind: "preference", content: secretContent })

    expect(result).toEqual({ stored: false, skippedSecret: true })
    expect(vi.mocked(storeMemoryFact)).not.toHaveBeenCalled()
  })

  it("(e) forwards a clean fact with canonicalized ids to storeMemoryFact and returns stored flag", async () => {
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "mem_new",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    const result = await captureSlackMemory(env, scope, {
      kind: "preference",
      content: "prefer tabs for indentation",
    })

    expect(result).toEqual({ stored: true, skippedSecret: false })
    // Off mode remains byte-compatible: team + mutable primary owner/repo.
    expect(vi.mocked(storeMemoryFact)).toHaveBeenCalledWith(env, {
      userId: "slack:t1",
      repoId: "renamed/web",
      kind: "preference",
      content: "prefer tabs for indentation",
    })
  })

  it("fails closed before constructing writes when the credential scanner throws", async () => {
    containsCredentialTokenMock.mockImplementationOnce(() => {
      throw new Error("scanner failed")
    })

    await expect(
      captureSlackMemory(shadowEnv, scope, { kind: "preference", content: "unclassified content" }),
    ).resolves.toEqual({ stored: false, skippedSecret: true })
    expect(vi.mocked(storeMemoryFact)).not.toHaveBeenCalled()
  })

  it("emits content-free shadow parity and write-health telemetry", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.mocked(queryMemoryIds).mockResolvedValue([])
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "mem_new",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    await recallSlackMemory(shadowEnv, scope, "sensitive query text")
    await captureSlackMemory(shadowEnv, scope, { kind: "preference", content: "sensitive memory text" })

    const events = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((event) => event.event === "slack-memory-scope-shadow")
    expect(events).toEqual([
      expect.objectContaining({ operation: "recall", digestParity: true, legacyCount: 0, exactCount: 0 }),
      expect.objectContaining({
        operation: "capture",
        exactStored: true,
        exactVectorStored: true,
        exactDeduped: false,
      }),
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain("sensitive query text")
    expect(serialized).not.toContain("sensitive memory text")
    expect(serialized).not.toContain("mem_new")
    log.mockRestore()
  })

  it("compares shadow recall as an unordered multiset with duplicates preserved", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.mocked(queryMemoryIds).mockImplementation(async (_env, args) =>
      args.userId.startsWith("slack:v2:")
        ? [
            { id: "exact_alpha", score: 1 },
            { id: "exact_beta_1", score: 0.9 },
            { id: "exact_beta_2", score: 0.8 },
          ]
        : [
            { id: "legacy_alpha_1", score: 1 },
            { id: "legacy_alpha_2", score: 0.9 },
            { id: "legacy_beta", score: 0.8 },
          ],
    )
    vi.mocked(readRecord).mockImplementation(async (_env, _userId, _repoId, id) =>
      makeRecord(id.includes("alpha") ? "alpha" : "beta"),
    )

    await recallSlackMemory(shadowEnv, scope, "query")

    const event = log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .find((candidate) => candidate.event === "slack-memory-scope-shadow")
    expect(event).toMatchObject({
      operation: "recall",
      digestParity: false,
      legacyCount: 3,
      exactCount: 3,
      missingExactCount: 1,
      extraExactCount: 1,
    })
    log.mockRestore()
  })

  it("keeps telemetry sink failures from changing shadow recall or capture", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("telemetry unavailable")
    })
    vi.mocked(queryMemoryIds).mockResolvedValue([])
    vi.mocked(storeMemoryFact).mockResolvedValue({
      id: "mem_new",
      deduped: false,
      stored: true,
      vectorStored: true,
    })

    await expect(recallSlackMemory(shadowEnv, scope, "query")).resolves.toEqual([])
    await expect(captureSlackMemory(shadowEnv, scope, { kind: "preference", content: "clean fact" })).resolves.toEqual({
      stored: true,
      skippedSecret: false,
    })
    log.mockRestore()
  })
})
