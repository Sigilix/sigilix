// Shared fixtures for the validate-logic-claim-refutation.*.test.ts
// sibling suites. Not a `*.test.ts` file, so vitest does not treat it as
// a suite (the vitest `include` glob is `src/**/*.test.ts`).

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

export function finding(overrides: Partial<PrReviewFinding> = {}): PrReviewFinding {
  return {
    path: "src/x.ts",
    line: 1,
    score: 5,
    category: "logic",
    headline: "",
    body: "",
    ...overrides,
  }
}

export function ctx(path: string, source: string) {
  return { fullFileByPath: new Map([[path, source]]) }
}
