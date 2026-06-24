import { describe, it, expect, vi } from "vitest"

// The heavy persistence adapters are mocked to no-op spies so this unit isolates the tail's
// orchestration (reviewId threading, AST auto-inline, fleet contribution). contributeFindingsToFleet
// + the fleet store stay REAL so the SIG-507 hook is exercised end-to-end against a KV mock.
vi.mock("@/src/lib/ensemble/adapters/persistence", () => ({ writeReviewManifestForEnsemble: vi.fn(async () => {}) }))
vi.mock("@/src/lib/incremental-review", () => ({ writeLastReviewedSha: vi.fn(async () => {}) }))
vi.mock("@/src/lib/noop-merge-detect", () => ({ recordReviewedDiffHash: vi.fn(async () => {}) }))
vi.mock("@/src/lib/ensemble/adapters/incremental-coverage", () => ({
  writeIncrementalReviewCoverage: vi.fn(async () => {}),
}))

import { persistSubmittedReview, type PersistSubmittedReviewDeps } from "@/src/lib/ensemble/app/publish-finalize"
import { writeReviewManifestForEnsemble } from "@/src/lib/ensemble/adapters/persistence"
import { readAggregate } from "@/src/lib/fleet/fleet-store"
import { isEligible } from "@/src/shared/domain/fleet-aggregate"
import type { Env } from "@/src/shared/types/env"
import type { GitHubClient } from "@/src/shared/adapters/github"
import type { PullRequestMeta } from "@/src/shared/types/github"
import type { SigilixConfig } from "@/src/lib/sigilix-config"

function mockEnv() {
  const store = new Map<string, string>()
  const env = {
    OPENCLAW_STATE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v)
      },
    },
  } as unknown as Env
  return { env, store }
}

function makeDeps(env: Env, over: Partial<PersistSubmittedReviewDeps> = {}): PersistSubmittedReviewDeps {
  return {
    env,
    client: {} as unknown as GitHubClient,
    owner: "acme",
    repo: "site",
    prNumber: 1,
    headSha: "sha",
    repoId: undefined,
    meta: {} as unknown as PullRequestMeta,
    reviewManifestEnabled: true as unknown as PersistSubmittedReviewDeps["reviewManifestEnabled"],
    currentFindingsForManifest: [
      {
        key: "f1",
        path: "src/x.ts",
        consensus: 1,
        headline: "SQL injection in handler",
        score: 5,
        category: "security",
      },
    ],
    fullPrDiff: "diff",
    sigilixConfig: {} as SigilixConfig, // default → contribute enabled
    maybePostAstAutoInline: async () => {},
    ...over,
  }
}

describe("persistSubmittedReview", () => {
  it("threads the confirmed reviewId into the manifest write and runs the AST auto-inline", async () => {
    const { env } = mockEnv()
    const ast = vi.fn(async () => {})
    await persistSubmittedReview(makeDeps(env, { maybePostAstAutoInline: ast }), 4242)
    expect(writeReviewManifestForEnsemble).toHaveBeenCalledWith(expect.objectContaining({ reviewId: 4242 }))
    expect(ast).toHaveBeenCalledTimes(1)
  })

  it("contributes findings to the fleet (SIG-507 hook fires from the persistence tail)", async () => {
    const { env } = mockEnv()
    // Five distinct orgs review the same pattern → crosses the K=5 k-anonymity gate.
    for (let i = 0; i < 5; i++) await persistSubmittedReview(makeDeps(env, { owner: `org-${i}` }), i)
    const agg = await readAggregate(env, "security:sql-injection")
    expect(agg).not.toBeNull()
    expect(isEligible(agg!)).toBe(true)
  })

  it("respects the per-repo fleet opt-out (no contribution)", async () => {
    const { env, store } = mockEnv()
    await persistSubmittedReview(makeDeps(env, { sigilixConfig: { fleet: { contribute: false } } as SigilixConfig }), 1)
    expect([...store.keys()].some((k) => k.startsWith("fleet:agg:"))).toBe(false)
  })
})
