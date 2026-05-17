// ARC-272 — tests for the zero-LLM docs-coverage check.

import { describe, expect, it } from "vitest"
import {
  runDocsCoverageCheck,
  renderDocsCoverageForPrompt,
} from "../src/lib/docs-coverage-check"
import { resolveDocsReviewConfig } from "../src/lib/sigilix-config"

const baseConfig = {
  enabled: true,
  architectureGlobs: ["src/lib/**", "wrangler.toml", "package.json"],
  docPaths: ["README.md", "docs/**", "AGENTS.md", "CHANGELOG.md"],
}

describe("runDocsCoverageCheck", () => {
  it("returns null when disabled", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts"],
      { ...baseConfig, enabled: false },
    )
    expect(out).toBeNull()
  })

  it("returns null when architectureGlobs is empty (operator hasn't opted in)", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts"],
      { ...baseConfig, architectureGlobs: [] },
    )
    expect(out).toBeNull()
  })

  it("returns null when changedPaths is empty", () => {
    const out = runDocsCoverageCheck([], baseConfig)
    expect(out).toBeNull()
  })

  it("returns null when no path matches architectureGlobs", () => {
    const out = runDocsCoverageCheck(
      ["tests/foo.test.ts", "scripts/build.sh"],
      baseConfig,
    )
    expect(out).toBeNull()
  })

  it("returns null when architecture is touched AND docs are touched (coverage satisfied)", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts", "README.md"],
      baseConfig,
    )
    expect(out).toBeNull()
  })

  it("emits a hit when architecture is touched without docs", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts", "src/lib/bar.ts"],
      baseConfig,
    )
    expect(out).not.toBeNull()
    expect(out!.architectureFiles).toEqual(["src/lib/foo.ts", "src/lib/bar.ts"])
    expect(out!.docPaths).toEqual(baseConfig.docPaths)
  })

  it("emits a hit on a config-file change without docs (wrangler.toml + package.json patterns)", () => {
    const out = runDocsCoverageCheck(
      ["wrangler.toml"],
      baseConfig,
    )
    expect(out).not.toBeNull()
    expect(out!.architectureFiles).toEqual(["wrangler.toml"])
  })

  it("counts a docs/** subpath as docs coverage", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts", "docs/guides/getting-started.md"],
      baseConfig,
    )
    expect(out).toBeNull()
  })

  it("counts the bare directory itself (`docs`) as docs/** coverage", () => {
    // code-reviewer M2 catch: the `(?:/.*)?` branch of compileGlob's
    // globstar handling matches the bare directory name without a
    // trailing slash. Without this, a PR that adds the `docs`
    // directory as a tree-only change (rare but possible) would
    // miss coverage.
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts", "docs"],
      baseConfig,
    )
    expect(out).toBeNull()
  })

  it("caps architectureFiles at 10 (prompt-size safety)", () => {
    const many = Array.from({ length: 25 }, (_, i) => `src/lib/file${i}.ts`)
    const out = runDocsCoverageCheck(many, baseConfig)
    expect(out!.architectureFiles).toHaveLength(10)
  })

  it("doesn't crash on a malformed glob (drops it silently)", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts"],
      { ...baseConfig, architectureGlobs: ["[invalid", "src/lib/**"] },
    )
    expect(out).not.toBeNull()
    expect(out!.architectureFiles).toEqual(["src/lib/foo.ts"])
  })

  it("returns null when EVERY architectureGlob is malformed (effectively empty)", () => {
    const out = runDocsCoverageCheck(
      ["src/lib/foo.ts"],
      { ...baseConfig, architectureGlobs: ["[invalid", "{also-bad"] },
    )
    expect(out).toBeNull()
  })
})

describe("renderDocsCoverageForPrompt", () => {
  it("returns empty string when hit is null (caller joins without conditional)", () => {
    expect(renderDocsCoverageForPrompt(null)).toBe("")
  })

  it("renders a complete fact block when given a hit", () => {
    const out = renderDocsCoverageForPrompt({
      architectureFiles: ["src/lib/foo.ts", "wrangler.toml"],
      docPaths: ["README.md", "docs/**"],
    })
    expect(out).toContain("[DOCS COVERAGE")
    expect(out).toContain("touches architecture-impacting files")
    expect(out).toContain("`src/lib/foo.ts`")
    expect(out).toContain("`wrangler.toml`")
    expect(out).toContain("`README.md`")
    expect(out).toContain("`docs/**`")
    expect(out).toContain("`category: docs`")
    expect(out).toContain("severity `low`")
  })
})

describe("resolveDocsReviewConfig", () => {
  it("defaults to enabled=true with empty architectureGlobs (no-op until operator opts in)", () => {
    const out = resolveDocsReviewConfig(null)
    expect(out.enabled).toBe(true)
    expect(out.architectureGlobs).toEqual([])
    expect(out.docPaths.length).toBeGreaterThan(0)
  })

  it("honors explicit enabled=false (kill switch)", () => {
    const out = resolveDocsReviewConfig({ docsReview: { enabled: false } })
    expect(out.enabled).toBe(false)
  })

  it("uses operator-provided architectureGlobs", () => {
    const out = resolveDocsReviewConfig({
      docsReview: { architectureGlobs: ["src/**"] },
    })
    expect(out.architectureGlobs).toEqual(["src/**"])
  })

  it("uses operator-provided docPaths, replacing defaults", () => {
    const out = resolveDocsReviewConfig({
      docsReview: { docPaths: ["MY-CUSTOM-DOC.md"] },
    })
    expect(out.docPaths).toEqual(["MY-CUSTOM-DOC.md"])
  })
})
