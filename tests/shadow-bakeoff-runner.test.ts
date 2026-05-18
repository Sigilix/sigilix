// tests/shadow-bakeoff-runner.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { EnsembleRunCtx } from "../src/lib/ensemble-perf-telemetry"
import { runShadowSpecialist, runShadowSynth } from "../src/lib/shadow-bakeoff-runner"

// Mock `chat` so we don't make real HTTP calls. The runner ultimately
// calls runWithRetryAndFallback → attemptChat → chat. We control the
// last hop.
vi.mock("../src/lib/ollama-chat", () => ({
  chat: vi.fn(),
}))

import { chat } from "../src/lib/ollama-chat"

const CTX: EnsembleRunCtx = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 99,
  headSha: "deadbeefcafebabe1234567890abcdef12345678",
}

const VALID_VERDICT_JSON = JSON.stringify({
  verdict: "REQUEST_CHANGES",
  summary: "shadow ran",
  confidence: 4,
  confidenceReason: "high",
  findings: [
    { path: "src/a.ts", line: 1, score: 3, headline: "x", body: "y", category: "logic" },
  ],
})

const VALID_SYNTH_JSON = JSON.stringify({
  verdict: {
    verdict: "REQUEST_CHANGES",
    summary: "shadow synth",
    confidence: 4,
    confidenceReason: "high",
    findings: [
      { path: "src/a.ts", line: 1, score: 3, headline: "x", body: "y", category: "logic" },
    ],
  },
  provenance: {
    findings: [
      { sourceSpecialists: ["logic"], sourceFindingIds: ["logic-1"], action: "kept", verifiedViaRetrieval: false },
    ],
    dropped: [],
    retrievalCallsUsed: 0,
  },
})

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.mocked(chat).mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
})
afterEach(() => {
  logSpy.mockRestore()
})

function shadowAttemptEvents(): Array<Record<string, unknown>> {
  return logSpy.mock.calls
    .map((c) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((e) => e["event"] === "shadow-model-attempt-completed")
}

describe("runShadowSpecialist", () => {
  it("returns the verdict + emits one shadow-model-attempt-completed event on primary success", async () => {
    vi.mocked(chat).mockResolvedValueOnce({ message: { role: "assistant", content: VALID_VERDICT_JSON } })
    const result = await runShadowSpecialist({
      role: "security",
      shadowConfig: { primary: "qwen3-coder-next:cloud", retries: 1, fallback: "deepseek-v4-flash:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.modelUsed).toBe("qwen3-coder-next:cloud")
    expect(result.attemptsUsed).toBe(1)
    expect(result.findings).toHaveLength(1)
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      role: "security",
      attemptKind: "primary",
      attemptIndex: 1,
      model: "qwen3-coder-next:cloud",
      outcome: "ok",
    })
  })

  it("emits two events + falls back to cross-provider on primary failure", async () => {
    vi.mocked(chat).mockRejectedValueOnce(new Error("503 upstream overload"))
    vi.mocked(chat).mockRejectedValueOnce(new Error("503 again"))
    vi.mocked(chat).mockResolvedValueOnce({ message: { role: "assistant", content: VALID_VERDICT_JSON } })
    const result = await runShadowSpecialist({
      role: "tests",
      shadowConfig: { primary: "qwen3-coder-next:cloud", retries: 1, fallback: "deepseek-v4-flash:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.modelUsed).toBe("deepseek-v4-flash:cloud")
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(3)
    expect(events.map((e) => e["attemptKind"])).toEqual(["primary", "retry", "fallback"])
    expect(events.map((e) => e["outcome"])).toEqual(["failed", "failed", "ok"])
  })

  it("returns verdictOk=false + failureReason when every attempt fails", async () => {
    vi.mocked(chat).mockRejectedValue(new Error("502 bad gateway"))
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 1, fallback: "glm-5.1:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(result.failureReason).toBeTruthy()
    expect(result.findings).toEqual([])
  })

  it("aborts cleanly when the outer signal is already aborted (no chat calls)", async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 1, fallback: null },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: ac.signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(vi.mocked(chat)).not.toHaveBeenCalled()
  })

  it("returns failureReason='missing_api_key' without calling chat when apiKey is empty", async () => {
    const result = await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 0, fallback: null },
      apiKey: "",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(false)
    expect(result.failureReason).toBe("missing_api_key")
    expect(vi.mocked(chat)).not.toHaveBeenCalled()
  })
})

describe("apples-to-apples format constraint", () => {
  it("passes PR_REVIEW_SCHEMA to chat for specialists + undefined for synth", async () => {
    vi.mocked(chat).mockResolvedValueOnce({ message: { role: "assistant", content: VALID_VERDICT_JSON } })
    await runShadowSpecialist({
      role: "logic",
      shadowConfig: { primary: "deepseek-v4-pro:cloud", retries: 0, fallback: null },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    vi.mocked(chat).mockResolvedValueOnce({ message: { role: "assistant", content: VALID_SYNTH_JSON } })
    await runShadowSynth({
      shadowConfig: { primary: "deepseek-v4-flash:cloud", retries: 0, fallback: null },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    // Specialist call — format must be a non-undefined object (the
    // structured-output schema) so candidate models run with the SAME
    // constraint prod uses.
    const specialistCallArgs = vi.mocked(chat).mock.calls[0]?.[0]
    expect(specialistCallArgs).toBeDefined()
    expect(specialistCallArgs?.format).toBeDefined()
    expect(typeof specialistCallArgs?.format).toBe("object")
    // Synth call — format must be undefined; the synth envelope
    // doesn't match PR_REVIEW_SCHEMA and prod runs synth free-form.
    const synthCallArgs = vi.mocked(chat).mock.calls[1]?.[0]
    expect(synthCallArgs).toBeDefined()
    expect(synthCallArgs?.format).toBeUndefined()
  })
})

describe("runShadowSynth", () => {
  it("returns verdict + findings on synth success", async () => {
    vi.mocked(chat).mockResolvedValueOnce({ message: { role: "assistant", content: VALID_SYNTH_JSON } })
    const result = await runShadowSynth({
      shadowConfig: { primary: "deepseek-v4-flash:cloud", retries: 1, fallback: "qwen3-coder-next:cloud" },
      apiKey: "fake",
      systemPrompt: "sys",
      userMessage: "usr",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx: CTX,
    })
    expect(result.verdictOk).toBe(true)
    expect(result.findings).toHaveLength(1)
    expect(result.modelUsed).toBe("deepseek-v4-flash:cloud")
    const events = shadowAttemptEvents()
    expect(events).toHaveLength(1)
    expect(events[0]?.["role"]).toBe("synth")
  })
})
