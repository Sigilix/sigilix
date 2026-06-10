// Shared fixtures for the validate-test-finding.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).

import type { PrReviewFinding } from "@/lib/triage-pr-review"
import type { TestingEvidencePack } from "@/lib/testing-evidence-pack"

export function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/lib/foo.ts",
    line: 17,
    score: 4,
    category: "testing",
    headline: "New `parseConfig` export ships without tests",
    body: "The new `parseConfig` function has no sibling test file in this PR; its error path is untested.",
    evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
    ...overrides,
  }
}

export function pack(overrides: Partial<TestingEvidencePack> = {}): TestingEvidencePack {
  return {
    sourceFilesChanged: ["src/lib/foo.ts"],
    testFilesChanged: [],
    testFilesInPromptDiff: [],
    testFilesNotInPromptDiff: [],
    siblingMappings: [{ source: "src/lib/foo.ts", test: null }],
    inspectedTestFiles: [],
    helperCoverageBySource: {},
    ...overrides,
  }
}
