// SIG-344 deterministic tests for the tests-overfire eval scorer.

import { describe, expect, it } from "vitest"
import { SPECIALIST_PROMPTS } from "@/src/prompts/pr-review-specialists"
import {
  TESTS_OVERFIRE_CASES,
  applyCurrentTestGate,
  scoreCase,
  stablePromptHash,
  type TestsScoredFinding,
} from "./tests-overfire-corpus"

const EXPECTED_TESTS_PROMPT_HASH = "8bec6266" // SIG-485: shared-constraint carve-out for secret/PII-in-log (CWE-532, score-3 security)

const branchCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "real-missing-branch-assertion")!
const docsCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "safe-docs-only-release-note")!
const securityCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "safe-security-vulnerability-not-tests")!
const vagueCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "safe-vague-needs-more-tests")!
const parseCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "real-parser-coercion-untested")!
const deletedCase = TESTS_OVERFIRE_CASES.find((c) => c.id === "real-deleted-regression-coverage")!

describe("tests-overfire corpus", () => {
  it("pins the tests-specialist prompt hash so frozen evidence blocks cannot silently drift", () => {
    expect(stablePromptHash(SPECIALIST_PROMPTS.tests)).toBe(EXPECTED_TESTS_PROMPT_HASH)
  })

  it("keeps live corpus labels balanced enough to report recall and FP rate", () => {
    expect(TESTS_OVERFIRE_CASES.filter((c) => c.label === "vuln").length).toBeGreaterThanOrEqual(4)
    expect(TESTS_OVERFIRE_CASES.filter((c) => c.label === "safe").length).toBeGreaterThanOrEqual(4)
  })
})

describe("tests-overfire raw scoring oracle", () => {
  it("counts a concrete missing-branch tests finding as recall without consulting the production gate", () => {
    const finding: TestsScoredFinding = {
      path: branchCase.path,
      line: branchCase.targetLine,
      score: 4,
      category: "testing",
      headline: "`retryWithBackoff` never tests the timeout branch",
      body: "The sibling test only covers success; add a rejection assertion for the timeout branch.",
      inspectedTestFiles: ["tests/retry.test.ts"],
    }

    expect(scoreCase(branchCase, [finding]).caught).toBe(true)
  })

  it("treats docs-only high-severity testing output as a false positive", () => {
    const finding: TestsScoredFinding = {
      path: docsCase.path,
      line: docsCase.targetLine,
      score: 4,
      category: "testing",
      headline: "Docs update needs tests",
      body: "The release note should include tests.",
    }

    expect(scoreCase(docsCase, [finding]).falsePositive).toBe(true)
  })

  it("does not count an explicit security finding as a tests-specialist false positive", () => {
    const securityFinding: TestsScoredFinding = {
      path: securityCase.path,
      line: securityCase.targetLine,
      score: 5,
      category: "security",
      headline: "Unsanitized HTML reaches `dangerouslySetInnerHTML`",
      body: "This is a direct XSS sink.",
    }
    const testsDuplicate: TestsScoredFinding = {
      path: securityCase.path,
      line: securityCase.targetLine,
      score: 4,
      category: "testing",
      headline: "`dangerouslySetInnerHTML` ships without coverage",
      body: "Add a test proving this XSS sink is safe.",
    }

    expect(scoreCase(securityCase, [securityFinding]).falsePositive).toBe(false)
    expect(scoreCase(securityCase, [testsDuplicate]).falsePositive).toBe(true)
  })
})

describe("tests-overfire current production gate view", () => {
  it("drops a vague high-severity needs-more-tests finding from the post-gate surface", () => {
    const finding: TestsScoredFinding = {
      path: vagueCase.path,
      line: vagueCase.targetLine,
      score: 4,
      category: "testing",
      headline: "Module needs more tests",
      body: "This module could use additional tests to improve coverage overall.",
      inspectedTestFiles: ["tests/retry.test.ts"],
    }

    expect(scoreCase(vagueCase, [finding]).falsePositive).toBe(true)
    expect(applyCurrentTestGate(vagueCase, [finding])).toEqual([])
    expect(scoreCase(vagueCase, applyCurrentTestGate(vagueCase, [finding])).falsePositive).toBe(false)
  })

  it("drops a missing-coverage finding that cites the wrong sibling mapping", () => {
    const finding: TestsScoredFinding = {
      path: parseCase.path,
      line: parseCase.targetLine,
      score: 4,
      category: "testing",
      headline: "`parseKind` ships without tests",
      body: "The coercion behavior has no sibling coverage.",
      evidenceRefs: ["siblingMapping:src/lib/other.ts->NONE"],
    }

    expect(scoreCase(parseCase, [finding]).caught).toBe(true)
    expect(applyCurrentTestGate(parseCase, [finding])).toEqual([])
  })

  it("keeps a deleted-test regression finding that cites testFileChanged", () => {
    const finding: TestsScoredFinding = {
      path: deletedCase.path,
      line: deletedCase.targetLine,
      score: 4,
      category: "testing",
      headline: "PR removes refund regression coverage",
      body: "The deleted refund test was the only negative-amount assertion.",
      evidenceRefs: ["testFileChanged:tests/refunds.test.ts"],
    }

    expect(scoreCase(deletedCase, [finding]).caught).toBe(true)
    expect(applyCurrentTestGate(deletedCase, [finding])).toEqual([finding])
  })
})
