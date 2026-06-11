// Shared fixtures for the triage-pr-review-ensemble.*.test.ts sibling
// suites. Not a `*.test.ts` file, so vitest does not treat it as a
// suite (the vitest `include` glob is `src/**/*.test.ts`).

import { type PrReviewVerdict, type PrReviewFinding } from "@/src/lib/triage-pr-review"
import type { Env } from "@/src/shared/types/env"

export const baseFinding: PrReviewFinding = {
  path: "src/lib/foo.ts",
  line: 42,
  score: 4,
  category: "logic",
  headline: "off-by-one in `clampIndex`",
  body: "Wrap with `if (!user) return` before accessing `user.profile`.",
}

export const baseVerdict: PrReviewVerdict = {
  summary: "One real bug.",
  confidence: 4,
  confidenceReason: "Clear off-by-one.",
  findings: [baseFinding],
}

export function makeCounterEnv(store = new Map<string, string>(), puts: Array<[string, string]> = []): Env {
  return {
    OPENCLAW_STATE: {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null
      },
      async put(key: string, value: string): Promise<void> {
        puts.push([key, value])
        store.set(key, value)
      },
      async delete(key: string): Promise<void> {
        store.delete(key)
      },
    },
  } as unknown as Env
}
