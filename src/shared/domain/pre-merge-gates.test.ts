// SIG-100 — pre-merge quality gates tests.

import { describe, it, expect } from "vitest"
import {
  DEFAULT_PRE_MERGE_GATES_CONFIG,
  evaluateDescriptionCompletenessGate,
  evaluateLinkedIssueGate,
  evaluateTitleFormatGate,
  renderPreMergeGatesSection,
  runPreMergeGates,
  type ResolvedPreMergeGatesConfig,
} from "@/src/shared/domain/pre-merge-gates"
import { resolvePreMergeGatesConfig } from "@/src/lib/sigilix-config"

describe("evaluateTitleFormatGate", () => {
  const cfg = DEFAULT_PRE_MERGE_GATES_CONFIG.titleFormat

  it("passes Conventional Commits subject", () => {
    expect(evaluateTitleFormatGate("feat: add foo", cfg).passed).toBe(true)
  })

  it("passes Conventional Commits with scope", () => {
    expect(evaluateTitleFormatGate("fix(auth): handle null token", cfg).passed).toBe(true)
  })

  it("passes breaking-change marker (!)", () => {
    expect(evaluateTitleFormatGate("feat(api)!: drop v1 endpoints", cfg).passed).toBe(true)
  })

  it("passes every documented type token (feat/fix/chore/docs/refactor/test/perf/style/build/ci/revert)", () => {
    for (const t of ["feat", "fix", "chore", "docs", "refactor", "test", "perf", "style", "build", "ci", "revert"]) {
      expect(evaluateTitleFormatGate(`${t}: subject`, cfg).passed).toBe(true)
    }
  })

  it("fails when type is unknown (e.g. `random:`)", () => {
    const r = evaluateTitleFormatGate("random: subject", cfg)
    expect(r.passed).toBe(false)
    expect(r.message).toContain("doesn't match")
  })

  it("fails when there is no colon separator", () => {
    expect(evaluateTitleFormatGate("feat add foo", cfg).passed).toBe(false)
  })

  it("fails when title is empty / whitespace", () => {
    expect(evaluateTitleFormatGate("", cfg).passed).toBe(false)
    expect(evaluateTitleFormatGate("   ", cfg).passed).toBe(false)
  })

  it("fails OPEN when the regex itself is malformed (anti-foot-gun)", () => {
    const broken: typeof cfg = { ...cfg, regex: "(unbalanced[" }
    expect(evaluateTitleFormatGate("anything", broken).passed).toBe(true)
  })

  it("respects an operator-supplied regex override", () => {
    const strict: typeof cfg = { ...cfg, regex: "^[A-Z]{2,5}-\\d+: .+" }
    expect(evaluateTitleFormatGate("SIG-100: gates", strict).passed).toBe(true)
    expect(evaluateTitleFormatGate("feat: foo", strict).passed).toBe(false)
  })

  it("inherits severity from config", () => {
    const err: typeof cfg = { ...cfg, severity: "error" }
    expect(evaluateTitleFormatGate("nope", err).severity).toBe("error")
  })

  // SIG-100 — CR catch on PR #111: ReDoS defense via input-length cap.
  // The operator regex runs on at most 1024 chars of title, so even a
  // pathological backtracking pattern can't run unbounded on an
  // adversarially-long title.
  it("caps input length before running the operator regex (ReDoS defense)", () => {
    // A 10KB title that ends with a non-matching suffix. With no cap
    // + a backtracking-prone pattern the test could run for seconds.
    // With the 1024-char cap the worst case is bounded.
    const huge = "feat: " + "a".repeat(10_000) + "_NO_MATCH_TAIL"
    const start = Date.now()
    const out = evaluateTitleFormatGate(huge, cfg)
    const elapsed = Date.now() - start
    // The default regex matches anything that starts with `feat:` + at
    // least one char, so `feat: aaaa...` passes regardless of suffix.
    expect(out.passed).toBe(true)
    // Defensive: even on the slowest CI box this should finish in <500ms.
    expect(elapsed).toBeLessThan(500)
  })
})

describe("evaluateDescriptionCompletenessGate", () => {
  const cfg = DEFAULT_PRE_MERGE_GATES_CONFIG.descriptionCompleteness

  it("passes when body meets the minLength threshold", () => {
    const body = "This PR fixes a bug in the auth layer where tokens leaked."
    expect(evaluateDescriptionCompletenessGate(body, cfg).passed).toBe(true)
  })

  it("passes when body has all template sections (even if short)", () => {
    const body = "## Summary\nfoo\n## Test plan\nbar"
    expect(evaluateDescriptionCompletenessGate(body, cfg).passed).toBe(true)
  })

  it("fails on a placeholder body that misses both bars", () => {
    const r = evaluateDescriptionCompletenessGate("wip", cfg)
    expect(r.passed).toBe(false)
    expect(r.message).toContain("Missing required sections")
  })

  it("fails listing which template sections are missing", () => {
    const r = evaluateDescriptionCompletenessGate("## Summary\nfoo", cfg)
    expect(r.passed).toBe(false)
    expect(r.message).toContain("`## Test plan`")
    expect(r.message).not.toContain("`## Summary`")
  })

  it("matches template sections case-insensitively + tolerant of trim", () => {
    const body = "##  summary\nfoo\n  ## Test Plan  \nbar"
    expect(evaluateDescriptionCompletenessGate(body, cfg).passed).toBe(true)
  })

  it("treats null/undefined body as failing", () => {
    // @ts-expect-error — runtime guard against non-string
    expect(evaluateDescriptionCompletenessGate(null, cfg).passed).toBe(false)
  })

  it("falls back to a chars-only check when template is empty", () => {
    const tlessCfg: typeof cfg = { ...cfg, template: [] }
    expect(evaluateDescriptionCompletenessGate("short", tlessCfg).passed).toBe(false)
    expect(evaluateDescriptionCompletenessGate("x".repeat(50), tlessCfg).passed).toBe(true)
  })

  it("the chars threshold counts non-whitespace only (avoids ascii-art bypass)", () => {
    // 50 newlines = 0 non-whitespace chars → still fails minLength.
    const padded = "\n".repeat(50) + "ok"
    expect(evaluateDescriptionCompletenessGate(padded, cfg).passed).toBe(false)
  })
})

describe("evaluateLinkedIssueGate", () => {
  const cfg = DEFAULT_PRE_MERGE_GATES_CONFIG.linkedIssue

  it("passes on `Closes #42` in body", () => {
    expect(evaluateLinkedIssueGate("Body text. Closes #42.", [], cfg).passed).toBe(true)
  })

  it("passes on `Fixes SIG-100` in body", () => {
    expect(evaluateLinkedIssueGate("Fixes SIG-100", [], cfg).passed).toBe(true)
  })

  it("passes on `Resolves owner/repo#7` (fully qualified)", () => {
    expect(evaluateLinkedIssueGate("Resolves Sigilix/sigilix#7", [], cfg).passed).toBe(true)
  })

  it("is case-insensitive on the keyword", () => {
    expect(evaluateLinkedIssueGate("closes #1", [], cfg).passed).toBe(true)
    expect(evaluateLinkedIssueGate("FIXES SIG-7", [], cfg).passed).toBe(true)
  })

  it("passes on a keyword in commit messages (not the body)", () => {
    expect(evaluateLinkedIssueGate("desc", ["fix: handle null\n\nFixes #99"], cfg).passed).toBe(true)
  })

  it("fails when neither body nor commits mention an auto-close keyword", () => {
    const r = evaluateLinkedIssueGate("Body text. References #42.", ["fix: subject"], cfg)
    expect(r.passed).toBe(false)
    expect(r.message).toContain("Closes")
  })

  it("does NOT match the keyword inside a bigger word (avoids `disclose` false-positive)", () => {
    expect(evaluateLinkedIssueGate("Did not disclose #42 yet.", [], cfg).passed).toBe(false)
  })

  it("requires a number after the keyword (no #N → no link)", () => {
    expect(evaluateLinkedIssueGate("Closes the discussion", [], cfg).passed).toBe(false)
  })
})

describe("runPreMergeGates", () => {
  it("runs every enabled gate in canonical order", () => {
    const results = runPreMergeGates(
      {
        prTitle: "feat: foo",
        prBody: "## Summary\nf\n## Test plan\nt",
        commitMessages: ["Closes #1"],
      },
      DEFAULT_PRE_MERGE_GATES_CONFIG,
    )
    expect(results.map((r) => r.id)).toEqual(["titleFormat", "descriptionCompleteness", "linkedIssue"])
    expect(results.every((r) => r.passed)).toBe(true)
  })

  it("skips disabled gates entirely (not rendered as 'passed' — silence)", () => {
    const cfg: ResolvedPreMergeGatesConfig = {
      titleFormat: { ...DEFAULT_PRE_MERGE_GATES_CONFIG.titleFormat, enabled: false },
      descriptionCompleteness: DEFAULT_PRE_MERGE_GATES_CONFIG.descriptionCompleteness,
      linkedIssue: { ...DEFAULT_PRE_MERGE_GATES_CONFIG.linkedIssue, enabled: false },
    }
    const results = runPreMergeGates(
      { prTitle: "bad", prBody: "## Summary\nf\n## Test plan\nt", commitMessages: [] },
      cfg,
    )
    expect(results.map((r) => r.id)).toEqual(["descriptionCompleteness"])
  })

  it("ALL gates disabled → empty result set → render skipped", () => {
    const cfg: ResolvedPreMergeGatesConfig = {
      titleFormat: { ...DEFAULT_PRE_MERGE_GATES_CONFIG.titleFormat, enabled: false },
      descriptionCompleteness: {
        ...DEFAULT_PRE_MERGE_GATES_CONFIG.descriptionCompleteness,
        enabled: false,
      },
      linkedIssue: { ...DEFAULT_PRE_MERGE_GATES_CONFIG.linkedIssue, enabled: false },
    }
    const results = runPreMergeGates({ prTitle: "feat: foo", prBody: "body", commitMessages: [] }, cfg)
    expect(results).toEqual([])
    expect(renderPreMergeGatesSection(results)).toBeNull()
  })
})

describe("renderPreMergeGatesSection", () => {
  const cfg = DEFAULT_PRE_MERGE_GATES_CONFIG

  it("returns null when there are no results", () => {
    expect(renderPreMergeGatesSection([])).toBeNull()
  })

  it("renders a heading + one checklist line per result", () => {
    const out = renderPreMergeGatesSection(
      runPreMergeGates(
        {
          prTitle: "feat: foo",
          prBody: "## Summary\nf\n## Test plan\nt",
          commitMessages: ["Closes #1"],
        },
        cfg,
      ),
    )!
    expect(out).toContain("### Quality gates")
    expect(out.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3)
  })

  it("uses ✅ for passing gates", () => {
    const out = renderPreMergeGatesSection(
      runPreMergeGates(
        {
          prTitle: "feat: foo",
          prBody: "## Summary\nf\n## Test plan\nt",
          commitMessages: ["Closes #1"],
        },
        cfg,
      ),
    )!
    expect(out).toContain("✅")
  })

  it("uses ⚠️  for warning-severity failures and ℹ️  for info-severity failures", () => {
    // Default: titleFormat / descriptionCompleteness = warning;
    // linkedIssue = info. Bad title + missing template + no
    // linked-issue → ⚠️ × 2 + ℹ️ × 1.
    const out = renderPreMergeGatesSection(
      runPreMergeGates({ prTitle: "nope", prBody: "wip", commitMessages: [] }, cfg),
    )!
    expect((out.match(/⚠️/g) ?? []).length).toBe(2)
    expect((out.match(/ℹ️/g) ?? []).length).toBe(1)
  })

  it("uses ❌ for error-severity failures", () => {
    const cfgErr: ResolvedPreMergeGatesConfig = {
      ...cfg,
      titleFormat: { ...cfg.titleFormat, severity: "error" },
    }
    const out = renderPreMergeGatesSection(
      runPreMergeGates(
        {
          prTitle: "nope",
          prBody: "## Summary\nf\n## Test plan\nt",
          commitMessages: ["Closes #1"],
        },
        cfgErr,
      ),
    )!
    expect(out).toContain("❌")
  })

  it("renders the failure message inline after the label", () => {
    const out = renderPreMergeGatesSection(
      runPreMergeGates({ prTitle: "nope", prBody: "wip", commitMessages: [] }, cfg),
    )!
    expect(out).toContain("PR title follows convention — Title doesn't match")
    expect(out).toContain("PR description is complete — Missing required sections")
  })
})

describe("resolvePreMergeGatesConfig", () => {
  it("returns the locked defaults when partial is undefined", () => {
    const r = resolvePreMergeGatesConfig(undefined)
    expect(r).toEqual(DEFAULT_PRE_MERGE_GATES_CONFIG)
  })

  it("returns the locked defaults when partial is an empty object", () => {
    const r = resolvePreMergeGatesConfig({})
    expect(r).toEqual(DEFAULT_PRE_MERGE_GATES_CONFIG)
  })

  it("merges per-gate overrides while preserving defaults for unset sub-gates", () => {
    const r = resolvePreMergeGatesConfig({
      linkedIssue: { enabled: false },
    })
    expect(r.linkedIssue.enabled).toBe(false)
    expect(r.linkedIssue.severity).toBe(DEFAULT_PRE_MERGE_GATES_CONFIG.linkedIssue.severity)
    expect(r.titleFormat).toEqual(DEFAULT_PRE_MERGE_GATES_CONFIG.titleFormat)
  })

  it("merges per-field overrides within a sub-gate (regex without touching enabled)", () => {
    const r = resolvePreMergeGatesConfig({
      titleFormat: { regex: "^WIP: .+" },
    })
    expect(r.titleFormat.regex).toBe("^WIP: .+")
    expect(r.titleFormat.enabled).toBe(true) // default preserved
    expect(r.titleFormat.severity).toBe("warning") // default preserved
  })

  it("allows overriding minLength + template on descriptionCompleteness", () => {
    const r = resolvePreMergeGatesConfig({
      descriptionCompleteness: { minLength: 100, template: ["## Why"] },
    })
    expect(r.descriptionCompleteness.minLength).toBe(100)
    expect(r.descriptionCompleteness.template).toEqual(["## Why"])
  })
})
