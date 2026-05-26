// SIG-226 / SIG-224 Phase 1 — tests for the dynamic specialist
// dispatcher. Covers the rule layer (pure), the LLM-call fail-closed
// semantics, and the top-level orchestration with mocked chat().
//
// Integration with `triage-pr-review-ensemble.ts` (shadow-mode wire-
// in) is exercised in a sibling file
// (`triage-pr-review-ensemble-dispatcher-shadow.test.ts`) modeled on
// the merge-shortcut pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { mockChat } = vi.hoisted(() => ({
  mockChat: vi.fn(),
}))

vi.mock("../src/lib/ollama-chat", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/ollama-chat")>("../src/lib/ollama-chat")
  return {
    ...actual,
    chat: (...args: unknown[]) => mockChat(...args),
  }
})

import {
  computeRuleLayer,
  decideSpecialistsDynamic,
  DISPATCHER_LLM_MODEL,
  DISPATCHER_LLM_TIMEOUT_MS,
} from "../src/lib/dynamic-dispatcher"
import type { ClassifiedDiffFile } from "../src/lib/diff-file-classify"
import type { SigilixConfig } from "../src/lib/sigilix-config"
import type { Env } from "../src/index"

const EMPTY_CONFIG: SigilixConfig = {}

type DispatcherEnv = Pick<
  Env,
  "OLLAMA_API_KEY" | "OLLAMA_CHAT_ENABLE" | "OPENCLAW_DYNAMIC_DISPATCHER_MODE"
>

function envOff(): DispatcherEnv {
  // `OPENCLAW_DYNAMIC_DISPATCHER_MODE` intentionally omitted — that's
  // the "off" path (default mode is absent / not "shadow"|"enforce").
  return {
    OLLAMA_API_KEY: "fake-key",
    OLLAMA_CHAT_ENABLE: "on",
  }
}

function envShadow(overrides: Partial<DispatcherEnv> = {}): DispatcherEnv {
  return {
    OLLAMA_API_KEY: "fake-key",
    OLLAMA_CHAT_ENABLE: "on",
    OPENCLAW_DYNAMIC_DISPATCHER_MODE: "shadow",
    ...overrides,
  }
}

function classifiedFor(paths: string[]): ClassifiedDiffFile[] {
  return paths.map((p) => ({
    path: p,
    kind: p.endsWith(".md") ? "docs" : p.endsWith(".css") ? "other" : "source",
    testsSibling: null,
    sourceSibling: null,
  }))
}

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── Pure rule layer ──────────────────────────────────────────────────

describe("computeRuleLayer — docs-only shortcut", () => {
  it("safe-skips ALL roles when diff is pure-docs with no executable fences", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["README.md", "docs/notes.md"],
        totalLinesChanged: 5,
        diffText: "+ a plain note\n+ another note",
      },
      classified: classifiedFor(["README.md", "docs/notes.md"]),
      commitMessage: "docs: add notes",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.size).toBe(0)
    expect([...result.safeSkipRoles].sort()).toEqual(
      ["logic", "performance", "security", "tests"]
    )
    expect(result.reasons).toContain("docs_only_no_executable_fences")
  })

  it("does NOT safe-skip when docs diff contains executable fenced YAML", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["docs/deploy.md"],
        totalLinesChanged: 4,
        diffText: "+ ```yaml\n+ name: deploy\n+ ```",
      },
      classified: classifiedFor(["docs/deploy.md"]),
      commitMessage: "docs: update deploy guide",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.safeSkipRoles.size).toBe(0)
  })

  it("FORCE-overrides docs-shortcut when a security path is touched too", () => {
    // A docs PR that ALSO touches a workflow file. Forced wins.
    const result = computeRuleLayer({
      signals: {
        paths: ["README.md", ".github/workflows/deploy.yml"],
        totalLinesChanged: 8,
        diffText: "+ docs update\n+ new workflow line",
      },
      classified: classifiedFor(["README.md", ".github/workflows/deploy.yml"]),
      commitMessage: "docs+ci: minor",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("security")).toBe(true)
    // The docs-shortcut would have safe-skipped security, but the
    // workflow force overrides. Verify safeSkipRoles does NOT contain
    // security after reconcile.
    expect(result.safeSkipRoles.has("security")).toBe(false)
  })
})

describe("computeRuleLayer — CSS-only shortcut", () => {
  it("forces performance + safe-skips the other three", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/styles/main.css", "src/styles/dark.scss"],
        totalLinesChanged: 12,
        diffText: "+ .foo { color: red; }",
      },
      classified: classifiedFor(["src/styles/main.css", "src/styles/dark.scss"]),
      commitMessage: "style: tweak colors",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("performance")).toBe(true)
    expect([...result.safeSkipRoles].sort()).toEqual(["logic", "security", "tests"])
  })
})

describe("computeRuleLayer — security path force patterns", () => {
  const cases: Array<[string, string]> = [
    ["src/auth/oauth.ts", "auth path"],
    ["src/lib/jwt-verify.ts", "jwt token name"],
    ["src/middleware/cors.ts", "middleware path"],
    ["app/iam/policies.ts", "iam path"],
    [".env.production", "env file"],
    ["secrets/server.pem", "pem file"],
    ["certs/server.crt", "crt file"],
    [".github/workflows/deploy.yml", "GH workflow"],
    ["Dockerfile", "dockerfile"],
    ["infra/main.tf", "terraform"],
    ["k8s/deploy.yaml", "k8s manifest"],
    ["src/webhooks/handler.ts", "webhook"],
    ["src/csrf-token.ts", "csrf"],
    ["src/lib/saml-callback.ts", "saml"],
    ["src/lib/oidc-handler.ts", "oidc"],
    ["src/lib/rbac.ts", "rbac"],
    ["db/schema.policy.sql", "policy file"],
    ["src/policies/admin.ts", "policies dir"],
  ]
  for (const [path, label] of cases) {
    it(`forces security on ${label} (${path})`, () => {
      const result = computeRuleLayer({
        signals: {
          paths: [path],
          totalLinesChanged: 3,
          diffText: "+ const x = 1",
        },
        classified: classifiedFor([path]),
        commitMessage: "chore: update",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.forcedRoles.has("security")).toBe(true)
    })
  }

  // Code-review M1 regression coverage: prior `\bauth\b` etc. word-
  // boundary patterns silently missed common compound filenames.
  // These tests pin the camelCase / dash / digit-suffix coverage so a
  // future refactor can't reintroduce the recall hole.
  const m1RegressionCases: Array<[string, string]> = [
    ["src/lib/authorize.ts", "authorize (compound from auth)"],
    ["src/auth0-helper.ts", "auth0-* (digit suffix)"],
    ["src/lib/jwtdecode.ts", "jwtdecode (camelCase from jwt)"],
    ["src/lib/passwordreset.ts", "passwordreset (compound from password)"],
    ["src/lib/tokenrefresh.ts", "tokenrefresh (compound from token)"],
    ["src/auth-helper.ts", "auth-helper (dash suffix)"],
    ["src/lib/oauth2-callback.ts", "oauth2-callback (digit + dash)"],
    ["src/lib/sessionstorage.ts", "sessionstorage (compound from session)"],
  ]
  for (const [path, label] of m1RegressionCases) {
    it(`M1 regression: forces security on ${label}`, () => {
      const result = computeRuleLayer({
        signals: { paths: [path], totalLinesChanged: 3, diffText: "+ x" },
        classified: classifiedFor([path]),
        commitMessage: "chore: update",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.forcedRoles.has("security")).toBe(true)
    })
  }

  it("forces security on lockfile changes (supply chain)", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["package-lock.json"],
        totalLinesChanged: 100,
      },
      classified: classifiedFor(["package-lock.json"]),
      commitMessage: "chore: bump deps",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("security")).toBe(true)
  })
})

describe("computeRuleLayer — content-based security forces", () => {
  it("forces security when added line contains eval(", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/lib/parse.ts"],
        totalLinesChanged: 1,
        diffText: "+ const r = eval(userInput)",
      },
      classified: classifiedFor(["src/lib/parse.ts"]),
      commitMessage: "chore: refactor",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("security")).toBe(true)
  })

  it("forces security when added line contains dangerouslySetInnerHTML", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/components/foo.tsx"],
        totalLinesChanged: 1,
        diffText: "+ return <div dangerouslySetInnerHTML={{__html: x}}/>",
      },
      classified: classifiedFor(["src/components/foo.tsx"]),
      commitMessage: "feat: render html",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("security")).toBe(true)
  })

  it("does NOT force security when eval appears in a comment or context line (not +-prefixed)", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/lib/foo.ts"],
        totalLinesChanged: 1,
        diffText: "  // eval(x) used here",
      },
      classified: classifiedFor(["src/lib/foo.ts"]),
      commitMessage: "chore: comment update",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("security")).toBe(false)
  })
})

describe("computeRuleLayer — logic force patterns", () => {
  it("forces both security and logic on schema migration", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["db/migrations/0042_add_user_table.sql"],
        totalLinesChanged: 20,
      },
      classified: classifiedFor(["db/migrations/0042_add_user_table.sql"]),
      commitMessage: "feat: add user table",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("logic")).toBe(true)
    expect(result.forcedRoles.has("security")).toBe(true)
  })

  it("forces logic on payment path", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/billing/invoice.ts"],
        totalLinesChanged: 30,
      },
      classified: classifiedFor(["src/billing/invoice.ts"]),
      commitMessage: "feat: invoice generation",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("logic")).toBe(true)
  })

  it("forces logic when commit says 'fix' AND source files are touched", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/lib/foo.ts"],
        totalLinesChanged: 5,
      },
      classified: [{ path: "src/lib/foo.ts", kind: "source", testsSibling: null, sourceSibling: null }],
      commitMessage: "fix: off-by-one in clampIndex",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("logic")).toBe(true)
  })

  it("does NOT force logic on docs-only commit message even if message says 'fix'", () => {
    // No source files → behavior-keyword shouldn't matter.
    const result = computeRuleLayer({
      signals: {
        paths: ["docs/notes.md"],
        totalLinesChanged: 1,
      },
      classified: [{ path: "docs/notes.md", kind: "docs", testsSibling: null, sourceSibling: null }],
      commitMessage: "fix: typo in docs",
      repoConfig: EMPTY_CONFIG,
    })
    expect(result.forcedRoles.has("logic")).toBe(false)
  })
})

describe("computeRuleLayer — per-repo dispatcher config", () => {
  it("respects sigilix.json::dispatcher.force adding security + logic", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/lib/foo.ts"],
        totalLinesChanged: 5,
      },
      classified: [{ path: "src/lib/foo.ts", kind: "source", testsSibling: null, sourceSibling: null }],
      commitMessage: "chore: bump",
      repoConfig: {
        dispatcher: { force: ["security", "logic"] },
      },
    })
    expect(result.forcedRoles.has("security")).toBe(true)
    expect(result.forcedRoles.has("logic")).toBe(true)
  })

  it("applies sigilix.json::dispatcher.safetyNet.additionalPatterns globs", () => {
    const result = computeRuleLayer({
      signals: {
        paths: ["src/custom-auth/login.ts"],
        totalLinesChanged: 5,
      },
      classified: [{ path: "src/custom-auth/login.ts", kind: "source", testsSibling: null, sourceSibling: null }],
      commitMessage: "feat: custom auth flow",
      repoConfig: {
        dispatcher: {
          safetyNet: {
            additionalPatterns: [{ glob: "src/custom-auth/**", role: "security" }],
          },
        },
      },
    })
    expect(result.forcedRoles.has("security")).toBe(true)
  })

  it("force-includes the role for every PR when additionalPatterns uses an over-broad glob (intentional opt-in)", () => {
    // Code-review M4 / spec line 425: per-repo dispatcher.force +
    // additionalPatterns are ADDITIVE by design. A repo that
    // configures `{ glob: "**", role: "security" }` is opting into
    // running security on every PR. Pin this so a future "what does
    // this glob match" tightening doesn't silently neuter the opt-in.
    const result = computeRuleLayer({
      signals: { paths: ["unrelated/file.txt"], totalLinesChanged: 1 },
      classified: [{ path: "unrelated/file.txt", kind: "other", testsSibling: null, sourceSibling: null }],
      commitMessage: "chore",
      repoConfig: {
        dispatcher: {
          safetyNet: {
            additionalPatterns: [{ glob: "**", role: "security" }],
          },
        },
      },
    })
    expect(result.forcedRoles.has("security")).toBe(true)
  })

  it("ignores malformed glob in additionalPatterns (fail-open)", () => {
    const result = computeRuleLayer({
      signals: { paths: ["src/lib/foo.ts"], totalLinesChanged: 1 },
      classified: [{ path: "src/lib/foo.ts", kind: "source", testsSibling: null, sourceSibling: null }],
      commitMessage: "chore",
      repoConfig: {
        dispatcher: {
          safetyNet: {
            additionalPatterns: [{ glob: "[unclosed", role: "security" }],
          },
        },
      },
    })
    // Malformed glob is silently skipped — neither forced nor crashed.
    // (There may be other forces from the file path, but not from the
    // malformed pattern.)
    expect(result.reasons).not.toContain("repo_additional_patterns=security")
  })
})

// ─── Top-level decideSpecialistsDynamic ──────────────────────────────

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

describe("DISPATCHER_LLM_TIMEOUT_MS sanity", () => {
  it("is at most 10s per the spec's 5-10s budget", () => {
    expect(DISPATCHER_LLM_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
    expect(DISPATCHER_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
  })
})
