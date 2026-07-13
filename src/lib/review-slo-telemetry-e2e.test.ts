// SIG-149 — end-to-end coverage for the per-review latency + cost SLO
// roll-up, exercising the REAL production code paths (not the pure
// helpers, which `tests/ensemble-slo-telemetry.test.ts` already pins).
//
// Two seams, both real:
//
//   1. Full `handlePrReviewEnsemble` on a no-fan-out exit (docs-only →
//      empty router). Proves `finalize()` emits exactly one
//      `review-slo-summary` on a path that spends ZERO tokens, with an
//      honest $0 cost + no false breach. This is the orchestrator-
//      boundary integration the repo prefers (see
//      `tests/triage-pr-review-ensemble-router-skip-paths.test.ts`).
//
//   2. Real `runSpecialist` ×4 + `runSynthesizer` with token-bearing
//      `chat()` responses, wiring `perfCtx.recordTokens` exactly as the
//      orchestrator does. Proves the full data path my change added:
//      Ollama `usage` → `onAttempt` → `recordTokens` → accumulator →
//      `computeReviewCost` → `review-slo-summary`. Includes the SIG-212
//      semantics that a parse-FAILED-but-resolved attempt still burned
//      (and must be charged) tokens.
//
// Mock surface mirrors the two sibling harnesses so their module-level
// `vi.mock`s don't have to bleed across files.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetInstallationToken,
  mockChat,
  mockGetPullRequest,
  mockGetPullRequestDiff,
  mockListOpenPullRequests,
  mockGetFileContent,
  mockSubmitReview,
  mockListPullRequestReviews,
  mockCreateIssueComment,
} = vi.hoisted(() => ({
  mockGetInstallationToken: vi.fn(async (_args: unknown) => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockCreateIssueComment: vi.fn(),
}))

vi.mock("@/src/shared/adapters/github/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

// SIG-406: the lineup is all-OpenRouter, so the specialist/synth runners route
// through the barrel `chat` → the OpenRouter adapter. Mock the BARREL `chat`
// (provider-agnostic) so the token-aggregation wiring is exercised regardless of
// the model id.
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

vi.mock("@/src/shared/adapters/github", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/github")>("@/src/shared/adapters/github")
  class GitHubClientMock {
    async getPullRequest(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequest(...args)
    }
    async getPullRequestDiff(...args: unknown[]): Promise<unknown> {
      return mockGetPullRequestDiff(...args)
    }
    async listOpenPullRequests(...args: unknown[]): Promise<unknown> {
      return mockListOpenPullRequests(...args)
    }
    async getFileContent(...args: unknown[]): Promise<unknown> {
      return mockGetFileContent(...args)
    }
    async submitReview(...args: unknown[]): Promise<unknown> {
      return mockSubmitReview(...args)
    }
    async listPullRequestReviews(...args: unknown[]): Promise<unknown> {
      return mockListPullRequestReviews(...args)
    }
    async createIssueComment(...args: unknown[]): Promise<unknown> {
      return mockCreateIssueComment(...args)
    }
  }
  return { ...actual, GitHubClient: GitHubClientMock }
})

import {
  handlePrReviewEnsemble,
  runSpecialist,
  runSynthesizer,
  SPECIALIST_CONFIGS,
  SYNTHESIZER_CONFIG,
} from "@/src/lib/triage-pr-review-ensemble"
import {
  type TokenUsageByModel,
  computeReviewCost,
  makeTokenRecorder,
  pricingForModel,
  SLO_TARGETS,
  DEFAULT_TIER,
} from "@/src/lib/ensemble-slo-telemetry"
import type { EnsembleRunCtx } from "@/src/lib/ensemble-perf-telemetry"
import { ALL_SPECIALISTS } from "@/src/lib/ensemble-router"
import type { Env } from "@/src/shared/types/env"

// ─── shared helpers ─────────────────────────────────────────────────

function makeKvStub(): Env["OPENCLAW_STATE"] {
  const store = new Map<string, string>()
  return {
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
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OPENCLAW_STATE: makeKvStub(),
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
    ...overrides,
  } as unknown as Env
}

/** chat() resolution carrying token usage (the production `done:true`
 *  chunk shape, post-accumulate). */
function okWithUsage(content: string, inputTokens: number, outputTokens: number) {
  return {
    message: { role: "assistant", content },
    hasToolCalls: false,
    usage: { inputTokens, outputTokens },
  }
}

/** chat() resolution with usage but UNPARSEABLE content — the SIG-212
 *  case: the model burned tokens producing output that didn't parse. */
function badParseWithUsage(inputTokens: number, outputTokens: number) {
  return {
    message: { role: "assistant", content: "not json at all" },
    hasToolCalls: false,
    usage: { inputTokens, outputTokens },
  }
}

const verdictJson = (summary: string) => JSON.stringify({ summary, confidence: 3, findings: [] })

const VALID_SYNTH_JSON = JSON.stringify({
  verdict: { summary: "synthesized", confidence: 3, findings: [] },
  provenance: { findings: [], dropped: [] },
})

const PERF_CTX: EnsembleRunCtx = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 149,
  headSha: "a".repeat(40),
}

function collectSloSummaries(logSpy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map((c) => {
      try {
        return JSON.parse(c[0] as string) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null && e["event"] === "review-slo-summary")
}

let logSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockGetInstallationToken.mockClear().mockResolvedValue("test-token")
  mockChat.mockReset()
  mockGetPullRequest.mockReset()
  mockGetPullRequestDiff.mockReset()
  mockListOpenPullRequests.mockReset()
  mockGetFileContent.mockReset()
  mockSubmitReview.mockReset()
  mockListPullRequestReviews.mockReset()
  mockCreateIssueComment.mockReset()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  logSpy.mockRestore()
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"
const BASE_SHA = "basesha000000000000000000000000000000000"

const DOCS_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Sigilix

+New paragraph about the project — prose only, no code fences.
+
 ## Overview
`

// ─── E2E 1: full orchestrator no-fan-out exit ───────────────────────

describe("review-slo-summary — full orchestrator, no-fan-out exit (SIG-149)", () => {
  it("emits exactly one review-slo-summary with $0 cost + no breach when the router dispatches no specialists", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)

    const result = await handlePrReviewEnsemble({
      owner: "Sigilix",
      repo: "sigilix",
      prNumber: 9001,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on" } as unknown as Env),
    })

    // Sanity: this is the no-fan-out skip path (no chat() dispatched).
    expect(result.status).toBe("skipped")
    expect(mockChat).not.toHaveBeenCalled()
    // The orchestrator's accumulator stayed empty → branch-free $0 cost.
    expect(result.telemetry.tokenUsageByModel).toEqual({})

    const summaries = collectSloSummaries(logSpy)
    expect(summaries).toHaveLength(1)
    const ev = summaries[0]!
    expect(ev["owner"]).toBe("Sigilix")
    expect(ev["repo"]).toBe("sigilix")
    expect(ev["prNumber"]).toBe(9001)
    expect(ev["headSha"]).toBe(HEAD_SHA.slice(0, 7))
    expect(ev["tier"]).toBe(DEFAULT_TIER)
    expect(ev["status"]).toBe("skipped")
    expect(ev["totalInputTokens"]).toBe(0)
    expect(ev["totalOutputTokens"]).toBe(0)
    expect(ev["costUsd"]).toBe(0)
    expect(ev["costOverBudget"]).toBe(false)
    expect(ev["sloBreached"]).toBe(false)
    // totalMs is real wall-clock — non-negative number, well under budget.
    expect(typeof ev["totalMs"]).toBe("number")
    expect(ev["totalMs"] as number).toBeGreaterThanOrEqual(0)
    expect(ev["latencyBudgetMs"]).toBe(SLO_TARGETS[DEFAULT_TIER]!.timeToFullReviewMs)
    // SIG-149: no overview is posted on the no-fan-out exit → measured
    // value is null (not 0) and the overview dimension is not a breach.
    expect(ev["timeToFirstOverviewMs"]).toBeNull()
    expect(ev["overviewLatencyOverBudget"]).toBe(false)
  })
})

// ─── E2E 2: real fan-out → token aggregation → cost ─────────────────

describe("review-slo-summary — real specialist fan-out token aggregation (SIG-149)", () => {
  it("accumulates tokens from chat() usage across 4 specialists + synth into the per-review cost", async () => {
    // Wire the accumulator exactly like the orchestrator does.
    const sink: TokenUsageByModel = {}
    const perfCtx: EnsembleRunCtx = { ...PERF_CTX, recordTokens: makeTokenRecorder(sink) }

    // Distinct per-call usage so the totals are unambiguous.
    let expectedInput = 0
    let expectedOutput = 0
    for (let i = 0; i < ALL_SPECIALISTS.length; i++) {
      const inT = 1000 * (i + 1)
      const outT = 100 * (i + 1)
      expectedInput += inT
      expectedOutput += outT
      mockChat.mockResolvedValueOnce(okWithUsage(verdictJson(`role-${i}`), inT, outT))
    }
    for (const role of ALL_SPECIALISTS) {
      const res = await runSpecialist({
        role,
        // logic runs on Ollama Turbo now; the rest on OpenRouter — provide both keys.
        apiKeys: { ollama: "k", openrouter: "k" },
        systemPrompt: "system",
        initialMessage: "user",
        chatEnabled: "on",
        signal: new AbortController().signal,
        perfCtx,
      })
      expect(res.verdict).not.toBeNull()
    }
    // Synth call with its own usage.
    const synthIn = 5000
    const synthOut = 800
    expectedInput += synthIn
    expectedOutput += synthOut
    mockChat.mockResolvedValueOnce(okWithUsage(VALID_SYNTH_JSON, synthIn, synthOut))
    const synthRes = await runSynthesizer({
      apiKey: "k",
      systemPrompt: "system",
      userMessage: "user",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
    })
    expect(synthRes.verdict).not.toBeNull()

    // The accumulator captured every model attempt's tokens.
    const cost = computeReviewCost(sink)
    expect(cost.totalInputTokens).toBe(expectedInput)
    expect(cost.totalOutputTokens).toBe(expectedOutput)
    expect(cost.totalUsd).toBeGreaterThan(0)

    // Tokens are keyed by the model that actually answered (config
    // primaries on the happy path), so every dispatched model appears.
    const expectedModels = new Set<string>([
      ...ALL_SPECIALISTS.map((r) => SPECIALIST_CONFIGS[r].primary),
      SYNTHESIZER_CONFIG.primary,
    ])
    for (const m of expectedModels) {
      expect(sink[m], `expected tokens recorded for model ${m}`).toBeDefined()
    }
  })

  it("charges EACH parse-FAILED attempt's tokens even when the run then fails (SIG-212 + SIG-438)", async () => {
    // SIG-438: a parse-fail RETRIES the same model (it's non-deterministic, a re-roll
    // often parses). SIG-449/SIG-468: security = { primary: "deepseek/deepseek-v4-flash",
    // retries: 2, fallback: "deepseek/deepseek-v4-pro" } → 3 primary attempts + 1 fallback.
    // Here ALL FOUR parse-fail → the run still fails. Each attempt BURNED tokens producing
    // the unparseable output, so ALL must be charged (the SIG-212 invariant: settled attempts
    // cost money even when the verdict fails), keyed by the model that ran them.
    const sink: TokenUsageByModel = {}
    const perfCtx: EnsembleRunCtx = { ...PERF_CTX, recordTokens: makeTokenRecorder(sink) }

    const primaryModel = SPECIALIST_CONFIGS.security.primary
    const fallbackModel = SPECIALIST_CONFIGS.security.fallback!

    mockChat
      .mockResolvedValueOnce(badParseWithUsage(2000, 50)) // attempt 1 (primary):  parse-fail
      .mockResolvedValueOnce(badParseWithUsage(2000, 50)) // attempt 2 (retry 1):  parse-fail
      .mockResolvedValueOnce(badParseWithUsage(2000, 50)) // attempt 3 (retry 2):  parse-fail
      .mockResolvedValueOnce(badParseWithUsage(2000, 50)) // attempt 4 (fallback): parse-fail

    const res = await runSpecialist({
      role: "security",
      apiKeys: { ollama: undefined, openrouter: "k" },
      systemPrompt: "system",
      initialMessage: "user",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
    })
    // All four attempts (primary ×3 + fallback) parse-failed → the run fails.
    expect(res.verdict).toBeNull()
    expect(SPECIALIST_CONFIGS.security.fallback).toBe("deepseek/deepseek-v4-pro")
    // Four chat calls: a parse-fail retries the same model (SIG-438), security allows two
    // retries (SIG-449) = 3 primary attempts, then the SIG-468 fallback adds one more.
    expect(mockChat).toHaveBeenCalledTimes(4)

    // The THREE primary failed attempts' tokens are charged, keyed by the primary model.
    // SIG-417: this mock reports no `usage.cost`, so the tokens land in the `unpriced*`
    // buckets too (priced via MODEL_PRICING, not dropped).
    expect(sink[primaryModel]).toEqual({
      inputTokens: 6000,
      outputTokens: 150,
      unpricedInputTokens: 6000,
      unpricedOutputTokens: 150,
    })
    // The fallback attempt's tokens are charged separately, keyed by the fallback model.
    expect(sink[fallbackModel]).toEqual({
      inputTokens: 2000,
      outputTokens: 50,
      unpricedInputTokens: 2000,
      unpricedOutputTokens: 50,
    })

    // Cost = every failed attempt's spend, priced per the model that ran it (no silent drop).
    const cost = computeReviewCost(sink)
    const expectedUsd =
      (6000 / 1_000_000) * pricingForModel(primaryModel).inputPerMTokUsd +
      (150 / 1_000_000) * pricingForModel(primaryModel).outputPerMTokUsd +
      (2000 / 1_000_000) * pricingForModel(fallbackModel).inputPerMTokUsd +
      (50 / 1_000_000) * pricingForModel(fallbackModel).outputPerMTokUsd
    expect(cost.totalUsd).toBeCloseTo(expectedUsd, 9)
  })

  it("records nothing when chat() throws (HTTP/timeout) — no usage, no phantom cost", async () => {
    // SIG-212: usage is absent on the exception path (no tokens exchanged). logic =
    // retries:2 + a cross-provider fallback (2026-07-13), so BOTH keys are present and
    // mockChat rejects EVERY call — the primary (Ollama) attempts AND the OpenRouter
    // fallback leg all exhaust, degrading recall-safe (verdict null) with zero recorded spend.
    const sink: TokenUsageByModel = {}
    const perfCtx: EnsembleRunCtx = { ...PERF_CTX, recordTokens: makeTokenRecorder(sink) }

    mockChat.mockRejectedValue(new Error("HTTP 503: overloaded"))
    const res = await runSpecialist({
      role: "logic",
      apiKeys: { ollama: "k", openrouter: "k" },
      systemPrompt: "system",
      initialMessage: "user",
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
    })
    expect(res.verdict).toBeNull()
    expect(sink).toEqual({})
    expect(computeReviewCost(sink).totalUsd).toBe(0)
  })
})
