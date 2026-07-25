import { beforeEach, describe, it, expect, vi } from "vitest"

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
import { writeLastReviewedSha } from "@/src/lib/incremental-review"
import { recordReviewedDiffHash } from "@/src/lib/noop-merge-detect"
import { writeIncrementalReviewCoverage } from "@/src/lib/ensemble/adapters/incremental-coverage"
import { readAggregate } from "@/src/lib/fleet/fleet-store"
import { isEligible } from "@/src/shared/domain/fleet-aggregate"
import {
  materializeFindingEvents,
  type FindingEventCapture,
  type PostedFindingCapture,
} from "@/src/lib/ensemble/app/finding-event-capture"
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
    scmProvider: "github",
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

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

  it("keeps GitLab submits out of every GitHub persistence namespace", async () => {
    const { env, store } = mockEnv()
    const ast = vi.fn(async () => {})

    await persistSubmittedReview(
      makeDeps(env, {
        scmProvider: "gitlab",
        repoId: 123,
        incrementalCoverageEntries: [],
        maybePostAstAutoInline: ast,
      }),
      4242,
    )

    expect(ast).toHaveBeenCalledOnce()
    expect(writeReviewManifestForEnsemble).not.toHaveBeenCalled()
    expect(writeLastReviewedSha).not.toHaveBeenCalled()
    expect(writeIncrementalReviewCoverage).not.toHaveBeenCalled()
    expect(recordReviewedDiffHash).not.toHaveBeenCalled()
    expect([...store.keys()].some((key) => key.startsWith("fleet:"))).toBe(false)
  })
})

// SIG-606: the REAL path, not a source grep. A source assertion would still pass if
// the capture block were moved below an early return (e.g. the non-GitHub branch),
// silently killing publish rows.
describe("persistSubmittedReview — SIG-606 finding-event capture", () => {
  it("captures a publish-stage row per survivor, carrying the manifest key", async () => {
    const { env } = mockEnv()
    const findingEventSink: FindingEventCapture[] = []
    await persistSubmittedReview(makeDeps(env, { findingEventSink }), 7)

    expect(findingEventSink).toHaveLength(1)
    const [draft] = await materializeFindingEvents(findingEventSink)
    expect(draft).toMatchObject({ findingKey: "f1", stage: "publish", path: "src/x.ts", category: "security" })
  })

  it("runtime proof of the privacy invariant: no headline reaches the draft", async () => {
    // The guarantee is compile-time via `satisfies`; this is the runtime net, and this
    // is the PR that adds a new push site whose input DOES carry a headline.
    const { env } = mockEnv()
    const findingEventSink: FindingEventCapture[] = []
    await persistSubmittedReview(makeDeps(env, { findingEventSink }), 7)
    const [draft] = await materializeFindingEvents(findingEventSink)
    expect(draft).not.toHaveProperty("headline")
    expect(JSON.stringify(draft)).not.toContain("SQL injection in handler")
  })

  it("records the posted set alongside it, keyed the same way", async () => {
    const { env } = mockEnv()
    const postedFindingSink: PostedFindingCapture[] = []
    await persistSubmittedReview(makeDeps(env, { postedFindingSink }), 7)
    expect(postedFindingSink).toEqual([
      { findingKey: "f1", surface: "posted-body", inlineCommentId: null, trustTier: null },
    ])
  })

  it("both sinks absent → no throw (they are optional everywhere)", async () => {
    await expect(persistSubmittedReview(makeDeps(mockEnv().env), 7)).resolves.toBeUndefined()
  })
})
