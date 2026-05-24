// Phase 4a runWithRetryAndFallback tests (arc PR #37 catch).
//
// The retry-and-fallback wrapper is the core new addition in PR #37.
// Without direct test coverage, the most important branches (cross-
// provider fallback after primary fails, permanent-failure-still-tries-
// fallback, retry-on-transient) only get exercised in production,
// where regressions = silent ensemble degradation.
//
// Kept in its own file so module-level vi.mock for `./ollama-chat`
// doesn't bleed into the pure-helper tests in
// triage-pr-review-ensemble.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
vi.mock("../src/lib/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ollama-chat")>(
    "../src/lib/ollama-chat",
  )
  return {
    ...actual,
    chat: (args: unknown) => mockChat(args),
  }
})

import {
  runWithRetryAndFallback,
  runSpecialist,
  runSynthesizer,
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
  type AttemptCallbackInfo,
} from "../src/lib/triage-pr-review-ensemble"
import { parsePrReviewResponse } from "../src/lib/triage-pr-review"
import { ALL_SPECIALISTS } from "../src/lib/ensemble-router"

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  // mockReset wipes implementation; runs before next test sets it up again.
})

const PARSE_LABEL = "test_parse_failure"

/**
 * Trivial parser that recognizes JSON-like input as a "valid verdict"
 * by returning the parsed object, and returns null for everything else.
 */
function parseStub(content: string): { ok: true } | null {
  return content === "GOOD" ? { ok: true } : null
}

const baseConfig = {
  primary: "primary-model:cloud",
  retries: 2,
  fallback: "fallback-model:cloud",
}

const baseArgs = {
  apiKey: "test-key",
  messages: [{ role: "user" as const, content: "test" }],
  signal: new AbortController().signal,
  chatEnabled: "on" as const,
  format: undefined,
  parseAnswer: parseStub,
  parseFailureLabel: PARSE_LABEL,
  startedAt: 0,
}

// Helper to make a chat() resolution with a given content.
const ok = (content: string) => ({ message: { role: "assistant", content }, hasToolCalls: false })

describe("runWithRetryAndFallback — happy path", () => {
  it("returns primary's verdict immediately when first attempt succeeds", async () => {
    mockChat.mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("primary-model:cloud")
    expect(result.attemptsUsed).toBe(1)
    expect(mockChat).toHaveBeenCalledOnce()
  })
})

describe("runWithRetryAndFallback — transient failures retry then succeed", () => {
  it("retries primary on 503 and returns when retry succeeds", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("Ollama HTTP 503: server overloaded"))
      .mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("primary-model:cloud")
    expect(result.attemptsUsed).toBe(2)
  })

  it("respects the retry count — stops after retries+1 attempts on transient", async () => {
    mockChat.mockRejectedValue(new Error("Ollama HTTP 503: overloaded"))
    const result = await runWithRetryAndFallback({
      config: { primary: "p", retries: 2, fallback: null },
      ...baseArgs,
    })
    // Primary attempts: 1 + retries(2) = 3, no fallback configured
    expect(result.verdict).toBeNull()
    expect(result.attemptsUsed).toBe(3)
  })

  it("falls through to fallback after primary retries exhausted", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("Ollama HTTP 503: overloaded"))  // primary attempt 1
      .mockRejectedValueOnce(new Error("Ollama HTTP 503: overloaded"))  // primary attempt 2
      .mockRejectedValueOnce(new Error("Ollama HTTP 503: overloaded"))  // primary attempt 3
      .mockResolvedValueOnce(ok("GOOD"))                                 // fallback succeeds
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("fallback-model:cloud")
    // 3 primary attempts (1 + retries=2) + 1 fallback = 4
    expect(result.attemptsUsed).toBe(4)
  })
})

describe("runWithRetryAndFallback — permanent failures (arc PR #37 catch)", () => {
  it("HTTP 404 on primary skips retries but STILL tries cross-provider fallback", async () => {
    // The arc PR #37 catch: a 404 on deepseek-v4-pro says nothing
    // about whether kimi-k2.5 exists — fallback is on a different
    // provider entirely. Skip retries (same primary = same 404), but
    // still try fallback.
    mockChat
      .mockRejectedValueOnce(new Error("Ollama HTTP 404: model not found"))
      .mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("fallback-model:cloud")
    expect(result.attemptsUsed).toBe(2)  // 1 primary + 1 fallback (no retries on permanent)
  })

  it("HTTP 401 auth error skips retries but tries fallback", async () => {
    mockChat
      .mockRejectedValueOnce(new Error("Ollama HTTP 401: unauthorized"))
      .mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("fallback-model:cloud")
    expect(result.attemptsUsed).toBe(2)
  })

  it("parse failure on primary skips retries but tries fallback", async () => {
    // Parse failure = same prompt at temp=0 → same bad output. No
    // retry. But a different model (fallback) may format output
    // correctly — try once before giving up.
    mockChat
      .mockResolvedValueOnce(ok("not-json"))     // primary returns unparseable
      .mockResolvedValueOnce(ok("GOOD"))         // fallback parses
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("fallback-model:cloud")
    expect(result.attemptsUsed).toBe(2)
  })
})

describe("runWithRetryAndFallback — total failure", () => {
  it("returns failure when both primary AND fallback fail", async () => {
    mockChat.mockRejectedValue(new Error("Ollama HTTP 503: overloaded"))
    const result = await runWithRetryAndFallback({ config: baseConfig, ...baseArgs })
    expect(result.verdict).toBeNull()
    expect(result.failureReason).toContain("fallback_failed")
    expect(result.attemptsUsed).toBe(4)  // 3 primary + 1 fallback
    expect(result.modelUsed).toBe("fallback-model:cloud")
  })

  it("returns last-failure reason when no fallback configured", async () => {
    mockChat.mockRejectedValue(new Error("Ollama HTTP 503: overloaded"))
    const result = await runWithRetryAndFallback({
      config: { primary: "p", retries: 1, fallback: null },
      ...baseArgs,
    })
    expect(result.verdict).toBeNull()
    expect(result.failureReason).toContain("503")
    expect(result.modelUsed).toBe("p")
  })
})

describe("runWithRetryAndFallback — abort handling", () => {
  it("returns aborted immediately when signal already aborted on entry", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await runWithRetryAndFallback({
      config: baseConfig,
      ...baseArgs,
      signal: ctrl.signal,
    })
    expect(result.verdict).toBeNull()
    expect(result.failureReason).toBe("aborted")
    expect(result.attemptsUsed).toBe(0)  // no chat calls ever fired
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("doesn't try fallback after signal aborts mid-retry", async () => {
    const ctrl = new AbortController()
    mockChat.mockImplementationOnce(async () => {
      // Abort during primary's 1st attempt
      ctrl.abort()
      throw new Error("Ollama HTTP 503: overloaded")
    })
    const result = await runWithRetryAndFallback({
      config: baseConfig,
      ...baseArgs,
      signal: ctrl.signal,
    })
    expect(result.verdict).toBeNull()
    // Should have gone through aborted check before retrying or falling back
    expect(mockChat).toHaveBeenCalledTimes(1)
  })
})

// ─── Phase 4a.4: per-attempt timeout cap (ARC-175) ──────────────────────────

describe("runWithRetryAndFallback — per-attempt timeout cap", () => {
  /**
   * Simulate a slow `chat()` that respects the abort signal: resolves
   * the value AFTER `delay` ms, but if the signal aborts first, throws
   * an AbortError synchronously. Mirrors the real ollama-chat behavior
   * where fetch() honors AbortSignal.
   */
  const slowChat = (delay: number, value: ReturnType<typeof ok>) =>
    (args: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(value), delay)
      if (args.signal) {
        args.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t)
            reject(new DOMException("The operation was aborted", "AbortError"))
          },
          { once: true },
        )
      }
    })

  it("aborts a slow primary attempt at perAttemptTimeoutMs and runs the retry", async () => {
    // Primary attempt 1 takes 200ms, cap is 50ms → aborted before completing.
    // Primary attempt 2 succeeds immediately with GOOD.
    mockChat
      .mockImplementationOnce(slowChat(200, ok("late-primary-1")))
      .mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({
      config: { primary: "p", retries: 2, fallback: null },
      ...baseArgs,
      perAttemptTimeoutMs: 50,
    })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.attemptsUsed).toBe(2)
    expect(result.modelUsed).toBe("p")
  })

  it("falls back to cross-provider when ALL primary attempts hit the per-attempt cap", async () => {
    // 1 primary + 1 retry both stall past the cap, fallback succeeds quickly.
    mockChat
      .mockImplementationOnce(slowChat(200, ok("late-primary-1")))
      .mockImplementationOnce(slowChat(200, ok("late-primary-2")))
      .mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({
      config: { primary: "primary-model:cloud", retries: 1, fallback: "fallback-model:cloud" },
      ...baseArgs,
      perAttemptTimeoutMs: 50,
    })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.modelUsed).toBe("fallback-model:cloud")
    // 1 primary + 1 retry + 1 fallback = 3
    expect(result.attemptsUsed).toBe(3)
  })

  it("returns total failure when fallback ALSO exceeds the per-attempt cap", async () => {
    // Every attempt slow → all aborted → fallback's failure reason wins.
    mockChat.mockImplementation(slowChat(200, ok("never-arrives")))
    const result = await runWithRetryAndFallback({
      config: { primary: "primary-model:cloud", retries: 1, fallback: "fallback-model:cloud" },
      ...baseArgs,
      perAttemptTimeoutMs: 50,
    })
    expect(result.verdict).toBeNull()
    expect(result.failureReason).toContain("fallback_failed")
    expect(result.failureReason?.toLowerCase()).toContain("abort")
    expect(result.attemptsUsed).toBe(3)
    expect(result.modelUsed).toBe("fallback-model:cloud")
  })

  it("does not interfere with a fast attempt that finishes well under the cap", async () => {
    // Per-attempt cap is wide (10s); attempt resolves in microseconds.
    mockChat.mockResolvedValueOnce(ok("GOOD"))
    const result = await runWithRetryAndFallback({
      config: baseConfig,
      ...baseArgs,
      perAttemptTimeoutMs: 10_000,
    })
    expect(result.verdict).toEqual({ ok: true })
    expect(result.attemptsUsed).toBe(1)
  })
})

describe("runWithRetryAndFallback — Phase 4a.4 budget invariant", () => {
  it("specialist budget accommodates 2 primary + 1 fallback at the per-attempt cap", async () => {
    // The whole point of Phase 4a.4: per-attempt cap × attempt count
    // (primary retries+1 + fallback) must fit under SPECIALIST_TIMEOUT_MS
    // with retry-backoff slack. Lock the math here so a future
    // "tighten cap to N" change can't silently re-break the fallback
    // having time to fire.
    const { SPECIALIST_TIMEOUT_MS, PER_ATTEMPT_TIMEOUT_MS } =
      await import("../src/lib/triage-pr-review-ensemble")
    // Worst case: retries=1 means 2 primary attempts + 1 fallback = 3
    // attempts at the cap, plus ~1s retry backoff. Must fit in the
    // specialist budget.
    const retryBackoffMs = 1_000
    const worstCase = 2 * PER_ATTEMPT_TIMEOUT_MS + retryBackoffMs + PER_ATTEMPT_TIMEOUT_MS
    expect(worstCase).toBeLessThanOrEqual(SPECIALIST_TIMEOUT_MS)
  })
})

// ─── ARC-283 Phase B1b: onAttempt callback ──────────────────────────

// Minimal PR-review verdict the production `parsePrReviewResponse`
// accepts. Used by the onAttempt tests so the parser path mirrors
// the real specialist runner instead of the parseStub above.
const VALID_VERDICT_JSON = JSON.stringify({
  summary: "looks fine",
  confidence: 3,
  findings: [],
})

describe("runWithRetryAndFallback onAttempt callback (ARC-283 B1b)", () => {
  it("invokes onAttempt once per attempted call with verdictOk + failureReason + timing", async () => {
    // Primary 503 → fallback parses → 2 emits expected (primary
    // failure first, fallback success second).
    mockChat
      .mockRejectedValueOnce(new Error("Ollama HTTP 503: overloaded"))
      .mockResolvedValueOnce(ok(VALID_VERDICT_JSON))
    const attempts: AttemptCallbackInfo[] = []
    const result = await runWithRetryAndFallback({
      config: { primary: "p:cloud", retries: 0, fallback: "f:cloud" },
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      chatEnabled: "on",
      format: undefined,
      parseAnswer: parsePrReviewResponse,
      parseFailureLabel: "did_not_parse",
      startedAt: Date.now(),
      onAttempt: (info) => { attempts.push(info) },
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.model).toBe("p:cloud")
    expect(attempts[0]?.verdictOk).toBe(false)
    expect(attempts[0]?.failureReason).toBeTruthy()
    expect(attempts[0]?.attemptIndex).toBe(1)
    expect(attempts[1]?.model).toBe("f:cloud")
    expect(attempts[1]?.verdictOk).toBe(true)
    expect(attempts[1]?.attemptIndex).toBe(2)
    expect(attempts[1]?.failureReason).toBeUndefined()
    // Timing sanity — endedAtMs >= startedAtMs on both.
    expect(attempts[0]?.endedAtMs).toBeGreaterThanOrEqual(attempts[0]?.startedAtMs ?? 0)
    expect(attempts[1]?.endedAtMs).toBeGreaterThanOrEqual(attempts[1]?.startedAtMs ?? 0)
    expect(result.verdict).not.toBeNull()
  })

  it("does not invoke onAttempt when signal is already aborted (no attempt happened)", async () => {
    const ac = new AbortController()
    ac.abort()
    const attempts: AttemptCallbackInfo[] = []
    const result = await runWithRetryAndFallback({
      config: { primary: "p:cloud", retries: 0, fallback: null },
      apiKey: "k",
      messages: [{ role: "user", content: "hi" }],
      signal: ac.signal,
      chatEnabled: "on",
      format: undefined,
      parseAnswer: parsePrReviewResponse,
      parseFailureLabel: "did_not_parse",
      startedAt: Date.now(),
      onAttempt: (info) => { attempts.push(info) },
    })
    expect(attempts).toHaveLength(0)
    expect(result.verdict).toBeNull()
  })
})

// ─── ARC-283 Phase B1b: model-attempt-completed prod-path wire-up ──

describe("model-attempt-completed prod-path wire-up (ARC-283 B1b)", () => {
  // Synthesizer requires both `verdict` AND `provenance` per
  // `parseSynthAnswer` + `isValidProvenance`. Minimal valid shape.
  const VALID_SYNTH_JSON = JSON.stringify({
    verdict: { summary: "synthesized", confidence: 3, findings: [] },
    provenance: { findings: [], dropped: [] },
  })
  const perfCtx = {
    owner: "Arc-and-Anchor",
    repo: "sigilix",
    prNumber: 1,
    headSha: "a".repeat(40),
  }

  it("emits exactly 5 model-attempt-completed events on the happy path (4 specialists + 1 synth)", async () => {
    // Five sequential happy-path calls: one per specialist role plus
    // one synth call. Pinning EXACTLY 5 (not ≥5) catches accidental
    // double-emits or stray ARC-278 retry firings on a path that
    // shouldn't trigger them.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      // 4 specialists' happy paths.
      for (const role of ALL_SPECIALISTS) {
        mockChat.mockResolvedValueOnce(ok(JSON.stringify({
          summary: `verdict from ${role}`,
          confidence: 3,
          findings: [],
        })))
        const result = await runSpecialist({
          role,
          apiKey: "test-key",
          systemPrompt: "system",
          initialMessage: "user",
          chatEnabled: "on",
          signal: new AbortController().signal,
          perfCtx,
        })
        expect(result.verdict).not.toBeNull()
      }
      // 1 synthesizer happy path.
      mockChat.mockResolvedValueOnce(ok(VALID_SYNTH_JSON))
      const synthResult = await runSynthesizer({
        apiKey: "test-key",
        systemPrompt: "system",
        userMessage: "user",
        chatEnabled: "on",
        signal: new AbortController().signal,
        perfCtx,
      })
      expect(synthResult.verdict).not.toBeNull()

      const events = logSpy.mock.calls
        .map((c) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown> }
          catch { return null }
        })
        .filter((e): e is Record<string, unknown> => e !== null && e["event"] === "model-attempt-completed")
      // 4 specialists + 1 synth = exactly 5 attempts on the happy path.
      expect(events.length).toBe(5)
      // Per-role: each specialist must have a primary/index=1/ok event
      // pinned to its declared primary model in SPECIALIST_CONFIGS.
      for (const role of ALL_SPECIALISTS) {
        const event = events.find(
          (e) => e["phase"] === "specialist" && e["role"] === role,
        )
        expect(event, `missing specialist event for role=${role}`).toBeDefined()
        expect(event?.["attemptKind"]).toBe("primary")
        expect(event?.["attemptIndex"]).toBe(1)
        expect(event?.["outcome"]).toBe("ok")
        expect(event?.["model"]).toBe(SPECIALIST_CONFIGS[role].primary)
      }
      // Synth: exactly one primary/index=1/ok event pinned to
      // SYNTHESIZER_CONFIG.primary.
      const synthEvents = events.filter((e) => e["phase"] === "synth")
      expect(synthEvents).toHaveLength(1)
      expect(synthEvents[0]?.["role"]).toBe("synth")
      expect(synthEvents[0]?.["attemptKind"]).toBe("primary")
      expect(synthEvents[0]?.["attemptIndex"]).toBe(1)
      expect(synthEvents[0]?.["outcome"]).toBe("ok")
      expect(synthEvents[0]?.["model"]).toBe(SYNTHESIZER_CONFIG.primary)
    } finally {
      logSpy.mockRestore()
    }
  })

  it("emits primary/retry/fallback sequence on logic specialist when primary + retry both 503", async () => {
    // SPECIALIST_CONFIGS.logic = { primary: "deepseek-v4-pro:cloud",
    // retries: 1, fallback: "kimi-k2.5:cloud" } — three mocked chat
    // calls (primary 503, retry 503, fallback OK) → three emits:
    // primary/failed, retry/failed, fallback/ok. Pins both the
    // attemptKind sequence AND the model identity per attempt
    // (retry stays on primary model; fallback swaps).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    try {
      mockChat
        .mockRejectedValueOnce(new Error("Ollama HTTP 503: upstream overload"))
        .mockRejectedValueOnce(new Error("Ollama HTTP 503: upstream overload"))
        .mockResolvedValueOnce(ok(JSON.stringify({
          summary: "logic verdict",
          confidence: 3,
          findings: [],
        })))
      const result = await runSpecialist({
        role: "logic",
        apiKey: "test-key",
        systemPrompt: "system",
        initialMessage: "user",
        chatEnabled: "on",
        signal: new AbortController().signal,
        perfCtx,
      })
      expect(result.verdict).not.toBeNull()
      expect(result.modelUsed).toBe(SPECIALIST_CONFIGS.logic.fallback)

      const events = logSpy.mock.calls
        .map((c) => {
          try { return JSON.parse(c[0] as string) as Record<string, unknown> }
          catch { return null }
        })
        .filter((e): e is Record<string, unknown> =>
          e !== null
          && e["event"] === "model-attempt-completed"
          && e["role"] === "logic",
        )
      expect(events).toHaveLength(3)
      expect(events[0]?.["attemptKind"]).toBe("primary")
      expect(events[0]?.["outcome"]).toBe("failed")
      expect(events[0]?.["model"]).toBe(SPECIALIST_CONFIGS.logic.primary)
      expect(events[1]?.["attemptKind"]).toBe("retry")
      expect(events[1]?.["outcome"]).toBe("failed")
      expect(events[1]?.["model"]).toBe(SPECIALIST_CONFIGS.logic.primary)
      expect(events[2]?.["attemptKind"]).toBe("fallback")
      expect(events[2]?.["outcome"]).toBe("ok")
      expect(events[2]?.["model"]).toBe(SPECIALIST_CONFIGS.logic.fallback)
    } finally {
      logSpy.mockRestore()
    }
  })
})
