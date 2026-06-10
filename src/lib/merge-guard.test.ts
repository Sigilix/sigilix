// ARC-286 — unit tests for `checkIsPrMerged`. Sigilix PR #97 round-2
// pushback: testing the merge guard's three branches takes 1-2 mocks,
// not the ~20 mocks I claimed when arguing for deferral. Sigilix was
// right; this file is the correction.
//
// SIG-88 — added `submitMergedOnApprove` tests at the bottom. Same
// 1-2-mock pattern: stub a `submitReview` client, assert the submit
// payload + telemetry event shape + the `{ok}`/`{!ok}` return.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkIsPrMerged,
  submitMergedOnApprove,
  type MergeApproveSubmitClient,
  type MergeGuardClient,
} from "@/src/lib/merge-guard"
import type { SubmitReviewBody } from "@/src/shared/types/github"

const BASE = {
  owner: "Sigilix",
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

// ─── SIG-88: submitMergedOnApprove ─────────────────────────────────────

const SUBMIT_BASE = {
  owner: "Sigilix",
  repo: "sigilix",
  prNumber: 104,
  headSha: "deadbeef1234567890abcdef1234567890abcdef",
  mergedAtMs: new Date("2026-05-18T18:00:00Z").getTime(),
  // 30s before merge → simulates "merge happened 30s into the review"
  startMs: new Date("2026-05-18T17:59:30Z").getTime(),
} as const

function mockSubmitClient(
  impl: () => Promise<{ id: number; state: string }>,
): MergeApproveSubmitClient {
  return { submitReview: vi.fn(impl) }
}

describe("submitMergedOnApprove (SIG-88)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it("submits a marker-only APPROVE on success and returns {ok: true, reviewId}", async () => {
    let captured: SubmitReviewBody | undefined
    const submitFn = vi.fn(async (
      _owner: string,
      _repo: string,
      _prNumber: number,
      review: SubmitReviewBody,
    ) => {
      captured = review
      return { id: 99_001, state: "APPROVED" }
    })
    const client: MergeApproveSubmitClient = { submitReview: submitFn }

    const out = await submitMergedOnApprove({
      ...SUBMIT_BASE,
      client,
      stage: "pre-fanout",
    })

    expect(out).toEqual({ ok: true, reviewId: 99_001, state: "APPROVED" })
    expect(submitFn).toHaveBeenCalledTimes(1)
    expect(submitFn).toHaveBeenCalledWith(
      SUBMIT_BASE.owner,
      SUBMIT_BASE.repo,
      SUBMIT_BASE.prNumber,
      expect.any(Object),
    )
    // Marker-only body: just the dedupe marker (post-ARC-293 + SIG-87).
    expect(captured?.event).toBe("APPROVE")
    expect(captured?.body).toBe("<!-- sigilix:pr-review -->\n")
    expect(captured?.commit_id).toBe(SUBMIT_BASE.headSha)
    // No inline comments — the marker-only body IS the review.
    expect(captured?.comments).toBeUndefined()
  })

  it("emits `pr-review-approved-on-merge` telemetry with `stage: pre-fanout`", async () => {
    const client = mockSubmitClient(async () => ({ id: 1, state: "APPROVED" }))
    await submitMergedOnApprove({ ...SUBMIT_BASE, client, stage: "pre-fanout" })

    expect(logSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed["event"]).toBe("pr-review-approved-on-merge")
    expect(parsed["owner"]).toBe(SUBMIT_BASE.owner)
    expect(parsed["repo"]).toBe(SUBMIT_BASE.repo)
    expect(parsed["prNumber"]).toBe(SUBMIT_BASE.prNumber)
    expect(parsed["headSha"]).toBe("deadbee") // 7-char truncation
    expect(parsed["stage"]).toBe("pre-fanout")
    expect(parsed["merged_at_ms"]).toBe(SUBMIT_BASE.mergedAtMs)
    // mergedAtMs - startMs = 30s in this fixture.
    expect(parsed["merged_during_review_ms"]).toBe(30_000)
    expect(parsed["review_id"]).toBe(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it("emits `pr-review-approved-on-merge` telemetry with `stage: pre-submit`", async () => {
    const client = mockSubmitClient(async () => ({ id: 2, state: "APPROVED" }))
    await submitMergedOnApprove({ ...SUBMIT_BASE, client, stage: "pre-submit" })

    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    expect(parsed["stage"]).toBe("pre-submit")
    // Different stage, but everything else identical — confirms stage
    // is the only thing distinguishing the two call sites' telemetry.
    expect(parsed["event"]).toBe("pr-review-approved-on-merge")
  })

  it("on submit failure: returns {ok: false, error} + emits a failure warn", async () => {
    const client: MergeApproveSubmitClient = {
      submitReview: vi.fn(async () => {
        throw new Error("HTTP 502 Bad Gateway")
      }),
    }

    const out = await submitMergedOnApprove({
      ...SUBMIT_BASE,
      client,
      stage: "pre-submit",
    })

    expect(out).toEqual({ ok: false, error: "HTTP 502 Bad Gateway" })
    // No success log; one warn log.
    expect(logSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string)
    expect(parsed["event"]).toBe("pr-review-approved-on-merge-failed")
    expect(parsed["stage"]).toBe("pre-submit")
    expect(parsed["err"]).toBe("HTTP 502 Bad Gateway")
  })

  it("on non-Error reject: stringifies the rejection for the warn payload", async () => {
    // Defensive — matches the `checkIsPrMerged` pattern.
    const client: MergeApproveSubmitClient = {
      submitReview: () => Promise.reject("raw string rejection"),
    }
    const out = await submitMergedOnApprove({
      ...SUBMIT_BASE,
      client,
      stage: "pre-fanout",
    })
    expect(out).toEqual({ ok: false, error: "raw string rejection" })
    const parsed = JSON.parse(warnSpy.mock.calls[0]?.[0] as string)
    expect(parsed["err"]).toBe("raw string rejection")
  })

  // CR PR #104 Minor: pre-fanout runs can have a `mergedAtMs` that
  // precedes `startMs` (webhook queued long after the merge happened).
  // Without the clamp, telemetry would report a negative
  // `merged_during_review_ms`, which downstream dashboards can't
  // pivot on cleanly. Pin the clamp at 0.
  it("clamps `merged_during_review_ms` at 0 when merge happened BEFORE the ensemble started (pre-fanout case)", async () => {
    const client = mockSubmitClient(async () => ({ id: 4, state: "APPROVED" }))
    // merge happened 30s BEFORE startMs (webhook delay scenario)
    const mergedAtMs = new Date("2026-05-18T17:59:00Z").getTime()
    const startMs = new Date("2026-05-18T17:59:30Z").getTime()
    await submitMergedOnApprove({
      ...SUBMIT_BASE,
      mergedAtMs,
      startMs,
      client,
      stage: "pre-fanout",
    })
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
    // Raw diff would be -30_000; the clamp pins it at 0.
    expect(parsed["merged_during_review_ms"]).toBe(0)
  })

  it("commit_id pins the headSha so the APPROVE attaches to the right commit", async () => {
    let captured: SubmitReviewBody | undefined
    const client: MergeApproveSubmitClient = {
      submitReview: vi.fn(async (_o, _r, _p, review) => {
        captured = review
        return { id: 3, state: "APPROVED" }
      }),
    }
    await submitMergedOnApprove({
      ...SUBMIT_BASE,
      client,
      stage: "pre-submit",
      headSha: "cafef00d1234567890abcdef1234567890abcdef",
    })
    expect(captured?.commit_id).toBe("cafef00d1234567890abcdef1234567890abcdef")
  })
})
