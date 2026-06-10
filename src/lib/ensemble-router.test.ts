import { describe, expect, it } from "vitest"
import { decideSpecialists, ALL_SPECIALISTS } from "@/src/lib/ensemble-router"

const offEnv = { OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "off" } as const
const onEnv = { OPENCLAW_ENSEMBLE_ROUTER_ENABLED: "on" } as const

describe("decideSpecialists — router OFF (Phase 4a default)", () => {
  it("returns ALL FOUR specialists, regardless of paths", () => {
    const decision = decideSpecialists(
      { paths: ["src/foo.ts", "tests/foo.test.ts"], totalLinesChanged: 12 },
      offEnv,
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
    expect(decision.reason).toBe("router_off_always_fire")
    expect(decision.routerEnabled).toBe(false)
  })

  it("returns all four even on docs-only diffs (router off)", () => {
    const decision = decideSpecialists(
      { paths: ["README.md"], totalLinesChanged: 3 },
      offEnv,
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
    expect(decision.routerEnabled).toBe(false)
  })

  it("returns all four when env is missing entirely (defaults to off)", () => {
    const decision = decideSpecialists(
      { paths: ["src/foo.ts"], totalLinesChanged: 1 },
      {} as { OPENCLAW_ENSEMBLE_ROUTER_ENABLED?: string },
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
    expect(decision.routerEnabled).toBe(false)
  })
})

describe("decideSpecialists — router ON (Phase 4b activation)", () => {
  it("returns all four for an ordinary code change", () => {
    const decision = decideSpecialists(
      { paths: ["src/lib/foo.ts", "src/components/bar.tsx"], totalLinesChanged: 50 },
      onEnv,
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
    expect(decision.reason).toBe("default_all_four")
    expect(decision.routerEnabled).toBe(true)
  })

  it("returns NO specialists for docs-only PRs WITH safe content (no executable fences)", () => {
    // Empty diffText → fail closed; supply benign markdown to take the shortcut.
    const benignDiff = [
      "diff --git a/README.md b/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,3 @@",
      "+# Heading",
      "+",
      "+Just some prose with `inline code`.",
    ].join("\n")
    const decision = decideSpecialists(
      { paths: ["README.md", "CONTRIBUTING.md", "docs/intro.mdx"], totalLinesChanged: 30, diffText: benignDiff },
      onEnv,
    )
    expect(decision.specialists).toEqual([])
    expect(decision.reason).toBe("docs_only_no_specialists")
  })

  it("FAILS CLOSED on docs-only when diffText is not provided (router can't be sure content is safe)", () => {
    // CR PR #35 catch: extension-only check is unsafe. Without diffText
    // the router falls through to the default-all-four path because
    // it can't verify the markdown doesn't contain executable fences.
    const decision = decideSpecialists(
      { paths: ["README.md"], totalLinesChanged: 30 },  // no diffText
      onEnv,
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
  })

  it("does NOT skip docs-only when markdown contains executable fences (sh/bash)", () => {
    const dangerousDiff = [
      "diff --git a/docs/setup.md b/docs/setup.md",
      "+++ b/docs/setup.md",
      "@@ -1,2 +1,5 @@",
      "+# Setup",
      "+",
      "+```bash",
      "+curl https://example.com/install.sh | sudo bash",
      "+```",
    ].join("\n")
    const decision = decideSpecialists(
      { paths: ["docs/setup.md"], totalLinesChanged: 5, diffText: dangerousDiff },
      onEnv,
    )
    // Bash fence found → docs-only shortcut skipped → run default ensemble.
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
  })

  it.each(["yaml", "dockerfile", "hcl", "terraform", "json", "powershell", "sql"])(
    "does NOT skip docs-only when markdown contains a %s fenced block",
    (lang) => {
      const diff = [
        "diff --git a/docs/x.md b/docs/x.md",
        "+++ b/docs/x.md",
        "@@ -1,1 +1,3 @@",
        `+\`\`\`${lang}`,
        "+content",
        "+```",
      ].join("\n")
      const decision = decideSpecialists(
        { paths: ["docs/x.md"], totalLinesChanged: 3, diffText: diff },
        onEnv,
      )
      expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
    },
  )

  it("returns ONLY performance for CSS-only PRs", () => {
    const decision = decideSpecialists(
      { paths: ["src/styles/main.css", "src/styles/buttons.scss"], totalLinesChanged: 20 },
      onEnv,
    )
    expect(decision.specialists).toEqual(["performance"])
    expect(decision.reason).toBe("css_only_perf_only")
  })

  it("does NOT take docs-only shortcut if any non-doc file is present", () => {
    const decision = decideSpecialists(
      { paths: ["README.md", "src/foo.ts"], totalLinesChanged: 10 },
      onEnv,
    )
    expect(decision.specialists).toEqual([...ALL_SPECIALISTS])
  })

  it("FORCES security on lockfile changes (even if otherwise docs-only)", () => {
    const decision = decideSpecialists(
      { paths: ["package-lock.json", "README.md"], totalLinesChanged: 100 },
      onEnv,
    )
    // Lockfile force overrides the docs-only short-circuit.
    expect(decision.specialists).toContain("security")
    expect(decision.reason).toContain("forced")
  })

  it.each([
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "Gemfile.lock",
  ])("forces security when %s changes", (path) => {
    const decision = decideSpecialists(
      { paths: [path], totalLinesChanged: 5 },
      onEnv,
    )
    expect(decision.specialists).toContain("security")
  })

  it("FORCES security when auth/middleware paths touched", () => {
    const decision = decideSpecialists(
      { paths: ["src/auth/jwt.ts"], totalLinesChanged: 20 },
      onEnv,
    )
    expect(decision.specialists).toContain("security")
  })

  it("FORCES security + logic on schema/migration changes", () => {
    const decision = decideSpecialists(
      { paths: ["migrations/0042_add_user_table.sql"], totalLinesChanged: 30 },
      onEnv,
    )
    expect(decision.specialists).toContain("security")
    expect(decision.specialists).toContain("logic")
  })

  it("does NOT gate tests specialist on test-files-changed (reviewer guardrail)", () => {
    // Reviewer catch: tests specialist's highest value is catching PRs
    // WITHOUT new tests. Gating on test-file presence would defeat its
    // purpose. PR with no test files should still trigger tests specialist.
    const decision = decideSpecialists(
      { paths: ["src/lib/critical-logic.ts"], totalLinesChanged: 100 },
      onEnv,
    )
    expect(decision.specialists).toContain("tests")
  })

  it("treats markdown with auth keywords in path as security-relevant", () => {
    // Codex caveat: docs-only is dangerous when docs touch sensitive
    // paths. We force security via path-name detection.
    const decision = decideSpecialists(
      { paths: ["docs/auth/oauth-flow.md"], totalLinesChanged: 50 },
      onEnv,
    )
    expect(decision.specialists).toContain("security")
  })
})
