// ARC-189 — Capture pipeline tests (Task 9).

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
import {
  captureDismissedReviewFeedback,
  captureReviewFeedback,
  hasStaleDismissedReviewFeedbackSignal,
} from "@/src/lib/review-memory/capture"
import { buildKey } from "@/src/lib/review-memory/storage"
import type { GitHubClient } from "@/src/shared/adapters/github"
import { computePathSha256, hydrateClaimIds } from "@/src/lib/review-memory/marker"
import {
  makeKvStub,
  makeEnv,
  makeConfig,
  makeClient,
  VALID_MARKER,
  VALID_FINGERPRINT,
  VALID_FINGERPRINT_2,
  PRECISION_FINDING_MARKERS,
  SECOND_PRECISION_FINDING_MARKERS,
} from "@/src/lib/review-memory/review-memory-capture.test-helpers"

// SIG-276: wrap the real marker module so `hydrateClaimIds` defaults to the
// real implementation (all other tests are unaffected) but can be forced to
// reject for the hydrate-failure path test below.
vi.mock("@/src/lib/review-memory/marker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/lib/review-memory/marker")>()
  return { ...actual, hydrateClaimIds: vi.fn(actual.hydrateClaimIds) }
})

// ─── Capture: gate skips ─────────────────────────────────────

describe("captureReviewFeedback — gate skips", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("skips when env CAPTURE flag is off (no KV touched)", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "off")
    const client = makeClient("body has parent marker")
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 1,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(putKeys.length).toBe(0)
  })

  it("skips when sigilix.json enabled=false AND captureOnly=false", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient("body has marker")
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 1,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig({ enabled: false, captureOnly: false }),
    })
    expect(putKeys.length).toBe(0)
  })

  it("skips when reply has no in_reply_to_id (top-level comment, not a reply)", async () => {
    const { kv, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(null)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 1,
      replyComment: { id: 100, body: "false positive", path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(putKeys.length).toBe(0)
  })
})

// ─── Capture: parent + reply parsing ────────────────────────

describe("captureReviewFeedback — parent + reply parsing", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("happy path: parent has marker AND reply has dismissal → both KV writes + capture-written telemetry", async () => {
    const { kv, store, putKeys } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Some review text\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // 1 seen-marker write + 2 signal writes = 3 puts total
    const signalWrites = putKeys.filter((k) => k.startsWith("review-memory:a/r:"))
    expect(signalWrites.length).toBe(2)
    // Both stored records present
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals.length).toBe(1)
    expect(catRecord.signals[0].fid).toBe("1111111111111111")
    expect(catRecord.signals[0].commentId).toBe(100)
    // SIG-114 PR 3: the finding's severity tier is copied from the marker.
    expect(catRecord.signals[0].sev).toBe("warning")
    // SIG-114 PR 4: a freeform "false positive" reply carries no canonical
    // reason → stays unlabeled.
    expect(catRecord.signals[0].dismissReason).toBeUndefined()
    // Path-scope record exists (path-sha key derived from marker pathSha12 — but
    // capture pipeline uses the FULL sha256 derived independently so the test
    // can't predict the exact key without knowing the path. Check via prefix.)
    const pathScopeKeys = Array.from(store.keys()).filter((k) => k.startsWith("review-memory:a/r:path:"))
    expect(pathScopeKeys.length).toBe(1)
    // capture-written telemetry fired
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("review-memory-capture-written"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("SIG-114 PR 4: captures the canonical dismissReason when the reply states one", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: {
        id: 100,
        body: "@sigilix dismiss not-a-bug",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
      },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals.length).toBe(1)
    expect(catRecord.signals[0].dismissReason).toBe("not-a-bug")
    expect(catRecord.signals[0].sev).toBe("warning")
    const profile = JSON.parse(store.get("precision-profile:repo:a/r")!)
    expect(profile.patterns[VALID_FINGERPRINT].suppress).toBe(0.3)
  })

  it("SIG-247 Phase 1: skips when parent comment is NOT authored by Sigilix App, even with valid marker", async () => {
    // The marker parser is a pure body regex. Without an author
    // check, any commenter could paste a valid marker into their own
    // inline comment and reply "false positive" to themselves to write
    // a dismissal signal. Phase 1 closes that hole by gating marker
    // trust on isArcGithubLogin(parent.user?.login).
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Some review text\n\n${VALID_MARKER}`, {
      authorLogin: "malicious-user", // NOT a Sigilix login
    })
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).filter((k) => k.startsWith("review-memory:")).length).toBe(0)
    const skipEvents = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("parent-not-sigilix-author"))
    expect(skipEvents.length).toBeGreaterThan(0)
  })

  it("SIG-247 Phase 1: dual-write keyspace populated when parent is Sigilix App", async () => {
    // Default makeClient returns repoId=555000 so the capture path
    // resolves a positive-integer id either from args or fallback.
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Some review text\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // Both legacy AND repo-id keyspaces populated for cat-scope
    expect(store.has("review-memory:a/r:cat:performance")).toBe(true)
    expect(store.has("review-memory:repo:555000:cat:performance")).toBe(true)
    // Both populated for path-scope (path-sha derived inside capture)
    const repoIdPathKeys = Array.from(store.keys()).filter((k) => k.startsWith("review-memory:repo:555000:path:"))
    expect(repoIdPathKeys.length).toBe(1)
  })

  it("SIG-247 Phase 1: legacy-only path when getRepository returns null repo.id", async () => {
    // Simulate a webhook with no repository.id AND a getRepository
    // call that returns null (deleted repo / 404). Capture should
    // gracefully degrade to legacy-only writes.
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Some review text\n\n${VALID_MARKER}`)
    // Override getRepository to return null
    ;(
      client as unknown as {
        getRepository: ReturnType<typeof vi.fn>
      }
    ).getRepository = vi.fn(async () => null)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(store.has("review-memory:a/r:cat:performance")).toBe(true)
    const repoIdKeys = Array.from(store.keys()).filter((k) => k.startsWith("review-memory:repo:"))
    expect(repoIdKeys.length).toBe(0)
  })

  it("skips when parent has no marker (not-a-reply-to-sigilix)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient("Just a review comment with no markers")
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("not-a-reply-to-sigilix"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("skips when reply has no feedback keyword (no-dismissal-keyword)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: {
        id: 100,
        body: "Can you explain this?",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
      },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
    const events = consoleSpy.mock.calls
      .map((args) => String(args[0]))
      .filter((s) => s.includes("no-dismissal-keyword"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("SIG-185: accepted inline reply records a precision-profile accepted outcome without review-memory softening", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`${PRECISION_FINDING_MARKERS}\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: {
        id: 100,
        body: "Good catch, fixed.",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
      },
      config: makeConfig(),
    })
    expect(store.has("review-memory:a/r:cat:performance")).toBe(false)
    const rawProfile = store.get("precision-profile:repo:a/r")
    expect(rawProfile).toBeDefined()
    const profile = JSON.parse(rawProfile!)
    expect(profile.patterns[VALID_FINGERPRINT].suppress).toBe(0)
    expect(profile.categories.performance.boost).toBe(0.3)
  })

  it("skips when parent fetch returns null (parent-fetch-failed) — defensive", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(null) // parent deleted / 404
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).filter((k) => k.startsWith("review-memory:a/r:")).length).toBe(0)
  })
})

// ─── Capture: SIG-276 claims ─────────────────────────────────

describe("captureReviewFeedback — SIG-276 claims on signal", () => {
  const MARKER_WITH_CLAIMS =
    "<!-- sigilix:fid:1111111111111111:cat:performance:sev:warning:path:222222222222:claims:structural-glue-not-test-target~85~1,auth-gate-is-boundary~60~1 -->"
  const MARKER_MIXED_CLAIMS =
    "<!-- sigilix:fid:1111111111111111:cat:performance:sev:warning:path:222222222222:claims:future-unknown-claim~80~3,auth-gate-is-boundary~70~1 -->"

  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("attaches hydrated claims to BOTH category and path-scope signals", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${MARKER_WITH_CLAIMS}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    const sig = catRecord.signals[0]
    expect(sig.claims).toHaveLength(2)
    expect(sig.claims[0]).toMatchObject({
      type: "structural-glue-not-test-target",
      confidence: 0.85,
      extractorVersion: 1,
    })
    expect(sig.claims[0].id).toMatch(/^[0-9a-f]{16}$/)
    expect(sig.claims[1]).toMatchObject({
      type: "auth-gate-is-boundary",
      confidence: 0.6,
      extractorVersion: 1,
    })
    // Path-scope record carries the SAME hydrated claims (shared signal).
    const pathKey = Array.from(store.keys()).find((k) => k.startsWith("review-memory:a/r:path:"))!
    const pathRecord = JSON.parse(store.get(pathKey)!)
    expect(pathRecord.signals[0].claims).toEqual(sig.claims)
    // Dual-write repo-id keyspace carries the SAME claims — lock the contract
    // that claims propagate to every scope the shared signal is written to.
    const repoRecord = JSON.parse(store.get("review-memory:repo:555000:cat:performance")!)
    expect(repoRecord.signals[0].claims).toEqual(sig.claims)
  })

  it("omits the claims key when the marker carries none (legacy marker)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals[0]).not.toHaveProperty("claims")
  })

  it("stores only the known claim when the marker mixes known + unknown types", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${MARKER_MIXED_CLAIMS}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    const sig = catRecord.signals[0]
    expect(sig.claims).toHaveLength(1)
    expect(sig.claims[0].type).toBe("auth-gate-is-boundary")
  })

  it("capture-written telemetry reports claims metadata without leaking reply free-text", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${MARKER_WITH_CLAIMS}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: {
        id: 100,
        body: "false positive SENTINEL_REPLY_TEXT",
        in_reply_to_id: 50,
        path: "src/lib/foo.ts",
      },
      config: makeConfig(),
    })
    const written = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("review-memory-capture-written"))!
    const ev = JSON.parse(written)
    expect(ev.claims_present).toBe(true)
    expect(ev.claim_count).toBe(2)
    expect(ev.claim_types).toContain("structural-glue-not-test-target")
    expect(ev.claim_confidences).toContain(0.85)
    // The reviewer's free text must never appear in ANY telemetry line —
    // stringify EVERY console argument per call, not just the first.
    const allLogs = consoleSpy.mock.calls.map((a) => a.map(String).join(" ")).join("\n")
    expect(allLogs).not.toContain("SENTINEL_REPLY_TEXT")
  })

  it("reports claims_present=false for a legacy (claimless) marker", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    const written = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("review-memory-capture-written"))!
    const ev = JSON.parse(written)
    expect(ev.claims_present).toBe(false)
    expect(ev.claim_count).toBe(0)
  })

  it("degrades to no claims + failure telemetry when hydrateClaimIds throws, but still writes the signal", async () => {
    // Claims are additive: a hydration failure (e.g. crypto.subtle reject)
    // must NOT cost the core dismissal-signal write (capture never throws).
    vi.mocked(hydrateClaimIds).mockRejectedValueOnce(new Error("crypto boom"))
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`Review text\n\n${MARKER_WITH_CLAIMS}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // Core signal still written, just without claims.
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals).toHaveLength(1)
    expect(catRecord.signals[0]).not.toHaveProperty("claims")
    // Failure telemetry emitted with the claim-hydrate stage.
    const failed = consoleSpy.mock.calls
      .map((a) => a.map(String).join(" "))
      .find((s) => s.includes("review-memory-capture-failed") && s.includes("claim-hydrate"))
    expect(failed).toBeDefined()
  })
})

// ─── Capture: SIG-185 formal review dismissal ────────────────────

describe("captureDismissedReviewFeedback — stale precision outcome", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("prefilters irrelevant dismissed reviews before token/config work", () => {
    expect(
      hasStaleDismissedReviewFeedbackSignal(
        {
          id: 700,
          body: PRECISION_FINDING_MARKERS,
          commit_id: "old-head",
          user: { login: "sigilix[bot]" },
        },
        "new-head",
      ),
    ).toBe(true)
    expect(
      hasStaleDismissedReviewFeedbackSignal(
        {
          id: 701,
          body: PRECISION_FINDING_MARKERS,
          commit_id: "new-head",
          user: { login: "sigilix[bot]" },
        },
        "new-head",
      ),
    ).toBe(false)
    expect(
      hasStaleDismissedReviewFeedbackSignal(
        {
          id: 702,
          body: PRECISION_FINDING_MARKERS,
          commit_id: "old-head",
          user: { login: "human" },
        },
        "new-head",
      ),
    ).toBe(false)
  })

  it("records stale only when a Sigilix review for an older commit has mappable finding fingerprints", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    await captureDismissedReviewFeedback({
      env,
      owner: "a",
      repo: "r",
      prNumber: 7,
      review: {
        id: 700,
        body: `${PRECISION_FINDING_MARKERS}\n\n${SECOND_PRECISION_FINDING_MARKERS}`,
        commit_id: "old-head",
        user: { login: "sigilix[bot]" },
      },
      headSha: "new-head",
      config: makeConfig(),
    })
    expect(Array.from(store.keys()).some((k) => k.startsWith("review-memory:"))).toBe(false)
    const profile = JSON.parse(store.get("precision-profile:repo:a/r")!)
    expect(profile.patterns[VALID_FINGERPRINT].suppress).toBe(0)
    expect(profile.patterns[VALID_FINGERPRINT_2].suppress).toBe(0)
    const recorded = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("review-feedback-outcome-recorded"))
    expect(recorded).toContain('"outcome":"stale"')
    expect(recorded).toContain('"pattern_count":2')
  })

  it("skips a same-head review dismissal because staleness is not proven", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    await captureDismissedReviewFeedback({
      env,
      owner: "a",
      repo: "r",
      prNumber: 7,
      review: {
        id: 700,
        body: PRECISION_FINDING_MARKERS,
        commit_id: "same-head",
        user: { login: "sigilix[bot]" },
      },
      headSha: "same-head",
      config: makeConfig(),
    })
    expect(store.get("precision-profile:repo:a/r")).toBeUndefined()
    const skipped = consoleSpy.mock.calls
      .map((a) => String(a[0]))
      .find((s) => s.includes("review-dismissed-without-stale-sha"))
    expect(skipped).toBeDefined()
  })
})

// ─── Capture: idempotency + race ─────────────────────────────

describe("captureReviewFeedback — idempotency + concurrent race", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("sequential delivery: second call on same commentId hits already-seen", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const args = {
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    } as const
    await captureReviewFeedback(args)
    const catRecordAfterFirst = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecordAfterFirst.signals.length).toBe(1)

    // Second call - should hit already-seen and NOT add another signal
    await captureReviewFeedback(args)
    const catRecordAfterSecond = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecordAfterSecond.signals.length).toBe(1)
    const events = consoleSpy.mock.calls.map((args2) => String(args2[0])).filter((s) => s.includes("already-seen"))
    expect(events.length).toBeGreaterThan(0)
  })

  it("concurrent delivery (bounded duplicate tolerance ≤2 per spec §10)", async () => {
    // Simulate two simultaneous webhook deliveries: we run captureReviewFeedback
    // twice IN PARALLEL on a fresh KV. Without CAS the seen-marker check can
    // pass on both, so signals recorded ≤ 2 (NOT exactly 1).
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const args = {
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    } as const
    await Promise.all([captureReviewFeedback(args), captureReviewFeedback(args)])
    const catRecord = JSON.parse(store.get("review-memory:a/r:cat:performance")!)
    expect(catRecord.signals.length).toBeGreaterThanOrEqual(1)
    expect(catRecord.signals.length).toBeLessThanOrEqual(2)
  })
})

// ─── Capture: error resilience ───────────────────────────────

describe("captureReviewFeedback — best-effort error resilience", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it("does not throw when KV put fails", async () => {
    const { kv, failPut } = makeKvStub()
    failPut.value = true
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await expect(
      captureReviewFeedback({
        env,
        client,
        owner: "a",
        repo: "r",
        prNumber: 7,
        replyComment: {
          id: 100,
          body: "false positive",
          in_reply_to_id: 50,
          path: "src/lib/foo.ts",
        },
        config: makeConfig(),
      }),
    ).resolves.toBeUndefined()
  })

  it("path-scope write attempted even if category-scope fails", async () => {
    const { kv, failPutKeys } = makeKvStub()
    failPutKeys.add("review-memory:a/r:cat:performance")
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path: "src/lib/foo.ts" },
      config: makeConfig(),
    })
    // capture-failed for the cat-scope key + capture-written for the path-scope
    const events = consoleSpy.mock.calls.map((args2) => String(args2[0]))
    expect(events.some((s) => s.includes("review-memory-capture-failed"))).toBe(true)
    expect(events.some((s) => s.includes("review-memory-capture-written"))).toBe(true)
  })

  it("does not throw when client.getPullRequestReviewComment throws", async () => {
    const { kv } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = {
      getPullRequestReviewComment: vi.fn(async () => {
        throw new Error("network fail")
      }),
    } as unknown as GitHubClient
    await expect(
      captureReviewFeedback({
        env,
        client,
        owner: "a",
        repo: "r",
        prNumber: 7,
        replyComment: {
          id: 100,
          body: "false positive",
          in_reply_to_id: 50,
          path: "src/lib/foo.ts",
        },
        config: makeConfig(),
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── KV-key path-sha derivation ─────────────────────────────

describe("captureReviewFeedback — path-key derivation uses replyComment.path", () => {
  it("path-scope KV key uses full SHA-256 of replyComment.path (matches lookup keyspace)", async () => {
    const { kv, store } = makeKvStub()
    const env = makeEnv(kv, "on")
    const client = makeClient(`text\n${VALID_MARKER}`)
    const path = "src/lib/foo.ts"
    await captureReviewFeedback({
      env,
      client,
      owner: "a",
      repo: "r",
      prNumber: 7,
      replyComment: { id: 100, body: "false positive", in_reply_to_id: 50, path },
      config: makeConfig(),
    })
    // KV key uses the full SHA-256 of the comment's anchored path.
    const expectedSha256 = await computePathSha256(path)
    const expectedKey = buildKey("a", "r", {
      kind: "path-category",
      category: "performance",
      pathSha256: expectedSha256,
    })
    expect(store.get(expectedKey)).toBeDefined()
  })
})
