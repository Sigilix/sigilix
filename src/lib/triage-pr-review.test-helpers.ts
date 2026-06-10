// Shared fixtures for the triage-pr-review.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).
//
// NB: unlike the `*.test.ts` files (which tsconfig excludes from
// `tsc --noEmit`), this module IS typechecked. The original inline
// `baseFinding` literal deliberately omitted `category` (it was never
// typechecked); we preserve that exact runtime object — no fields added
// or removed — and assert the type so consumers are unchanged.

import type { PrReviewFinding } from "@/src/lib/triage-pr-review"

export const baseFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 3,
  headline: "missing null guard on `user.profile`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
} as unknown as PrReviewFinding
