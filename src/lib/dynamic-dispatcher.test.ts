// SIG-226 / SIG-224 Phase 1 — tests for the dynamic specialist
// dispatcher's pure rule layer (`computeRuleLayer`).
//
// The top-level `decideSpecialistsDynamic` orchestration (with mocked
// chat()) is exercised in the sibling file
// `dynamic-dispatcher.decide.test.ts`. Integration with
// `triage-pr-review-ensemble.ts` (shadow-mode wire-in) is exercised in
// `triage-pr-review-ensemble-dispatcher-shadow.test.ts`.

import { describe, expect, it } from "vitest"
import { computeRuleLayer } from "@/src/lib/dynamic-dispatcher"
import { EMPTY_CONFIG, classifiedFor } from "@/src/lib/dynamic-dispatcher.test-helpers"

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
    expect([...result.safeSkipRoles].sort()).toEqual(["logic", "performance", "security", "tests"])
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
        classified: [
          {
            path: "src/types/auth-types.d.ts",
            kind: "config",
            testsSibling: null,
            sourceSibling: null,
          },
        ],
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
          {
            path: "src/lib/foo.ts",
            kind: "source",
            testsSibling: "tests/foo.test.ts",
            sourceSibling: null,
          },
          {
            path: "tests/foo.test.ts",
            kind: "test",
            testsSibling: null,
            sourceSibling: "src/lib/foo.ts",
          },
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
      classified: [
        {
          path: "src/custom-auth/login.ts",
          kind: "source",
          testsSibling: null,
          sourceSibling: null,
        },
      ],
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
