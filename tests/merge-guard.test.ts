// ARC-286 — unit tests for `checkIsPrMerged`. Sigilix PR #97 round-2
// pushback: testing the merge guard's three branches takes 1-2 mocks,
// not the ~20 mocks I claimed when arguing for deferral. Sigilix was
// right; this file is the correction.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkIsPrMerged,
  type MergeGuardClient,
} from "../src/lib/merge-guard"

const BASE = {
  owner: "Arc-and-Anchor",
  repo: "sigilix",
  prNumber: 97,
  headSha: "deadbeef1234567890abcdef1234567890abcdef",
} as const

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  warnSpy.mockRestore()
})

function mockClient(impl: () => Promise<{ merged_at?: string | null }>): MergeGuardClient {
  return { getPullRequest: vi.fn(impl) }
}

describe("checkIsPrMerged (ARC-286)", () => {
  it("returns {shouldSkip: false} when the PR is open (merged_at is null)", async () => {
    const client = mockClient(async () => ({ merged_at: null }))
    const out = await checkIsPrMerged({ ...BASE, client })
    expect(out).toEqual({ shouldSkip: false })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("returns {shouldSkip: false} when merged_at field is absent (defensive)", async () => {
    const client = mockClient(async () => ({}))
    const out = await checkIsPrMerged({ ...BASE, client })
    expect(out).toEqual({ shouldSkip: false })
  })

  it("returns {shouldSkip: true, mergedAtMs} when the PR is merged", async () => {
    const mergedIso = "2026-05-18T17:18:52Z"
    const client = mockClient(async () => ({ merged_at: mergedIso }))
    const out = await checkIsPrMerged({ ...BASE, client })
    expect(out.shouldSkip).toBe(true)
    if (out.shouldSkip) {
      expect(out.mergedAtMs).toBe(new Date(mergedIso).getTime())
    }
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("returns {shouldSkip: false} on a thrown GitHub API error and emits warn (best-effort)", async () => {
    // The most important branch — pre-extraction the un-guarded throw
    // would have discarded a fully synthesized review (Sigilix PR #97
    // Critical catch). Best-effort means: log + proceed.
    const client = mockClient(async () => {
      throw new Error("HTTP 503 Service Unavailable")
    })
    const out = await checkIsPrMerged({ ...BASE, client })
    expect(out).toEqual({ shouldSkip: false })
    // Warn event was emitted with the expected shape.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = warnSpy.mock.calls[0]?.[0]
    expect(typeof logged).toBe("string")
    const parsed = JSON.parse(logged as string)
    expect(parsed["event"]).toBe("pr-review-merged-guard-failed")
    expect(parsed["owner"]).toBe(BASE.owner)
    expect(parsed["repo"]).toBe(BASE.repo)
    expect(parsed["prNumber"]).toBe(BASE.prNumber)
    expect(parsed["headSha"]).toBe("deadbee") // 7-char truncation
    expect(parsed["err"]).toBe("HTTP 503 Service Unavailable")
  })

  it("propagates non-Error throws as strings on the warn payload", async () => {
    // Defensive: someone could `Promise.reject("string")` or
    // `Promise.reject({status: 503})`. The helper should still log
    // + proceed without crashing. Using `Promise.reject(...)` here
    // instead of `throw` to keep eslint's `no-throw-literal` happy
    // while still exercising the non-Error rejection branch.
    const client = mockClient(() => Promise.reject("raw string thrown"))
    const out = await checkIsPrMerged({ ...BASE, client })
    expect(out).toEqual({ shouldSkip: false })
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string)
    expect(parsed["err"]).toBe("raw string thrown")
  })

  it("passes owner/repo/prNumber to client.getPullRequest verbatim", async () => {
    // Pin the call shape so a future refactor that reorders args
    // (e.g. swapping owner/repo) gets caught.
    const fn = vi.fn(async () => ({ merged_at: null }))
    await checkIsPrMerged({ ...BASE, client: { getPullRequest: fn } })
    expect(fn).toHaveBeenCalledWith(BASE.owner, BASE.repo, BASE.prNumber)
  })
})
