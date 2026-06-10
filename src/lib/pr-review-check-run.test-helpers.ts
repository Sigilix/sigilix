// Shared fixtures for the pr-review-check-run.*.test.ts sibling suites.
// Not a `*.test.ts` file, so vitest does not treat it as a suite (the
// vitest `include` glob is `src/**/*.test.ts`).
//
// NB: the per-file `vi.hoisted` mock fns + `vi.mock` factories +
// `beforeEach`/`afterEach` are NOT here — vitest hoists `vi.mock` per
// file and mock state does not cross files, so each sibling declares
// them inline.

import type { Env } from "@/shared/types/env"

export function makeEnv(opts: { credentials?: boolean } = {}): Env {
  const haveCreds = opts.credentials ?? true
  return {
    OPENCLAW_STATE: {
      async get(): Promise<string | null> { return null },
      async put(): Promise<void> { /* no-op */ },
      async delete(): Promise<void> { /* no-op */ },
    },
    GITHUB_APP_ID: haveCreds ? "12345" : undefined,
    GITHUB_PRIVATE_KEY: haveCreds ? "fake-key" : undefined,
  } as unknown as Env
}

export const baseArgs = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  headSha: "a".repeat(40),
  installationId: 99,
}
