// SIG-226 / SIG-224 Phase 1 — orchestrator-boundary integration test
// for the shadow-mode dynamic dispatcher wire-in in
// `triage-pr-review-ensemble.ts`.
//
// Invariants pinned by this file (so a future refactor can't silently
// drop the shadow telemetry or accidentally enforce dispatcher picks
// before SIG-227/228 graduate):
//
//   1. `OPENCLAW_DYNAMIC_DISPATCHER_MODE=shadow` triggers a
//      `dispatcher-shadow-decision` console.log emission containing
//      both the router's picks (legacy fan-out) and the dispatcher's
//      would-be picks.
//   2. The dispatcher's `deepseek-v4-flash:cloud` chat() call fires
//      via the same `chat()` import used by specialists.
//   3. The legacy `router.specialists` is what drives the actual fan-
//      out — shadow mode never changes runtime behavior even when
//      the dispatcher picks a different subset.
//   4. With mode=off (default), no dispatcher telemetry fires and no
//      LLM call is made for dispatching.
//
// Unit tests of `decideSpecialistsDynamic` (rule layer, LLM fail-
// closed semantics, reconcile under consensus-to-skip) live in
// `tests/dynamic-dispatcher.test.ts`.

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
  mockGetInstallationToken: vi.fn(async () => "test-token"),
  mockChat: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestDiff: vi.fn(),
  mockListOpenPullRequests: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockSubmitReview: vi.fn(),
  mockListPullRequestReviews: vi.fn(),
  mockCreateIssueComment: vi.fn(),
}))

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ollama-chat")>("../src/lib/ollama-chat")
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
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

import { handlePrReviewEnsemble } from "../src/lib/triage-pr-review-ensemble"
import type { Env } from "../src/shared/types/env"

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
    OLLAMA_API_KEY: "fake-key",
    OLLAMA_CHAT_ENABLE: "on",
    ...overrides,
  } as unknown as Env
}

const HEAD_SHA = "deadbeef1234567890abcdef1234567890abcdef"
const BASE_SHA = "basesha000000000000000000000000000000000"

const SIMPLE_SOURCE_DIFF = `diff --git a/src/lib/foo.ts b/src/lib/foo.ts
index abc1234..def5678 100644
--- a/src/lib/foo.ts
+++ b/src/lib/foo.ts
@@ -1,3 +1,5 @@
 export function foo() {
+  // tweak
+  return 1
   return 0
 }
`

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

function isDispatcherCall(arg: unknown): boolean {
  if (!arg || typeof arg !== "object") return false
  const messages = (arg as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return false
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const content = (m as { content?: unknown }).content
    if (typeof content === "string" && content.includes("specialist-dispatcher")) {
      return true
    }
  }
  return false
}

/** Which specialist a mocked chat() call is for (by its system-prompt marker),
 *  or null for the dispatcher classifier / unknown. Used to assert the REAL
 *  fan-out, not just telemetry (CodeRabbit #325). */
function callRole(arg: unknown): string | null {
  if (!arg || typeof arg !== "object") return null
  const messages = (arg as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return null
  const text = messages
    .map((m) => (m && typeof m === "object" ? String((m as { content?: unknown }).content ?? "") : ""))
    .join("\n")
  if (/\*\*SECURITY specialist\*\*/.test(text)) return "security"
  if (/\*\*LOGIC specialist\*\*/.test(text)) return "logic"
  if (/\*\*TESTS specialist\*\*/.test(text)) return "tests"
  if (/\*\*PERFORMANCE specialist\*\*/.test(text)) return "performance"
  return null
}

function findLoggedEvent(eventName: string): Record<string, unknown> | undefined {
  for (const call of logSpy.mock.calls) {
    const arg = call[0]
    if (typeof arg !== "string") continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(arg) as Record<string, unknown>
    } catch {
      continue
    }
    if (parsed.event === eventName) return parsed
  }
  return undefined
}

describe("handlePrReviewEnsemble — dispatcher shadow mode (SIG-226)", () => {
  it("emits dispatcher-shadow-decision when mode=shadow + lets the dispatcher LLM fire", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
      title: "chore: minor tweak",
      body: "small change",
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SIMPLE_SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null) // sigilix.json absent → EMPTY_CONFIG

    // First chat() call should be the dispatcher's LLM classifier.
    // We resolve it with a valid JSON; subsequent specialist
    // dispatch chat() calls reject so the orchestrator exits the
    // pipeline (we don't care about the downstream behavior here).
    mockChat
      .mockImplementationOnce(async () => ({
        message: {
          role: "assistant",
          content: JSON.stringify({
            specialists: ["tests"],
            reasoning: "test coverage matters most for this small tweak",
            confidence: 4,
          }),
        },
        hasToolCalls: false,
      }))
      .mockRejectedValue(new Error("test boundary — specialist chat not mocked further"))

    await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 5001,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_DYNAMIC_DISPATCHER_MODE: "shadow" } as unknown as Env),
    })

    const event = findLoggedEvent("dispatcher-shadow-decision")
    expect(event).toBeDefined()
    expect(event?.mode).toBe("shadow")
    // Router (legacy, flag off) returns ALL_SPECIALISTS.
    expect((event?.routerSpecialists as string[]).sort()).toEqual(
      ["logic", "performance", "security", "tests"]
    )
    // Dispatcher computed picks: tests (LLM) + logic + security
    // (protected, consensus-to-skip default). Perf skipped.
    expect((event?.dispatcherSpecialists as string[]).sort()).toEqual(
      ["logic", "security", "tests"]
    )
    expect(event?.perRole).toBeDefined()
    expect(event?.layerVotes).toBeDefined()
    expect((event?.layerVotes as Record<string, unknown>).llmOutcome).toBe("ok")

    // Dispatcher chat() should have used the in-fleet flash model.
    // CodeRabbit nit fix: locate the call by content (not by index)
    // so unrelated orchestration changes that add chat() calls
    // before the dispatcher don't break this assertion. The
    // dispatcher's system prompt has the unique
    // "specialist-dispatcher" identifier; the tests specialist
    // (which also uses `deepseek-v4-flash:cloud`) does not.
    const dispatcherCall = mockChat.mock.calls.find((call) => isDispatcherCall(call[0]))
    expect(dispatcherCall).toBeDefined()
    const arg = dispatcherCall?.[0] as { model: string } | undefined
    expect(arg?.model).toBe("deepseek-v4-flash:cloud")
  })

  it("does NOT emit dispatcher telemetry when mode is off/absent", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
      title: "chore: minor tweak",
      body: "",
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SIMPLE_SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)
    // Specialist chat() fails — we only care about whether dispatcher
    // telemetry fires (it should NOT, mode is off by absence).
    mockChat.mockRejectedValue(new Error("test boundary"))

    await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 5002,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv(), // OPENCLAW_DYNAMIC_DISPATCHER_MODE not set
    })

    expect(findLoggedEvent("dispatcher-shadow-decision")).toBeUndefined()
    // CodeRabbit minor fix: also assert the dispatcher's LLM was
    // never invoked, so a future change that accidentally fires the
    // dispatcher when mode is off can't pass this test silently.
    // The dispatcher's system prompt has a unique
    // "specialist-dispatcher" identifier — the tests specialist
    // shares `deepseek-v4-flash:cloud` so model name alone is not a
    // valid discriminator.
    const dispatcherCalls = mockChat.mock.calls.filter((call) => isDispatcherCall(call[0]))
    expect(dispatcherCalls).toHaveLength(0)
  })

  it("SIG-232 / enforce_rules mode replaces router.specialists with dispatcher picks + preserves legacyRouterDecision", async () => {
    // PR #185 bot finding: the enforce_rules wire-in
    // (`triage-pr-review-ensemble.ts:1595` block) and the
    // `legacyRouterDecision` telemetry preservation lacked
    // orchestrator-boundary coverage. This test pins:
    //   1. mode=enforce_rules emits the `dispatcher-shadow-decision`
    //      event (shared with shadow mode).
    //   2. NO LLM call (rules-only path; dispatcher's flash model is
    //      never invoked).
    //   3. `telemetry.routerDecision` is overwritten with the
    //      dispatcher's picks (drives downstream fan-out).
    //   4. `telemetry.legacyRouterDecision` preserves the legacy
    //      `decideSpecialists` result for /metrics/validation delta
    //      computation.
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
      title: "docs: tweak",
      body: "",
    })
    // Docs-only-no-fences → rule layer safe-skips all 4 → dispatcher
    // picks = [].
    const DOCS_ONLY_DIFF = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 # Sigilix
+New plain prose line.
`
    mockGetPullRequestDiff.mockResolvedValueOnce(DOCS_ONLY_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)
    // Specialist chat() will reject if called — proves no fan-out
    // actually starts on the empty-router path.
    mockChat.mockRejectedValue(new Error("test boundary"))

    await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 5004,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_DYNAMIC_DISPATCHER_MODE: "enforce_rules" } as unknown as Env),
    })

    const event = findLoggedEvent("dispatcher-shadow-decision")
    expect(event).toBeDefined()
    expect(event?.mode).toBe("enforce_rules")
    // Dispatcher's rule-layer decided: docs-only-no-fences → no
    // specialists. Both router.specialists (overwritten) AND
    // dispatcherSpecialists in telemetry are empty.
    expect((event?.dispatcherSpecialists as string[])).toEqual([])
    // Rule-layer-only path — dispatcher never invoked the LLM.
    expect((event?.layerVotes as Record<string, unknown>).llmOutcome).toBe(
      "skipped_rules_only_mode",
    )
    // No call with the dispatcher's `specialist-dispatcher` system
    // prompt fired (rules-only mode skips the LLM entirely).
    const dispatcherCalls = mockChat.mock.calls.filter((call) =>
      isDispatcherCall(call[0]),
    )
    expect(dispatcherCalls).toHaveLength(0)
  })

  it("SIG-227b / enforce mode APPLIES the LLM-decided fan-out — protects security+logic, skips the tests/perf the LLM omits", async () => {
    mockGetPullRequest.mockResolvedValueOnce({
      head: { sha: HEAD_SHA },
      base: { sha: BASE_SHA },
      merged_at: null,
      labels: [],
      title: "chore: minor",
      body: "",
    })
    mockGetPullRequestDiff.mockResolvedValueOnce(SIMPLE_SOURCE_DIFF)
    mockListOpenPullRequests.mockResolvedValueOnce([])
    mockGetFileContent.mockResolvedValueOnce(null)
    // The dispatcher LLM picks NO ambiguous roles — i.e. judges tests +
    // performance have no surface on this diff. The first chat() is the
    // dispatcher classifier; the specialist fan-out that follows would hit the
    // rejecting mock (proving security/logic still run but tests/perf don't).
    mockChat
      .mockImplementationOnce(async () => ({
        message: {
          role: "assistant",
          content: JSON.stringify({ specialists: [], reasoning: "no test/perf surface", confidence: 4 }),
        },
        hasToolCalls: false,
      }))
      .mockRejectedValue(new Error("test boundary"))

    await handlePrReviewEnsemble({
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 5003,
      headSha: HEAD_SHA,
      installationId: 1,
      env: makeEnv({ OPENCLAW_DYNAMIC_DISPATCHER_MODE: "enforce" } as unknown as Env),
    })

    const decision = findLoggedEvent("dispatcher-shadow-decision")
    expect(decision).toBeDefined()
    expect(decision?.mode).toBe("enforce")
    const dispatched = decision?.dispatcherSpecialists as string[]
    // RECALL-SAFE: the protected roles always run...
    expect(dispatched).toContain("security")
    expect(dispatched).toContain("logic")
    // ...and the LLM-omitted non-protected roles are skipped.
    expect(dispatched).not.toContain("tests")
    expect(dispatched).not.toContain("performance")

    // enforce is now HONORED: the applied event fires with the same set, and
    // the old "not honored in Phase 1" warning is gone.
    const applied = findLoggedEvent("dispatcher-enforce-applied")
    expect(applied).toBeDefined()
    expect(applied?.enforcedSpecialists).toEqual(dispatched)
    const notHonored = warnSpy.mock.calls.find((c) => {
      const a = c[0]
      if (typeof a !== "string") return false
      try {
        return (JSON.parse(a) as Record<string, unknown>).event === "dispatcher-enforce-mode-not-honored-in-phase-1"
      } catch {
        return false
      }
    })
    expect(notHonored).toBeUndefined()

    // CodeRabbit #325: assert the REAL fan-out, not just telemetry — the
    // specialist chat() calls (excluding the dispatcher classifier) RAN
    // security + logic (protected) and did NOT run tests/performance (the LLM
    // omitted them). This proves router.specialists actually drove the fan-out.
    const ranRoles = mockChat.mock.calls
      .filter((c) => !isDispatcherCall(c[0]))
      .map((c) => callRole(c[0]))
      .filter((r): r is string => r !== null)
    expect(ranRoles).toContain("security")
    expect(ranRoles).toContain("logic")
    expect(ranRoles).not.toContain("tests")
    expect(ranRoles).not.toContain("performance")
  })
})
