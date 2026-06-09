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
import type { Env } from "../src/shared/types/env"

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
    // Per-role reason attribution: docs-only-no-fences fires on every
    // role. Code-review M1 fix: reasons are tracked per role now,
    // not in a global shared list.
    for (const role of ["logic", "performance", "security", "tests"] as const) {
      expect(result.roleReasons.get(role)).toContain("docs_only_no_executable_fences")
    }
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

describe("computeRuleLayer — SIG-227a new safe-skip shortcuts", () => {
  describe("lockfile-only", () => {
    it("safe-skips logic/perf/tests + force-includes security (supply-chain)", () => {
      const paths = ["package-lock.json"]
      const result = computeRuleLayer({
        signals: { paths, totalLinesChanged: 80 },
        classified: [{ path: "package-lock.json", kind: "config", testsSibling: null, sourceSibling: null }],
        commitMessage: "chore: bump deps",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.forcedRoles.has("security")).toBe(true)
      expect(result.safeSkipRoles.has("logic")).toBe(true)
      expect(result.safeSkipRoles.has("performance")).toBe(true)
      expect(result.safeSkipRoles.has("tests")).toBe(true)
      // Security never safe-skipped (forced wins).
      expect(result.safeSkipRoles.has("security")).toBe(false)
    })

    it("matches yarn.lock + pnpm-lock.yaml + cargo.lock + go.sum + poetry.lock + gemfile.lock + composer.lock", () => {
      const lockfileNames = [
        "yarn.lock",
        "pnpm-lock.yaml",
        "Cargo.lock",
        "go.sum",
        "poetry.lock",
        "Gemfile.lock",
        "composer.lock",
      ]
      for (const name of lockfileNames) {
        const result = computeRuleLayer({
          signals: { paths: [name], totalLinesChanged: 50 },
          // Lockfiles are classified as `config` by
          // `diff-file-classify::CONFIG_FILE_RE`; mirror that here so
          // the fixture tracks the real classifier output (code-
          // review L3).
          classified: [{ path: name, kind: "config", testsSibling: null, sourceSibling: null }],
          commitMessage: "chore",
          repoConfig: EMPTY_CONFIG,
        })
        expect(result.safeSkipRoles.has("logic")).toBe(true)
        expect(result.safeSkipRoles.has("performance")).toBe(true)
        expect(result.safeSkipRoles.has("tests")).toBe(true)
        expect(result.forcedRoles.has("security")).toBe(true)
      }
    })

    it("does NOT safe-skip when source files are also touched", () => {
      const result = computeRuleLayer({
        signals: {
          paths: ["package-lock.json", "src/lib/foo.ts"],
          totalLinesChanged: 90,
        },
        classified: [
          { path: "package-lock.json", kind: "config", testsSibling: null, sourceSibling: null },
          { path: "src/lib/foo.ts", kind: "source", testsSibling: null, sourceSibling: null },
        ],
        commitMessage: "chore: bump deps + foo refactor",
        repoConfig: EMPTY_CONFIG,
      })
      // Security still forced via lockfile, but logic/perf/tests are
      // NOT safe-skipped because the source file might need review.
      expect(result.forcedRoles.has("security")).toBe(true)
      expect(result.safeSkipRoles.has("logic")).toBe(false)
      expect(result.safeSkipRoles.has("performance")).toBe(false)
      expect(result.safeSkipRoles.has("tests")).toBe(false)
    })
  })

  describe(".d.ts-only", () => {
    it("safe-skips security/logic/perf + keeps tests (assertion-shape can shift)", () => {
      const result = computeRuleLayer({
        signals: {
          paths: ["src/types/foo.d.ts", "src/types/bar.d.ts"],
          totalLinesChanged: 12,
        },
        classified: [
          { path: "src/types/foo.d.ts", kind: "other", testsSibling: null, sourceSibling: null },
          { path: "src/types/bar.d.ts", kind: "other", testsSibling: null, sourceSibling: null },
        ],
        commitMessage: "types: tighten generic constraints",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.safeSkipRoles.has("security")).toBe(true)
      expect(result.safeSkipRoles.has("logic")).toBe(true)
      expect(result.safeSkipRoles.has("performance")).toBe(true)
      expect(result.safeSkipRoles.has("tests")).toBe(false)
    })

    it("matches .d.mts and .d.cts extensions", () => {
      for (const ext of [".d.ts", ".d.mts", ".d.cts"]) {
        const path = `src/types/foo${ext}`
        const result = computeRuleLayer({
          signals: { paths: [path], totalLinesChanged: 3 },
          classified: [{ path, kind: "other", testsSibling: null, sourceSibling: null }],
          commitMessage: "types",
          repoConfig: EMPTY_CONFIG,
        })
        expect(result.safeSkipRoles.has("security")).toBe(true)
        expect(result.safeSkipRoles.has("logic")).toBe(true)
      }
    })

    it("re-adds security via path force when .d.ts file ALSO matches a security pattern (collision)", () => {
      // Code-review L4: .d.ts shortcut safe-skips security, but the
      // auth-path pattern force-adds it back. Pin the
      // "forced-wins-over-safe-skip" semantic for the collision.
      const result = computeRuleLayer({
        signals: {
          paths: ["src/types/auth-types.d.ts"],
          totalLinesChanged: 4,
        },
        classified: [{ path: "src/types/auth-types.d.ts", kind: "config", testsSibling: null, sourceSibling: null }],
        commitMessage: "types: auth-related types",
        repoConfig: EMPTY_CONFIG,
      })
      // .d.ts safe-skip says: skip security/logic/perf
      // auth-pattern force says: run security
      // → security wins (force beats safe-skip in the final pass)
      expect(result.forcedRoles.has("security")).toBe(true)
      expect(result.safeSkipRoles.has("security")).toBe(false)
      // logic + perf were safe-skipped by .d.ts and not forced back
      expect(result.safeSkipRoles.has("logic")).toBe(true)
      expect(result.safeSkipRoles.has("performance")).toBe(true)
    })

    it("does NOT safe-skip when a .ts (non-d.ts) source file is in the same diff", () => {
      const result = computeRuleLayer({
        signals: {
          paths: ["src/types/foo.d.ts", "src/lib/foo.ts"],
          totalLinesChanged: 10,
        },
        classified: [
          { path: "src/types/foo.d.ts", kind: "other", testsSibling: null, sourceSibling: null },
          { path: "src/lib/foo.ts", kind: "source", testsSibling: null, sourceSibling: null },
        ],
        commitMessage: "feat: foo + types",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.safeSkipRoles.has("security")).toBe(false)
      expect(result.safeSkipRoles.has("logic")).toBe(false)
      expect(result.safeSkipRoles.has("performance")).toBe(false)
    })
  })

  describe("test-files-only", () => {
    it("safe-skips ONLY performance — security stays on for secret-leakage protection", () => {
      // Sigilix bot finding on PR #185: test files commonly contain
      // hardcoded API keys, mock credentials, integration-test
      // tokens, JWTs with hardcoded payloads. Skipping security on
      // test-only PRs would silently route accidental secret
      // commits past the review pipeline. Earlier draft also safe-
      // skipped security; this revision keeps security on. Wall-
      // time impact is negligible because logic still runs in
      // parallel and dominates the critical path.
      const result = computeRuleLayer({
        signals: {
          paths: ["tests/foo.test.ts", "tests/bar.test.ts"],
          totalLinesChanged: 40,
        },
        classified: [
          { path: "tests/foo.test.ts", kind: "test", testsSibling: null, sourceSibling: null },
          { path: "tests/bar.test.ts", kind: "test", testsSibling: null, sourceSibling: null },
        ],
        commitMessage: "test: add coverage for foo + bar",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.safeSkipRoles.has("performance")).toBe(true)
      // Security stays ON — protects against hardcoded test creds /
      // tokens / API keys that look real.
      expect(result.safeSkipRoles.has("security")).toBe(false)
      // Logic stays on — assertion correctness IS logic.
      expect(result.safeSkipRoles.has("logic")).toBe(false)
      // Tests stays on for the obvious reason.
      expect(result.safeSkipRoles.has("tests")).toBe(false)
    })

    it("neither lockfile-only NOR .d.ts-only fires on a mixed diff (defense in depth)", () => {
      // Code-review L4: mixed-shortcut case. Diff has one lockfile +
      // one .d.ts → BOTH `allLockfilesOnly` and `allDtsOnly` are
      // false, so neither shortcut fires. Security still force-
      // included via the lockfile supply-chain pattern; everything
      // else stays ambiguous (defaults to RUN in enforce_rules).
      const result = computeRuleLayer({
        signals: {
          paths: ["package-lock.json", "src/types/foo.d.ts"],
          totalLinesChanged: 50,
        },
        classified: [
          { path: "package-lock.json", kind: "config", testsSibling: null, sourceSibling: null },
          { path: "src/types/foo.d.ts", kind: "config", testsSibling: null, sourceSibling: null },
        ],
        commitMessage: "chore: deps + types",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.forcedRoles.has("security")).toBe(true)
      // No safe-skip — both shortcuts require purity.
      expect(result.safeSkipRoles.has("logic")).toBe(false)
      expect(result.safeSkipRoles.has("performance")).toBe(false)
      expect(result.safeSkipRoles.has("tests")).toBe(false)
    })

    it("does NOT safe-skip when source files are also touched", () => {
      const result = computeRuleLayer({
        signals: {
          paths: ["src/lib/foo.ts", "tests/foo.test.ts"],
          totalLinesChanged: 30,
        },
        classified: [
          { path: "src/lib/foo.ts", kind: "source", testsSibling: "tests/foo.test.ts", sourceSibling: null },
          { path: "tests/foo.test.ts", kind: "test", testsSibling: null, sourceSibling: "src/lib/foo.ts" },
        ],
        commitMessage: "feat: foo with tests",
        repoConfig: EMPTY_CONFIG,
      })
      expect(result.safeSkipRoles.has("security")).toBe(false)
      expect(result.safeSkipRoles.has("performance")).toBe(false)
    })
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
  it("does NOT consume sigilix.json::dispatcher.force (separation of concerns)", () => {
    // Code-review M1: `dispatcher.force` is a REPO OVERRIDE, not a
    // rule-layer signal. `computeRuleLayer` intentionally ignores it
    // so per-layer telemetry stays attributable. The top-level
    // `decideSpecialistsDynamic` reads `dispatcher.force` separately
    // into `layerVotes.repoConfigForced`. Coverage of the actual
    // force-include behavior lives under
    // `decideSpecialistsDynamic — mode=shadow, rules decide everything`.
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
    // Rule layer is silent — no rule-driven force fired.
    expect(result.forcedRoles.has("security")).toBe(false)
    expect(result.forcedRoles.has("logic")).toBe(false)
    expect(result.roleReasons.get("security")).toBeUndefined()
    expect(result.roleReasons.get("logic")).toBeUndefined()
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
    // (Per-role reasons map has no entry for `security` from the
    // pattern; other patterns / paths may have populated it, but
    // not via the malformed `[unclosed` glob.)
    const securityReasons = result.roleReasons.get("security") ?? []
    expect(securityReasons.some((r) => r.includes("repo_additional_pattern="))).toBe(false)
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
