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

// ─── Fixtures ────────────────────────────────────────────────

// Minimal Env — all binding calls are mocked; the cast is safe in test scope.
const env = {} as Env

// teamId has mixed-case to validate canonicalization ("T1" → "slack:t1")
const scope: SlackMemoryScope = { teamId: "T1", repoId: "o/r" }

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
    // teamId "T1" canonicalizes to "slack:t1"; repoId "o/r" is already canonical.
    expect(vi.mocked(storeMemoryFact)).toHaveBeenCalledWith(env, {
      userId: "slack:t1",
      repoId: "o/r",
      kind: "preference",
      content: "prefer tabs for indentation",
    })
  })
})
