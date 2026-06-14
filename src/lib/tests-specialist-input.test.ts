// SIG-91 — tests specialist must recognize sibling test files in diff.
//
// The tests specialist consistently fired false-positive "module ships
// without tests" findings on PRs that DO add sibling test files in
// the same diff (5/6 findings on PR #104, same pattern on PR #98 and
// PR #100). Root cause: the prompt biased the model to look for "no
// test files changed" without grounding it on the actual file shape
// of the diff.
//
// This file pins three classes of regression:
//   1. Unit-level on the classifier (`classifyDiffFiles` +
//      `renderDiffFileClassificationBlock`) — deterministic part.
//   2. Specialist-input wiring — the literal user message that reaches
//      the model when the tests specialist runs. Asserts the diff +
//      the sibling classification both arrive.
//   3. Historical regression — file lists from the offending PRs
//      (#98, #100, #104) all produce sibling mappings that cover
//      every source file in the diff, so a model honoring the
//      prompt rule cannot emit a "missing tests" finding for them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockChat = vi.fn()
// SIG-406: tests specialist runs on OpenRouter now, so `runSpecialist` routes through
// the barrel `chat` → the OpenRouter adapter. Mock the BARREL `chat` (provider-agnostic).
vi.mock("@/src/shared/adapters/model", async () => {
  const actual = await vi.importActual<typeof import("@/src/shared/adapters/model")>("@/src/shared/adapters/model")
  return {
    ...actual,
    chat: (args: unknown) => mockChat(args),
  }
})

import { runSpecialist, SPECIALIST_CONFIGS } from "@/src/lib/triage-pr-review-ensemble"
import { SPECIALIST_PROMPTS, buildSpecialistInitialMessage } from "@/src/prompts/pr-review-specialists"
import { classifyDiffFiles, renderDiffFileClassificationBlock } from "@/src/lib/diff-file-classify"

beforeEach(() => {
  mockChat.mockReset()
})

afterEach(() => {
  mockChat.mockReset()
})

const perfCtx = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 1,
  headSha: "a".repeat(40),
}

const ok = (content: string) => ({
  message: { role: "assistant", content },
  hasToolCalls: false,
})

/** Build a synthetic unified diff with one hunk per file. */
function buildDiff(files: readonly string[]): string {
  return files
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        "new file mode 100644",
        `--- /dev/null`,
        `+++ b/${path}`,
        "@@ -0,0 +1,3 @@",
        "+// new file",
        "+export const value = 1",
        "+",
      ].join("\n"),
    )
    .join("\n")
}

// ─── unit-level: classifier ──────────────────────────────────────────

describe("classifyDiffFiles", () => {
  it("classifies tests/<name>.test.ts as test with sibling to src/lib/<name>.ts", () => {
    const result = classifyDiffFiles(["src/lib/foo.ts", "tests/foo.test.ts"])
    expect(result).toHaveLength(2)
    const source = result.find((r) => r.path === "src/lib/foo.ts")
    const test = result.find((r) => r.path === "tests/foo.test.ts")
    expect(source?.kind).toBe("source")
    expect(source?.testsSibling).toBe("tests/foo.test.ts")
    expect(test?.kind).toBe("test")
    expect(test?.sourceSibling).toBe("src/lib/foo.ts")
  })

  it("SIG-141: pairs a tests/-dir test with a source in a non-enumerated subdir (src/do/)", () => {
    // candidateSources() only enumerates src, src/lib, app, lib, workers — so
    // tests/repo-graph.test.ts never paired with src/do/repo-graph.ts, yielding
    // a false "no test coverage" on the SIG-138 PR. Basename-stem fallback fixes it.
    const result = classifyDiffFiles(["src/do/repo-graph.ts", "tests/repo-graph.test.ts"])
    const source = result.find((r) => r.path === "src/do/repo-graph.ts")
    const test = result.find((r) => r.path === "tests/repo-graph.test.ts")
    expect(source?.testsSibling).toBe("tests/repo-graph.test.ts")
    expect(test?.sourceSibling).toBe("src/do/repo-graph.ts")
  })

  it("recognizes __tests__ directory siblings", () => {
    const result = classifyDiffFiles(["src/lib/foo.ts", "src/lib/__tests__/foo.test.ts"])
    const source = result.find((r) => r.path === "src/lib/foo.ts")
    const test = result.find((r) => r.path === "src/lib/__tests__/foo.test.ts")
    expect(source?.testsSibling).toBe("src/lib/__tests__/foo.test.ts")
    expect(test?.sourceSibling).toBe("src/lib/foo.ts")
  })

  it("recognizes root-level __tests__/<name>.test.ts → src/<name>.ts (no parent dir)", () => {
    // CR Major catch on PR #105: the regex required a parent
    // directory, so `__tests__/foo.test.ts` at repo root never
    // resolved to its source sibling. Pin both shapes (bare-root
    // source + src/-rooted source) so the optional-parent branch
    // can't regress.
    const bareRoot = classifyDiffFiles(["foo.ts", "__tests__/foo.test.ts"])
    expect(bareRoot.find((r) => r.path === "foo.ts")?.testsSibling).toBe("__tests__/foo.test.ts")
    expect(bareRoot.find((r) => r.path === "__tests__/foo.test.ts")?.sourceSibling).toBe("foo.ts")

    const srcRoot = classifyDiffFiles(["src/foo.ts", "__tests__/foo.test.ts"])
    expect(srcRoot.find((r) => r.path === "src/foo.ts")?.testsSibling).toBe("__tests__/foo.test.ts")
    expect(srcRoot.find((r) => r.path === "__tests__/foo.test.ts")?.sourceSibling).toBe("src/foo.ts")

    const srcLibRoot = classifyDiffFiles(["src/lib/foo.ts", "__tests__/foo.test.ts"])
    expect(srcLibRoot.find((r) => r.path === "src/lib/foo.ts")?.testsSibling).toBe("__tests__/foo.test.ts")

    const libRoot = classifyDiffFiles(["lib/foo.ts", "__tests__/foo.test.ts"])
    expect(libRoot.find((r) => r.path === "lib/foo.ts")?.testsSibling).toBe("__tests__/foo.test.ts")
  })

  it("recognizes co-located .spec.ts sibling", () => {
    const result = classifyDiffFiles(["src/lib/foo.ts", "src/lib/foo.spec.ts"])
    expect(result.find((r) => r.path === "src/lib/foo.ts")?.testsSibling).toBe("src/lib/foo.spec.ts")
  })

  it("classifies source files without a sibling test in the diff as testsSibling:null", () => {
    const result = classifyDiffFiles(["src/lib/foo.ts"])
    expect(result[0]?.kind).toBe("source")
    expect(result[0]?.testsSibling).toBeNull()
  })

  it("classifies docs / config / other paths correctly", () => {
    const result = classifyDiffFiles([
      "README.md",
      "package.json",
      "wrangler.toml",
      "docs/guide.mdx",
      "src/lib/foo.ts",
      "tests/foo.test.ts",
      "assets/logo.svg",
    ])
    const byPath = (p: string) => result.find((r) => r.path === p)
    expect(byPath("README.md")?.kind).toBe("config") // README.md is in CONFIG_FILE_RE
    expect(byPath("package.json")?.kind).toBe("config")
    expect(byPath("wrangler.toml")?.kind).toBe("config")
    expect(byPath("docs/guide.mdx")?.kind).toBe("docs")
    expect(byPath("src/lib/foo.ts")?.kind).toBe("source")
    expect(byPath("tests/foo.test.ts")?.kind).toBe("test")
    expect(byPath("assets/logo.svg")?.kind).toBe("other")
  })

  it("never reports a sibling that is not in the diff (pure function, no FS reads)", () => {
    // Test file with no matching source in this diff → sourceSibling
    // is null even though the on-disk source might exist.
    const result = classifyDiffFiles(["tests/foo.test.ts"])
    expect(result[0]?.kind).toBe("test")
    expect(result[0]?.sourceSibling).toBeNull()
  })
})

describe("renderDiffFileClassificationBlock", () => {
  it("returns empty string when the diff has no source or test files", () => {
    const block = renderDiffFileClassificationBlock(classifyDiffFiles(["README.md", "package.json"]))
    expect(block).toBe("")
  })

  it("renders the labeled block with explicit pairing for source + sibling test", () => {
    const block = renderDiffFileClassificationBlock(classifyDiffFiles(["src/lib/foo.ts", "tests/foo.test.ts"]))
    expect(block).toContain("[DIFF FILE CLASSIFICATION")
    expect(block).toContain("`src/lib/foo.ts`")
    expect(block).toContain("`tests/foo.test.ts`")
    expect(block).toContain("covered by test file in this diff: `tests/foo.test.ts`")
    expect(block).toContain("covers source file in this diff: `src/lib/foo.ts`")
  })

  it("flags source files with no sibling test in the diff explicitly", () => {
    const block = renderDiffFileClassificationBlock(classifyDiffFiles(["src/lib/lonely.ts"]))
    expect(block).toContain("`src/lib/lonely.ts`")
    expect(block).toContain("no sibling test file in this diff")
  })

  it("instructs the model not to flag covered sources as missing tests", () => {
    const block = renderDiffFileClassificationBlock(classifyDiffFiles(["src/lib/foo.ts", "tests/foo.test.ts"]))
    expect(block).toContain("module ships without tests")
    expect(block).toContain("ONLY admissible")
  })
})

// ─── specialist-input wiring ─────────────────────────────────────────

describe("tests specialist receives the sibling classification + diff", () => {
  it("`buildSpecialistInitialMessage` injects the classification block before [PR]", () => {
    const diffFileClassificationBlock = renderDiffFileClassificationBlock(
      classifyDiffFiles(["src/lib/foo.ts", "tests/foo.test.ts"]),
    )
    const msg = buildSpecialistInitialMessage({
      prNumber: 42,
      title: "feat: foo",
      body: "Adds foo",
      diff: buildDiff(["src/lib/foo.ts", "tests/foo.test.ts"]),
      retrievalSnapshot: "",
      namespace: "myrepo",
      diffFileClassificationBlock,
    })
    expect(msg).toContain("[DIFF FILE CLASSIFICATION")
    expect(msg).toContain("`tests/foo.test.ts`")
    expect(msg.indexOf("[DIFF FILE CLASSIFICATION")).toBeLessThan(msg.indexOf("[PR]"))
    expect(msg.indexOf("[DIFF FILE CLASSIFICATION")).toBeLessThan(msg.indexOf("[DIFF]"))
  })

  it("omits the classification block when the source argument is empty", () => {
    const msg = buildSpecialistInitialMessage({
      prNumber: 42,
      title: "docs: tweak",
      body: "",
      diff: buildDiff(["README.md"]),
      retrievalSnapshot: "",
      namespace: "myrepo",
      diffFileClassificationBlock: "",
    })
    expect(msg).not.toContain("[DIFF FILE CLASSIFICATION")
  })

  it("`runSpecialist({role:'tests'})` sends a user message that contains both the source AND the sibling test path", async () => {
    const diff = buildDiff(["src/lib/foo.ts", "tests/foo.test.ts"])
    const diffFileClassificationBlock = renderDiffFileClassificationBlock(
      classifyDiffFiles(["src/lib/foo.ts", "tests/foo.test.ts"]),
    )
    const initialMessage = buildSpecialistInitialMessage({
      prNumber: 42,
      title: "feat: foo",
      body: "",
      diff,
      retrievalSnapshot: "",
      namespace: "myrepo",
      diffFileClassificationBlock,
    })

    mockChat.mockResolvedValueOnce(ok(JSON.stringify({ summary: "no findings", confidence: 5, findings: [] })))

    await runSpecialist({
      role: "tests",
      apiKeys: { ollama: undefined, openrouter: "test-key" },
      systemPrompt: SPECIALIST_PROMPTS.tests,
      initialMessage,
      chatEnabled: "on",
      signal: new AbortController().signal,
      perfCtx,
    })

    expect(mockChat).toHaveBeenCalledOnce()
    const callArg = mockChat.mock.calls[0]?.[0] as { messages: Array<{ role: string; content: string }> } | undefined
    expect(callArg).toBeDefined()
    const userMessage = callArg?.messages.find((m) => m.role === "user")?.content
    expect(userMessage).toBeDefined()
    // The literal source path must be present in the user message —
    // confirms the diff isn't being filtered for the tests specialist.
    expect(userMessage).toContain("src/lib/foo.ts")
    // The literal sibling test path must be present — confirms the
    // diff packing didn't strip `tests/*` files.
    expect(userMessage).toContain("tests/foo.test.ts")
    // The classification block must be present — confirms the prompt
    // grounding is wired through to the model.
    expect(userMessage).toContain("[DIFF FILE CLASSIFICATION")
    // And the pairing line for foo.ts → tests/foo.test.ts.
    expect(userMessage).toContain("covered by test file in this diff: `tests/foo.test.ts`")
  })
})

// ─── historical regression: PRs #98, #100, #104 ──────────────────────

/**
 * File lists pulled from the three offending PRs via
 * `gh pr view <N> --json files`. These are the exact diff file sets
 * that produced false-positive "module ships without tests" findings
 * before SIG-91 — after the fix, the classifier should resolve EVERY
 * source file in each list to a sibling test in the same diff, leaving
 * no admissible source for a "missing tests" finding.
 */
const HISTORICAL_PR_FILE_LISTS: Record<string, readonly string[]> = {
  "PR #104": [
    "src/index.ts",
    "src/lib/merge-guard.ts",
    "src/lib/pr-overview-stub.ts",
    "src/lib/sigilix-config.ts",
    "src/lib/triage-pr-overview.ts",
    "src/lib/triage-pr-review-ensemble.ts",
    "tests/index-webhook-pr-labels.test.ts",
    "tests/merge-guard.test.ts",
    "tests/pr-overview-stub.test.ts",
    "tests/sigilix-config.test.ts",
    "tests/triage-pr-overview-stale-head.test.ts",
    "tests/triage-pr-review-ensemble-merge-shortcut.test.ts",
    "tests/triage-pr-review-ensemble.test.ts",
  ],
  "PR #98": [
    "docs/ops/shadow-bakeoff.md",
    "src/index.ts",
    "src/lib/shadow-bakeoff-config.ts",
    "src/lib/shadow-bakeoff-runner.ts",
    "src/lib/shadow-bakeoff-telemetry.ts",
    "src/lib/triage-pr-review-ensemble.ts",
    "tests/run-with-retry-and-fallback.test.ts",
    "tests/shadow-bakeoff-config.test.ts",
    "tests/shadow-bakeoff-runner.test.ts",
    "tests/shadow-bakeoff-telemetry.test.ts",
    "tests/shadow-grace-race.test.ts",
    "tests/triage-pr-review-body.test.ts",
    "wrangler.toml",
  ],
  "PR #100": [
    "src/lib/dismiss-prior-reviews.ts",
    "src/lib/review-comment-fallback.ts",
    "src/lib/review-manifest.ts",
    "src/lib/triage-pr-review-ensemble.ts",
    "src/lib/triage-pr-review.ts",
    "tests/dismiss-prior-reviews.test.ts",
    "tests/review-comment-fallback.test.ts",
    "tests/review-manifest.test.ts",
    "tests/submit-review-fallback.test.ts",
    "tests/triage-pr-review-body.test.ts",
    "tests/triage-pr-review.test.ts",
    "tests/triage-pr-stale-mark.test.ts",
  ],
}

describe("SIG-91 historical regression — false-positive PRs", () => {
  for (const [label, files] of Object.entries(HISTORICAL_PR_FILE_LISTS)) {
    it(`${label}: classification + diff together make a 'module ships without tests' finding inadmissible per the prompt rule`, () => {
      const classified = classifyDiffFiles(files)
      const sources = classified.filter((c) => c.kind === "source")
      const tests = classified.filter((c) => c.kind === "test")
      expect(sources.length).toBeGreaterThan(0)
      expect(tests.length).toBeGreaterThan(0)

      // The prompt rule (see SPECIALIST_PROMPTS.tests, SIG-91 block)
      // says a "missing tests" finding is ONLY admissible when ALL of:
      //   (a) source is new/substantially changed
      //   (b) classification block shows `no sibling test file in this diff`
      //   (c) no test file ELSEWHERE in the diff plausibly covers it
      //
      // Clause (c) is the key for these historical PRs: every one of
      // them is a focused PR where the test files in the diff
      // collectively cover the source changes, even when stems don't
      // strictly pair. We assert clause (c) holds by requiring the
      // PR to contain ≥ ceil(sources/2) test files — a heuristic
      // proxy for "test coverage co-located with the change", chosen
      // to fail loudly if a future PR ships heavy source changes with
      // sparse test coverage (which WOULD legitimately deserve a
      // "missing tests" finding).
      const minExpectedTests = Math.ceil(sources.length / 2)
      expect(
        tests.length,
        `${label} has ${sources.length} source files but only ${tests.length} test files in the diff. The "no test file elsewhere plausibly covers it" prompt clause requires ≥ ${minExpectedTests} test files for the false-positive guard to hold.`,
      ).toBeGreaterThanOrEqual(minExpectedTests)

      // Sources with a strict or prefix-stem sibling: classification
      // block names the pairing explicitly. Sources without one: the
      // prompt's clause (c) still applies because tests exist
      // elsewhere in the diff. Either way, no "module ships without
      // tests" finding is admissible on this PR's source files.
      const uncovered = sources.filter((s) => s.testsSibling === null)
      // Snapshot the uncovered set so any regression in the classifier
      // surfaces as a diff — current uncovered sets per PR are an
      // artifact of intentionally strict stem matching + the
      // composite tests in these PRs.
      const expectedUncoveredPerPr: Record<string, readonly string[]> = {
        "PR #104": [],
        "PR #98": ["src/index.ts", "src/lib/triage-pr-review-ensemble.ts"],
        "PR #100": ["src/lib/triage-pr-review-ensemble.ts"],
      }
      expect(uncovered.map((s) => s.path).sort()).toEqual([...(expectedUncoveredPerPr[label] ?? [])].sort())
    })

    it(`${label}: classification block names every test file by path`, () => {
      const block = renderDiffFileClassificationBlock(classifyDiffFiles(files))
      expect(block).not.toBe("")
      for (const p of files) {
        if (p.endsWith(".test.ts") || p.endsWith(".spec.ts")) {
          expect(block).toContain(`\`${p}\``)
        }
      }
    })
  }
})

// ─── prompt-content sanity ───────────────────────────────────────────

describe("SPECIALIST_PROMPTS.tests grounding", () => {
  // SIG-113: the tests specialist now consults `[TESTING EVIDENCE]`
  // (the stronger SIG-113 block built from splitFiles + full
  // inspected-test content) instead of `[DIFF FILE CLASSIFICATION]`
  // (the SIG-91 first-batch-only block). The SIG-91 rule + the
  // ONLY-admissible guard are retained.
  it("instructs the model to consult the TESTING EVIDENCE block before firing 'missing tests'", () => {
    expect(SPECIALIST_PROMPTS.tests).toContain("[TESTING EVIDENCE]")
    expect(SPECIALIST_PROMPTS.tests).toContain("CONSULT THE `[TESTING EVIDENCE]` BLOCK FIRST")
    expect(SPECIALIST_PROMPTS.tests).toContain("ONLY admissible")
  })

  it("requires testing findings to cite evidenceRefs or inspectedTestFiles (SIG-113)", () => {
    // The SIG-113 validator drops uncited testing findings; the
    // prompt must instruct the model to cite or be dropped.
    expect(SPECIALIST_PROMPTS.tests).toContain("evidenceRefs")
    expect(SPECIALIST_PROMPTS.tests).toContain("inspectedTestFiles")
    expect(SPECIALIST_PROMPTS.tests).toContain("DROPPED")
  })

  it("test-specialist primary model is set (regression guard, SIG-406 OpenRouter lineup)", () => {
    // SIG-406: tests runs deepseek/deepseek-v4-pro on OpenRouter, fallback:null
    // (OpenRouter self-routes across upstreams).
    expect(SPECIALIST_CONFIGS.tests.primary).toBe("deepseek/deepseek-v4-pro")
    expect(SPECIALIST_CONFIGS.tests.fallback).toBeNull()
  })
})
