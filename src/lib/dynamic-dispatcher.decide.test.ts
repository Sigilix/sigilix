// SIG-226 / SIG-224 Phase 1 — dynamic specialist dispatcher: the
// top-level `decideSpecialistsDynamic` orchestration (LLM-call fail-closed
// semantics + telemetry), exercised with a mocked `chat()`.
//
// Sibling of dynamic-dispatcher.test.ts (split out under SIG-318/SIG-376
// to keep each suite ≤1,000 lines). The `vi.hoisted` mock fn + `vi.mock`
// factory + `beforeEach`/`afterEach` are replicated here because vitest
// hoists `vi.mock` per file and mock state does not cross files. Shared
// pure fixtures come from dynamic-dispatcher.test-helpers.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockChat } = vi.hoisted(() => ({
  mockChat: vi.fn(),
}))

vi.mock("@/src/shared/adapters/model/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model/ollama-chat")>(
    "@/src/shared/adapters/model/ollama-chat",
  )
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

import { decideSpecialistsDynamic, DISPATCHER_LLM_MODEL, DISPATCHER_LLM_TIMEOUT_MS } from "@/src/lib/dynamic-dispatcher"
import {
  EMPTY_CONFIG,
  type DispatcherEnv,
  envOff,
  envShadow,
  classifiedFor,
} from "@/src/lib/dynamic-dispatcher.test-helpers"

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("decideSpecialistsDynamic — mode=off (default)", () => {
  it("returns ALL_SPECIALISTS with disabled outcome and never calls chat()", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 10, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envOff(),
    })
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(decision.layerVotes.llmOutcome).toBe("disabled")
    expect(decision.reasoning).toBe("dispatcher_disabled")
    expect(mockChat).not.toHaveBeenCalled()
  })
})

describe("decideSpecialistsDynamic — mode=shadow, rules decide everything", () => {
  it("skips the LLM call when rules already safe-skipped every role (docs-only)", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["README.md"], totalLinesChanged: 3, diffText: "+ a note" },
      classified: classifiedFor(["README.md"]),
      commitMessage: "docs: update",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.specialists).toEqual([])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_no_ambiguous")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("skips the LLM call when rules forced every role (lockfile + behavior commit on source file)", async () => {
    // Lockfile forces security + content/path rules force logic. Once
    // CSS-only doesn't apply, perf + tests remain ambiguous, so the
    // LLM still fires. Use a case where rules cover every role: docs-
    // only diff with workflow file → force security; combined with a
    // schema file would force logic too; CSS-only would force perf;
    // and "tests" is the only ambiguous remainder. To get to "no
    // ambiguous left," set `force: ["performance", "tests"]` in repo
    // config alongside the schema-migration path.
    const decision = await decideSpecialistsDynamic({
      signals: {
        paths: ["db/migrations/0001_init.sql"],
        totalLinesChanged: 5,
      },
      classified: classifiedFor(["db/migrations/0001_init.sql"]),
      commitMessage: "feat: initial schema",
      repoConfig: { dispatcher: { force: ["performance", "tests"] } },
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("skipped_no_ambiguous")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(mockChat).not.toHaveBeenCalled()
  })
})

describe("decideSpecialistsDynamic — LLM disabled paths", () => {
  it("returns disabled outcome with ambiguous-all picks when OLLAMA_CHAT_ENABLE=off", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: refactor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow({ OLLAMA_CHAT_ENABLE: "off" }),
    })
    expect(decision.layerVotes.llmOutcome).toBe("disabled")
    // All four roles ambiguous + fail-closed → all four run.
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(mockChat).not.toHaveBeenCalled()
  })
})

describe("decideSpecialistsDynamic — LLM success path (mocked)", () => {
  it("honors LLM picks for non-protected roles when all four are ambiguous", async () => {
    // Commit message intentionally NEUTRAL (no behavior-change
    // keyword) and path is a generic src file with no forcing
    // patterns, so all four roles enter ambiguous. The LLM picks only
    // `tests`. Expected outcome:
    //   - tests: run (LLM picked, non-protected)
    //   - performance: skip (LLM didn't pick, non-protected)
    //   - logic + security: run (protected, consensus-to-skip default)
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: JSON.stringify({
          specialists: ["tests"],
          reasoning: "no behavior-change keyword; only test coverage worth a look",
          confidence: 4,
        }),
      },
      hasToolCalls: false,
    })
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 8, diffText: "+ const x = 1" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor tweak",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("ok")
    expect([...decision.specialists].sort()).toEqual(["logic", "security", "tests"])
    expect(decision.layerVotes.llmPicks).toEqual(["tests"])
    expect(mockChat).toHaveBeenCalledTimes(1)
    const firstCall = mockChat.mock.calls[0]?.[0] as { model: string } | undefined
    expect(firstCall?.model).toBe(DISPATCHER_LLM_MODEL)
  })

  it("KEEPS protected roles even when LLM says skip them (consensus-to-skip default)", async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: JSON.stringify({
          specialists: ["performance", "tests"],
          reasoning: "skipping security and logic",
          confidence: 5,
        }),
      },
      hasToolCalls: false,
    })
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    // Even with high LLM confidence skipping security + logic, normal
    // trust forces both to run. Non-protected roles honored.
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
  })
})

describe("decideSpecialistsDynamic — LLM failure paths (fail-closed)", () => {
  it("returns ALL_SPECIALISTS with timeout outcome when chat() throws an abort", async () => {
    mockChat.mockRejectedValueOnce(new Error("aborted by signal"))
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("timeout")
    // Fail-closed → all four ambiguous roles run.
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
  })

  it("returns ALL_SPECIALISTS with chat_error outcome when chat() throws a 5xx", async () => {
    mockChat.mockRejectedValueOnce(new Error("Ollama HTTP 503: overloaded"))
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("chat_error")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
  })

  it("returns chat_error outcome when chat() throws a stream/body error (not HTTP)", async () => {
    // chat_error covers HTTP errors, missing body, stream errors —
    // anything that isn't an abort. Code-review H2: original
    // http_error name was too narrow.
    mockChat.mockRejectedValueOnce(new Error("Ollama response missing body"))
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("chat_error")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
  })

  it("returns invalid_json outcome when chat() returns unparseable content", async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: "assistant", content: "not json at all" },
      hasToolCalls: false,
    })
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.layerVotes.llmOutcome).toBe("invalid_json")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
  })

  it("returns no_api_key outcome when OLLAMA_API_KEY is empty", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: envShadow({ OLLAMA_API_KEY: "" }),
    })
    expect(decision.layerVotes.llmOutcome).toBe("no_api_key")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns no_api_key outcome when OLLAMA_API_KEY is undefined / absent", async () => {
    // Code-review H3 / I1: Cloudflare bindings can yield `undefined`
    // when a secret was never `wrangler secret put`-ed. The Env type
    // claims `string` but runtime reality is `string | undefined`.
    // Verify the fail-closed path covers this.
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: minor",
      repoConfig: EMPTY_CONFIG,
      env: {
        OLLAMA_CHAT_ENABLE: "on",
        OPENCLAW_DYNAMIC_DISPATCHER_MODE: "shadow",
        // OLLAMA_API_KEY intentionally omitted to mimic missing secret
      } as DispatcherEnv,
    })
    expect(decision.layerVotes.llmOutcome).toBe("no_api_key")
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(mockChat).not.toHaveBeenCalled()
  })
})

describe("decideSpecialistsDynamic — telemetry shape", () => {
  it("populates perRole entries for ALL four specialists with action + confidence + reasons", async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: JSON.stringify({
          specialists: ["tests"],
          reasoning: "only tests-specialist is useful here",
          confidence: 4,
        }),
      },
      hasToolCalls: false,
    })
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 5, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    for (const role of ["logic", "security", "performance", "tests"] as const) {
      const vote = decision.perRole[role]
      expect(vote).toBeDefined()
      expect(["run", "skip"]).toContain(vote.action)
      expect(vote.confidence).toBeGreaterThanOrEqual(1)
      expect(vote.confidence).toBeLessThanOrEqual(5)
      expect(Array.isArray(vote.reasons)).toBe(true)
    }
    // Tests is invoked (LLM picked it). Performance is skipped (LLM
    // didn't pick + non-protected). Logic + security stay on (protected
    // consensus-to-skip default).
    expect(decision.perRole.tests.action).toBe("run")
    expect(decision.perRole.performance.action).toBe("skip")
    expect(decision.perRole.logic.action).toBe("run")
    expect(decision.perRole.security.action).toBe("run")
  })

  it("captures elapsed_ms (sanity check: positive integer)", async () => {
    mockChat.mockResolvedValueOnce({
      message: {
        role: "assistant",
        content: JSON.stringify({ specialists: [], reasoning: "", confidence: 3 }),
      },
      hasToolCalls: false,
    })
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 1, diffText: "+ x" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore",
      repoConfig: EMPTY_CONFIG,
      env: envShadow(),
    })
    expect(decision.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(decision.elapsedMs)).toBe(true)
  })
})

describe("decideSpecialistsDynamic — SIG-227a enforce_rules mode", () => {
  function envEnforceRules(overrides: Partial<DispatcherEnv> = {}): DispatcherEnv {
    return {
      OLLAMA_API_KEY: "fake-key",
      OLLAMA_CHAT_ENABLE: "on",
      OPENCLAW_DYNAMIC_DISPATCHER_MODE: "enforce_rules",
      ...overrides,
    }
  }

  it("returns empty specialists for docs-only-no-fences diffs WITHOUT calling the LLM", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["README.md"], totalLinesChanged: 3, diffText: "+ a note" },
      classified: classifiedFor(["README.md"]),
      commitMessage: "docs: update",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect(decision.specialists).toEqual([])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns only [performance] for CSS-only diffs WITHOUT calling the LLM", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/styles/main.css"], totalLinesChanged: 10, diffText: "+ .foo {}" },
      classified: [{ path: "src/styles/main.css", kind: "other", testsSibling: null, sourceSibling: null }],
      commitMessage: "style: tweak",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect(decision.specialists).toEqual(["performance"])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns only [security] for lockfile-only diffs WITHOUT calling the LLM", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["package-lock.json"], totalLinesChanged: 80 },
      classified: [{ path: "package-lock.json", kind: "config", testsSibling: null, sourceSibling: null }],
      commitMessage: "chore: bump",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect(decision.specialists).toEqual(["security"])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns only [tests] for pure .d.ts-only diffs WITHOUT calling the LLM", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/types/foo.d.ts"], totalLinesChanged: 5 },
      classified: [{ path: "src/types/foo.d.ts", kind: "other", testsSibling: null, sourceSibling: null }],
      commitMessage: "types",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect(decision.specialists).toEqual(["tests"])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns [logic, security, tests] for test-files-only diffs WITHOUT calling the LLM", async () => {
    // Per the bot-flagged fix: security stays ON for test-only PRs
    // to catch hardcoded creds / tokens in test fixtures. Only perf
    // is safe-skipped.
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["tests/foo.test.ts"], totalLinesChanged: 30 },
      classified: [{ path: "tests/foo.test.ts", kind: "test", testsSibling: null, sourceSibling: null }],
      commitMessage: "test: add foo coverage",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect([...decision.specialists].sort()).toEqual(["logic", "security", "tests"])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("returns ALL_SPECIALISTS for a normal source diff (ambiguous default to RUN, no LLM consulted)", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 30, diffText: "+ new code" },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "feat: foo",
      repoConfig: EMPTY_CONFIG,
      env: envEnforceRules(),
    })
    expect([...decision.specialists].sort()).toEqual(["logic", "performance", "security", "tests"])
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })

  it("respects sigilix.json::dispatcher.force in enforce_rules mode", async () => {
    const decision = await decideSpecialistsDynamic({
      signals: { paths: ["README.md"], totalLinesChanged: 3, diffText: "+ note" },
      classified: classifiedFor(["README.md"]),
      commitMessage: "docs",
      repoConfig: {
        dispatcher: { force: ["security"] },
      },
      env: envEnforceRules(),
    })
    // Docs-only would normally have empty fan-out, but repo force
    // adds security.
    expect(decision.specialists).toEqual(["security"])
    expect(decision.layerVotes.repoConfigForced).toEqual(["security"])
    // CR nit: pin that enforce_rules still skips LLM classification
    // even when `dispatcher.force` overrides the rule layer.
    expect(decision.layerVotes.llmOutcome).toBe("skipped_rules_only_mode")
    expect(mockChat).not.toHaveBeenCalled()
  })
})

describe("DISPATCHER_LLM_TIMEOUT_MS sanity", () => {
  it("is at most 10s per the spec's 5-10s budget", () => {
    expect(DISPATCHER_LLM_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
    expect(DISPATCHER_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })
})
