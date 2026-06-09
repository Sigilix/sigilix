// ARC-189 — End-to-end acceptance test for cross-PR review memory.
//
// Spec §2 "Done when" fixture: simulates 3 dismissal replies on
// performance-class findings in tests/utils.ts across 3 PRs, then
// exercises a 4th PR's lookup + render to verify the [REVIEW MEMORY]
// block is emitted with action=soften.
//
// Direct module call style — NOT full webhook E2E (Codex MAJOR on
// plan v1). The lookup module's 19 unit tests + render module's 10
// tests cover the building blocks; this acceptance verifies they
// wire together with the capture pipeline against real KV state.

import { describe, expect, it, vi } from "vitest"
import { captureReviewFeedback } from "../src/lib/review-memory/capture"
import { runReviewMemoryLookup } from "../src/lib/review-memory/lookup"
import { renderReviewMemoryForPrompt } from "../src/lib/review-memory/render"
import {
  buildSigilixMarker,
  computePathSha256,
} from "../src/lib/review-memory/marker"
import type { Env } from "../src/shared/types/env"
import type { GitHubClient } from "../src/shared/adapters/github"
import type { ResolvedReviewMemoryConfig } from "../src/lib/review-memory/types"

interface KvStub {
  kv: Env["OPENCLAW_STATE"]
  store: Map<string, string>
}

function makeKvStub(): KvStub {
  const store = new Map<string, string>()
  const kv = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, value)
    },
    async delete(key: string): Promise<void> {
      store.delete(key)
    },
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    OPENCLAW_REVIEW_MEMORY_CAPTURE: "on",
    OPENCLAW_REVIEW_MEMORY_ENABLED: "on",
  } as unknown as Env
}

function makeConfig(): ResolvedReviewMemoryConfig {
  return {
    enabled: true,
    captureOnly: false,
    categories: ["security", "logic", "performance", "tests"],
    maxInjectedMemories: 5,
    minSignalThreshold: 3,
    maxSignalAgeDays: 90,
    claimSoftening: false,
  }
}

describe("ARC-189 acceptance — 3-PR dismissal sequence → 4th PR memory injection", () => {
  it("captures 3 performance-class dismissals on tests/utils.ts → 4th PR lookup returns 1 active path-scope finding → render emits [REVIEW MEMORY] block", async () => {
    const path = "tests/utils.ts"
    // Use a single shared store across all 4 PRs.
    const shared = makeKvStub()
    const sharedEnv = makeEnv(shared.kv)

    // ── Phase 1: pre-build the parent comment body each PR will reply to.
    // Each PR's parent has a distinct fid (different path/line/headline)
    // but all carry cat=performance, so dismissals aggregate under the
    // performance category bucket.
    const parentBodies: string[] = []
    for (let i = 0; i < 3; i++) {
      const marker = await buildSigilixMarker({
        ruleId: null,
        path,
        line: 100 + i,
        headline: `slow-loop-${i}`,
        category: "performance",
        severity: "warning",
      })
      parentBodies.push(`Original sigilix comment text\n\n${marker}`)
    }

    // ── Phase 2: simulate 3 PRs, each with one dismissal reply.
    const config = makeConfig()
    const dismissalReplies = [
      "false positive",
      "not relevant for tests",
      "wontfix",
    ]
    for (let i = 0; i < 3; i++) {
      const parentBody = parentBodies[i]!
      const fakeClient = {
        getPullRequestReviewComment: vi.fn(async () => ({
          id: 1000 + i,
          body: parentBody,
          // SIG-247 Phase 1: parent App-author check requires
          // `isArcGithubLogin(user.login)` to pass for the marker to
          // be trusted. Acceptance fixture simulates a real Sigilix
          // bot-authored parent comment.
          user: { login: "sigilix[bot]" },
        })),
        // SIG-247 Phase 1: capture path falls back to getRepository
        // when args.repoId is absent. Acceptance fixture pins a
        // positive integer id so dual-write semantics are exercised
        // end-to-end.
        getRepository: vi.fn(async () => ({ default_branch: "main", id: 9_000_000 })),
      } as unknown as GitHubClient
      await captureReviewFeedback({
        env: sharedEnv,
        client: fakeClient,
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        prNumber: 100 + i,
        replyComment: {
          id: 2000 + i,
          body: dismissalReplies[i]!,
          in_reply_to_id: 1000 + i,
          path,
        },
        config,
      })
    }

    // ── Phase 3: assert KV state. One category-scope record + one
    //   path-category record, each with 3 signals.
    const catKey = "review-memory:Arc-and-Anchor/sigilix:cat:performance"
    const expectedSha256 = await computePathSha256(path)
    const pathKey = `review-memory:Arc-and-Anchor/sigilix:path:${expectedSha256}:cat:performance`
    const catRecord = JSON.parse(shared.store.get(catKey)!)
    const pathRecord = JSON.parse(shared.store.get(pathKey)!)
    expect(catRecord.signals).toHaveLength(3)
    expect(pathRecord.signals).toHaveLength(3)
    expect(catRecord.category).toBe("performance")
    expect(pathRecord.category).toBe("performance")
    expect(pathRecord.pathSha256).toBe(expectedSha256)

    // ── Phase 4: simulate the 4th PR's lookup with this same path.
    const lookup = await runReviewMemoryLookup({
      env: sharedEnv,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 200,
      paths: [path],
      config,
    })
    expect(lookup.skipped).toBe(false)
    if (lookup.skipped) throw new Error("unexpected skip")

    // Both category-scope AND path-category-scope memories activate
    // (3 signals each ≥ threshold-3). Lookup caps at 5 by default,
    // so both are returned.
    expect(lookup.findings.length).toBeGreaterThanOrEqual(1)
    expect(lookup.findings.length).toBeLessThanOrEqual(2)

    const cat = lookup.findings.find((m) => m.scope === "category")
    expect(cat?.category).toBe("performance")
    expect(cat?.signalCount).toBe(3)
    expect(cat?.suggestedAction).toBe("soften")

    const pathFinding = lookup.findings.find((m) => m.scope === "path-category")
    expect(pathFinding?.category).toBe("performance")
    expect(pathFinding?.signalCount).toBe(3)
    expect(pathFinding?.pathSha12).toBe(expectedSha256.slice(0, 12))

    // ── Phase 5: render emits a non-empty [REVIEW MEMORY] block
    //   carrying the soften instruction + matching the privacy
    //   contract (only sha12, never raw paths).
    const block = renderReviewMemoryForPrompt(lookup.findings)
    expect(block.length).toBeGreaterThan(0)
    expect(block).toContain("[REVIEW MEMORY")
    expect(block).toContain("provenance.softened[]")
    expect(block).toContain("category=performance")
    expect(block).toContain("→ soften")
    expect(block).not.toContain("tests/utils.ts")
    expect(block).toContain(expectedSha256.slice(0, 12))
  })

  it("threshold-2 → no findings → render returns empty string (omit-empty contract)", async () => {
    const path = "tests/utils.ts"
    const shared = makeKvStub()
    const sharedEnv = makeEnv(shared.kv)
    const config = makeConfig()
    const marker = await buildSigilixMarker({
      ruleId: null,
      path,
      line: 100,
      headline: "single concern",
      category: "performance",
      severity: "warning",
    })
    const parentBody = `Original\n${marker}`

    // Only 2 PRs (below threshold-3)
    for (let i = 0; i < 2; i++) {
      const fakeClient = {
        getPullRequestReviewComment: vi.fn(async () => ({
          id: 1000 + i,
          body: parentBody,
          // SIG-247 Phase 1: parent App-author check requires
          // `isArcGithubLogin(user.login)` to pass for the marker to
          // be trusted. Acceptance fixture simulates a real Sigilix
          // bot-authored parent comment.
          user: { login: "sigilix[bot]" },
        })),
        // SIG-247 Phase 1: capture path falls back to getRepository
        // when args.repoId is absent. Acceptance fixture pins a
        // positive integer id so dual-write semantics are exercised
        // end-to-end.
        getRepository: vi.fn(async () => ({ default_branch: "main", id: 9_000_000 })),
      } as unknown as GitHubClient
      await captureReviewFeedback({
        env: sharedEnv,
        client: fakeClient,
        owner: "Arc-and-Anchor",
        repo: "sigilix",
        prNumber: 100 + i,
        replyComment: {
          id: 2000 + i,
          body: "false positive",
          in_reply_to_id: 1000 + i,
          path,
        },
        config,
      })
    }

    const lookup = await runReviewMemoryLookup({
      env: sharedEnv,
      owner: "Arc-and-Anchor",
      repo: "sigilix",
      prNumber: 200,
      paths: [path],
      config,
    })
    expect(lookup.skipped).toBe(false)
    if (lookup.skipped) throw new Error("unexpected skip")
    expect(lookup.findings.length).toBe(0)
    expect(renderReviewMemoryForPrompt(lookup.findings)).toBe("")
  })
})
