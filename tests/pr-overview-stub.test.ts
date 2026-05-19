// SIG-84 — pr-overview stub helper tests.
//
// Covers the four resolution paths in `postPrOverviewStubIfNeeded`:
//   1. KV fast path (already-posted → kv-hit, no create, no list)
//   2. Marker scan fallback (KV miss + existing sigilix marker)
//   3. Reset path (KV miss + existing marker → updateIssueComment with
//      stub body so the overview handler can re-render)
//   4. Create path (KV miss + no marker → createIssueComment)
//
// Also covers `waitForPrOverviewStub` happy-path (flag present
// immediately), timeout path (flag never appears), and arrival-mid-poll
// path (flag appears after first poll).

import { beforeEach, describe, expect, it, vi } from "vitest"

const mockGetInstallationToken = vi.fn(async () => "fake-token")
const mockListIssueComments = vi.fn()
const mockCreateIssueComment = vi.fn()
const mockUpdateIssueComment = vi.fn()

vi.mock("../src/lib/github-app", () => ({
  getInstallationToken: (args: unknown) => mockGetInstallationToken(args),
}))

vi.mock("../src/lib/github", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/github")>("../src/lib/github")
  return {
    ...actual,
    GitHubClient: vi.fn().mockImplementation(() => ({
      listIssueComments: (...args: unknown[]) => mockListIssueComments(...args),
      createIssueComment: (...args: unknown[]) => mockCreateIssueComment(...args),
      updateIssueComment: (...args: unknown[]) => mockUpdateIssueComment(...args),
    })),
  }
})

import {
  postPrOverviewStubIfNeeded,
  STUB_BODY,
  stubFlagKey,
  waitForPrOverviewStub,
} from "../src/lib/pr-overview-stub"
import type { Env } from "../src/index"

function makeKvStub() {
  const store = new Map<string, string>()
  const getMock = vi.fn(async (key: string): Promise<string | null> => store.get(key) ?? null)
  const putMock = vi.fn(async (key: string, value: string): Promise<void> => {
    store.set(key, value)
  })
  const deleteMock = vi.fn(async (key: string): Promise<void> => {
    store.delete(key)
  })
  const kv = {
    get: getMock,
    put: putMock,
    delete: deleteMock,
  } as unknown as Env["OPENCLAW_STATE"]
  return { kv, store, getMock, putMock, deleteMock }
}

function makeEnv(kv: Env["OPENCLAW_STATE"]): Env {
  return {
    OPENCLAW_STATE: kv,
    GITHUB_APP_ID: "12345",
    GITHUB_PRIVATE_KEY: "fake-key",
  } as unknown as Env
}

const args = {
  owner: "acme",
  repo: "site",
  prNumber: 73,
  headSha: "h".repeat(40),
  installationId: 1,
}

beforeEach(() => {
  mockGetInstallationToken.mockClear()
  mockListIssueComments.mockClear()
  mockCreateIssueComment.mockClear()
  mockUpdateIssueComment.mockClear()
  mockListIssueComments.mockResolvedValue([])
  mockCreateIssueComment.mockResolvedValue({ id: 999 })
  mockUpdateIssueComment.mockResolvedValue({})
})

describe("postPrOverviewStubIfNeeded — KV fast path (Codex Q2)", () => {
  it("returns kv-hit when the flag already exists; does NOT post / list", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "555")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "kv-hit", commentId: 555 })
    expect(mockListIssueComments).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).not.toHaveBeenCalled()
  })

  it("falls through when the KV value is malformed (treat as miss)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "not-a-number")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV.get throws (treat as miss); still creates", async () => {
    const { kv, getMock } = makeKvStub()
    getMock.mockRejectedValueOnce(new Error("kv down"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  // ─── Sigilix #3 (PR #104 review): malformed KV value coverage ─────
  // The KV value MUST parse as a positive finite integer to be
  // honored as a "stub already posted" hit. These tests pin the
  // defensive parsing in `postPrOverviewStubIfNeeded`.

  it("falls through when KV returns null (no flag yet); marker-scan then create", async () => {
    const { kv } = makeKvStub() // store is empty → get(...) returns null

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockListIssueComments).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns an empty string (Number('') = 0 → not > 0)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns '0' (a comment id of 0 is not valid)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "0")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns a negative number", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "-12")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("falls through when KV returns Infinity / NaN markers (non-finite)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "Infinity")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("honors a valid stale comment id from KV WITHOUT validating existence (kv-hit is authoritative)", async () => {
    // The helper does NOT round-trip to GitHub to verify the comment
    // still exists — kv-hit is treated as authoritative (the review-
    // side wait only needs to know "a stub WAS posted"). If the
    // comment was deleted, the overview handler downstream will
    // detect that and recreate via its own marker-scan path; the
    // stub-post helper stays cheap.
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "777")

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "kv-hit", commentId: 777 })
    expect(mockListIssueComments).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})

describe("postPrOverviewStubIfNeeded — marker scan fallback (Codex Q2)", () => {
  it("reuses an existing sigilix marker; resets body to placeholder; writes KV flag", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([
      { id: 12345, body: "<!-- sigilix:pr-overview -->\n## Sigilix Overview\nold walkthrough" },
    ])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 12345 })
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![2]).toBe(12345)
    expect(mockUpdateIssueComment.mock.calls[0]![3]).toBe(STUB_BODY)
    expect(store.get(stubFlagKey(args))).toBe("12345")
  })

  it("matches legacy `openclaw:pr-overview` marker (cross-rebrand bilingual)", async () => {
    const { kv } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([
      { id: 4242, body: "<!-- openclaw:pr-overview -->\nlegacy walkthrough" },
    ])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 4242 })
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
  })

  it("still records KV flag if the update call fails (the comment exists; flag tracks 'a stub exists')", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([
      { id: 777, body: "<!-- sigilix:pr-overview -->\nold" },
    ])
    mockUpdateIssueComment.mockRejectedValueOnce(new Error("403 perm denied"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 777 })
    expect(store.get(stubFlagKey(args))).toBe("777")
  })
})

describe("postPrOverviewStubIfNeeded — create path", () => {
  it("creates a new stub comment with STUB_BODY when no marker exists; writes KV flag", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([])

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "posted", commentId: 999 })
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
    expect(mockCreateIssueComment.mock.calls[0]![3]).toBe(STUB_BODY)
    expect(store.get(stubFlagKey(args))).toBe("999")
  })

  it("returns failed when create throws; does NOT write KV flag", async () => {
    const { kv, store } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([])
    mockCreateIssueComment.mockRejectedValueOnce(new Error("5xx"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("failed")
    expect(store.has(stubFlagKey(args))).toBe(false)
  })

  it("STUB_BODY starts with the sigilix-overview marker so the handler edits it in place", () => {
    expect(STUB_BODY.split("\n")[0]).toBe("<!-- sigilix:pr-overview -->")
    expect(STUB_BODY).toContain("_Reviewing…_")
  })

  it("falls back to creating when the marker-scan throws (best-effort)", async () => {
    const { kv } = makeKvStub()
    mockListIssueComments.mockRejectedValueOnce(new Error("503"))

    const out = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("posted")
    expect(mockCreateIssueComment).toHaveBeenCalledOnce()
  })

  it("returns failed when GitHub App env is not configured", async () => {
    const { kv } = makeKvStub()
    const env = { OPENCLAW_STATE: kv } as unknown as Env

    const out = await postPrOverviewStubIfNeeded({ ...args, env })

    expect(out.kind).toBe("failed")
    if (out.kind !== "failed") return
    expect(out.reason).toBe("github-app-not-configured")
    expect(mockCreateIssueComment).not.toHaveBeenCalled()
  })
})

describe("postPrOverviewStubIfNeeded — idempotency across deliveries", () => {
  it("two deliveries for the SAME (prNumber, headSha) produce exactly one comment", async () => {
    const { kv } = makeKvStub()
    mockListIssueComments.mockResolvedValueOnce([])

    const first = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })
    const second = await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    expect(first.kind).toBe("posted")
    expect(second.kind).toBe("kv-hit")
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1)
  })

  it("a NEW headSha hits the marker-scan path and resets the prior stub", async () => {
    const { kv } = makeKvStub()
    // First push: creates comment id 100.
    mockListIssueComments.mockResolvedValueOnce([])
    mockCreateIssueComment.mockResolvedValueOnce({ id: 100 })
    await postPrOverviewStubIfNeeded({ ...args, env: makeEnv(kv) })

    // Second push (new head SHA): KV miss for new key, marker scan
    // finds the prior stub, resets its body to placeholder, writes
    // the new key.
    mockListIssueComments.mockResolvedValueOnce([
      { id: 100, body: "<!-- sigilix:pr-overview -->\nold walkthrough" },
    ])
    const newHeadArgs = { ...args, headSha: "n".repeat(40) }

    const out = await postPrOverviewStubIfNeeded({ ...newHeadArgs, env: makeEnv(kv) })

    expect(out).toEqual({ kind: "marker-scan-hit", commentId: 100 })
    expect(mockCreateIssueComment).toHaveBeenCalledTimes(1) // only the first push
    expect(mockUpdateIssueComment).toHaveBeenCalledOnce()
    expect(mockUpdateIssueComment.mock.calls[0]![3]).toBe(STUB_BODY) // reset to placeholder
  })
})

describe("waitForPrOverviewStub — review-side wait gate (Codex Q1)", () => {
  it("returns stub-present immediately when the KV flag is already set (~0ms)", async () => {
    const { kv, store } = makeKvStub()
    store.set(stubFlagKey(args), "1234")

    const out = await waitForPrOverviewStub({ ...args, env: makeEnv(kv) })

    expect(out.kind).toBe("stub-present")
    expect(out.waitedMs).toBe(0)
  })

  it("returns stub-present when the flag arrives mid-poll (Sigilix #6: injected Map state)", async () => {
    // Sigilix #6 fix (PR #104 review): replace mutable counter with
    // an explicit `Map`-backed KV mock + deterministic `sleep` shim
    // that flips the map between polls. The previous test used a
    // `calls >= 3` counter that coupled the test to the helper's
    // call cadence; this version models the real-world arrival
    // event: "after the second sleep, the stub has been written".
    const { kv, store } = makeKvStub()
    const key = stubFlagKey(args)

    let sleepCalls = 0
    const sleep = vi.fn(async () => {
      sleepCalls += 1
      // After the second sleep, the producer (webhook handler) has
      // written the stub. Mutate the injected state directly — no
      // counters, no off-by-one ambiguity.
      if (sleepCalls === 2) {
        store.set(key, "1234")
      }
    })
    // Monotonic clock: advances by pollMs each call. With pollMs=100
    // and the stub arriving after the 2nd sleep, total waited <= 300ms.
    let clock = 0
    const now = (): number => {
      const t = clock
      clock += 100
      return t
    }

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), now, sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-present")
    if (out.kind === "stub-present") {
      // Bounded — stub arrived in <500ms, well inside the 2s ceiling.
      expect(out.waitedMs).toBeLessThan(500)
    }
    // Producer wrote the value exactly once, on the 2nd sleep.
    expect(store.get(key)).toBe("1234")
  })

  it("returns stub-absent when the wait ceiling elapses with no flag", async () => {
    const { kv } = makeKvStub()
    const sleep = vi.fn(async () => {})
    // First call = startMs (read 1 fast). Subsequent reads loop until now-start >= maxMs.
    const nowSeq = [0, 100, 200, 500, 1_000, 1_500, 2_100]
    let nowIdx = 0
    const now = (): number => nowSeq[Math.min(nowIdx++, nowSeq.length - 1)]!

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), now, sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-absent")
    expect(out.waitedMs).toBeGreaterThanOrEqual(2_000)
  })

  it("returns stub-kv-error when KV throws on the first read; does NOT spin further", async () => {
    const { kv, getMock } = makeKvStub()
    getMock.mockRejectedValueOnce(new Error("kv 5xx"))
    const sleep = vi.fn(async () => {})

    const out = await waitForPrOverviewStub({
      ...args, env: makeEnv(kv), sleep, maxMs: 2_000, pollMs: 100,
    })

    expect(out.kind).toBe("stub-kv-error")
    expect(sleep).not.toHaveBeenCalled()
  })
})
