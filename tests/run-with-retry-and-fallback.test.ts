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

import { runWithRetryAndFallback } from "../src/lib/triage-pr-review-ensemble"

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
