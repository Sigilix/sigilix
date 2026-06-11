// Shared fixtures for the validate-test-finding.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { TestingEvidencePack } from "@/src/lib/testing-evidence-pack"

// Allow tests to pass explicit `undefined` for the optional citation fields
// (exercising the "no evidenceRefs / no inspectedTestFiles" path) under
// exactOptionalPropertyTypes.
type FindingOverrides = Omit<Partial<PrReviewFinding>, "evidenceRefs" | "inspectedTestFiles"> & {
  evidenceRefs?: string[] | undefined
  inspectedTestFiles?: string[] | undefined
}

export function finding(overrides: FindingOverrides = {}): PrReviewFinding {
  const base: PrReviewFinding = {
    path: "src/lib/foo.ts",
    line: 17,
    score: 4,
    category: "testing",
    headline: "New `parseConfig` export ships without tests",
    body: "The new `parseConfig` function has no sibling test file in this PR; its error path is untested.",
    evidenceRefs: ["siblingMapping:src/lib/foo.ts->NONE"],
  }
  // Apply overrides, dropping any explicit `undefined` so the result stays a
  // valid PrReviewFinding under exactOptionalPropertyTypes (an explicit
  // `evidenceRefs: undefined` means "no citation", identical to omitting it).
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete (base as unknown as Record<string, unknown>)[key]
    else (base as unknown as Record<string, unknown>)[key] = value
  }
  return base
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
