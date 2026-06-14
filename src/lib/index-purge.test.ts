// SIG-419 — stale-index purge: classification, dedup, bounded batch, safety.
//
// The parse fns + key-prefix consts are mocked with JSON passthroughs so each
// test controls a record's owner/repo directly; this suite tests the purge
// LOGIC (classify-from-key, dedup across keyspaces, original-case owner hand-off,
// bounded idempotent batch), not the schema validators (tested in their own
// suites). `deleteRepoIndex` is mocked to observe exactly what it's called with.

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/src/lib/index-delete", () => ({ deleteRepoIndex: vi.fn() }))
vi.mock("@/src/lib/repo-index-manifest", () => ({
  REPO_INDEX_MANIFEST_PREFIX: "repo-index-manifest:",
  parseRepoIndexManifest: (raw: string) => ({ kind: "ok", manifest: JSON.parse(raw) }),
}))
vi.mock("@/src/lib/repo-index-vectors", () => ({
  REPO_INDEX_VECTORS_PREFIX: "repo-index-vectors:",
  parseRepoIndexVectors: (raw: string) => ({ kind: "ok", vectors: JSON.parse(raw) }),
}))

import { runStaleIndexPurge } from "@/src/lib/index-purge"
import { deleteRepoIndex } from "@/src/lib/index-delete"
import type { Env } from "@/src/shared/types/env"

const mockDelete = vi.mocked(deleteRepoIndex)

/** Build a fake Env whose KV `list` filters a flat store by prefix (single
 *  page) and `get` returns the body. `listError` makes a prefix's list throw. */
function makeEnv(store: Record<string, string>, listError?: string) {
  const env = {
    OPENCLAW_STATE: {
      list: async ({ prefix }: { prefix: string }) => {
        if (listError && prefix.startsWith(listError)) throw new Error("kv boom")
        const keys = Object.keys(store)
          .filter((k) => k.startsWith(prefix))
          .sort()
          .map((name) => ({ name }))
        return { keys, list_complete: true }
      },
      get: async (key: string) => store[key] ?? null,
    },
  } as unknown as Env
  return env
}

// A realistic store: live default-branch indexes (must be preserved), branch
// overlays under our org, a dead-org default record, an orphan vectors record,
// and a customer's live default index.
function fixture(): Record<string, string> {
  const m = (owner: string, repo: string) => JSON.stringify({ owner, repo })
  return {
    // live defaults — never candidates
    "repo-index-manifest:sigilix/sigilix": m("Sigilix", "sigilix"),
    "repo-index-manifest:bigcorp/app": m("BigCorp", "app"),
    "repo-index-vectors:sigilix/sigilix": m("Sigilix", "sigilix"),
    // branch overlays (note ORIGINAL-CASE owner "Sigilix" in the body)
    "repo-index-manifest:sigilix/sigilix/__branch__/h1": m("Sigilix", "sigilix/__branch__/h1"),
    "repo-index-vectors:sigilix/sigilix/__branch__/h1": m("Sigilix", "sigilix/__branch__/h1"),
    "repo-index-manifest:sigilix/sigilix-monitor/__branch__/h3": m("Sigilix", "sigilix-monitor/__branch__/h3"),
    // orphan vectors overlay — no manifest counterpart
    "repo-index-vectors:sigilix/sigilix/__branch__/h9": m("Sigilix", "sigilix/__branch__/h9"),
    // dead-org default-branch record (both keyspaces → dedup to one tuple)
    "repo-index-manifest:arc-and-anchor/rubberfit": m("arc-and-anchor", "rubberfit"),
    "repo-index-vectors:arc-and-anchor/rubberfit": m("arc-and-anchor", "rubberfit"),
  }
}

beforeEach(() => {
  mockDelete.mockReset()
  mockDelete.mockResolvedValue({
    status: "complete",
    vectorIds: 5,
    prReviewManifests: 0,
    prReviewDedupeKeys: 0,
    manifestDeleted: true,
    vectorsKvDeleted: true,
    reviewMemoryKeys: 0,
    lexicalRows: 0,
    errors: [],
  })
})

describe("runStaleIndexPurge — dry run", () => {
  it("classifies branch overlays + dead-org, dedups across keyspaces, preserves live defaults", async () => {
    const env = makeEnv(fixture())
    const s = await runStaleIndexPurge(env, { dryRun: true, deadOrgs: ["arc-and-anchor"] })

    // 3 unique branch overlays: sigilix/sigilix h1 (manifest∪vectors → 1), h9 (orphan), monitor h3.
    expect(s.branchOverlayTuples).toBe(3)
    // 1 dead-org tuple (manifest∪vectors deduped).
    expect(s.deadOrgTuples).toBe(1)
    expect(s.totalCandidateTuples).toBe(4)
    expect(s.remaining).toBe(4)
    // grouped by base repo (overlay hash stripped)
    expect(s.byBaseRepo["sigilix/sigilix"]).toEqual({ branchOverlay: 2, deadOrg: 0 })
    expect(s.byBaseRepo["sigilix/sigilix-monitor"]).toEqual({ branchOverlay: 1, deadOrg: 0 })
    expect(s.byBaseRepo["arc-and-anchor/rubberfit"]).toEqual({ branchOverlay: 0, deadOrg: 1 })
    // live defaults absent
    expect(s.byBaseRepo["bigcorp/app"]).toBeUndefined()
    // dry run never deletes
    expect(mockDelete).not.toHaveBeenCalled()
    expect(s.processed).toBe(0)
  })

  it("dead-org deletion is OPT-IN — without deadOrgs the dead-org default record is left alone", async () => {
    const env = makeEnv(fixture())
    const s = await runStaleIndexPurge(env, { dryRun: true, deadOrgs: [] })
    expect(s.branchOverlayTuples).toBe(3)
    expect(s.deadOrgTuples).toBe(0)
    expect(s.totalCandidateTuples).toBe(3)
    expect(s.byBaseRepo["arc-and-anchor/rubberfit"]).toBeUndefined()
  })
})

describe("runStaleIndexPurge — live delete", () => {
  it("deletes every candidate via deleteRepoIndex with the body's ORIGINAL-CASE owner + reason", async () => {
    const env = makeEnv(fixture())
    const s = await runStaleIndexPurge(env, { dryRun: false, deadOrgs: ["arc-and-anchor"] })

    expect(s.processed).toBe(4)
    expect(s.deleted).toBe(4)
    expect(s.vectorIdsDeleted).toBe(20)
    expect(s.remaining).toBe(0)
    expect(mockDelete).toHaveBeenCalledTimes(4)

    const calls = mockDelete.mock.calls.map((c) => c[0])
    // CRITICAL safety invariant: owner is the body's original case ("Sigilix"),
    // NOT the lowercased key segment — else the cross-tenant guard would refuse.
    expect(calls).toContainEqual(
      expect.objectContaining({ owner: "Sigilix", repo: "sigilix/__branch__/h1", reason: "stale-index-purge" }),
    )
    // orphan vectors overlay resolved from the VECTORS body
    expect(calls).toContainEqual(
      expect.objectContaining({ owner: "Sigilix", repo: "sigilix/__branch__/h9", reason: "stale-index-purge" }),
    )
    // dead-org full delete
    expect(calls).toContainEqual(
      expect.objectContaining({ owner: "arc-and-anchor", repo: "rubberfit", reason: "stale-index-purge" }),
    )
    // a live default index is NEVER passed to delete
    expect(calls).not.toContainEqual(expect.objectContaining({ repo: "sigilix" }))
    expect(calls).not.toContainEqual(expect.objectContaining({ repo: "app" }))
  })

  it("respects the per-call cap and reports remaining (idempotent re-run drains the rest)", async () => {
    const env = makeEnv(fixture())
    const s = await runStaleIndexPurge(env, { dryRun: false, deadOrgs: ["arc-and-anchor"], maxDeletesPerCall: 2 })
    expect(s.processed).toBe(2)
    expect(s.deleted).toBe(2)
    expect(s.remaining).toBe(2) // 4 total − 2 deleted
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })

  it("records a partial delete as an error and does not count it as deleted", async () => {
    mockDelete.mockReset()
    mockDelete.mockResolvedValue({
      status: "partial",
      vectorIds: 0,
      prReviewManifests: 0,
      prReviewDedupeKeys: 0,
      manifestDeleted: false,
      vectorsKvDeleted: false,
      reviewMemoryKeys: 0,
      lexicalRows: 0,
      errors: ["vectorize.deleteByIds: boom"],
    })
    const env = makeEnv(fixture())
    const s = await runStaleIndexPurge(env, { dryRun: false, deadOrgs: ["arc-and-anchor"] })
    expect(s.processed).toBe(4)
    expect(s.deleted).toBe(0)
    expect(s.deleteErrors.length).toBe(4)
    expect(s.remaining).toBe(4)
  })
})

describe("runStaleIndexPurge — enumeration", () => {
  it("flags enumerationIncomplete when a list page errors", async () => {
    const env = makeEnv(fixture(), "repo-index-vectors:")
    const s = await runStaleIndexPurge(env, { dryRun: true, deadOrgs: ["arc-and-anchor"] })
    expect(s.enumerationIncomplete).toBe(true)
    // manifest scan still classified its candidates (overlays h1, h3 + dead-org)
    expect(s.totalCandidateTuples).toBeGreaterThan(0)
  })

  it("handles an empty keyspace", async () => {
    const env = makeEnv({})
    const s = await runStaleIndexPurge(env, { dryRun: false, deadOrgs: ["arc-and-anchor"] })
    expect(s.totalCandidateTuples).toBe(0)
    expect(s.remaining).toBe(0)
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
